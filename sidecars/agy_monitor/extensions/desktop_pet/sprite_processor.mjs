/**
 * Zero-dependency sprite sheet slicer, PNG codec, background remover, and contact-sheet builder
 * for the Desktop Pet extension.
 *
 * - Pure Node.js (`node:zlib`) 8-bit PNG decoder (grayscale / RGB / palette+tRNS / GA / RGBA) & encoder.
 * - Automatic Windows `.NET System.Drawing` conversion fallback for JPEG/WEBP/GIF inputs.
 * - Edge flood-fill background removal with soft alpha feathering & color spill cleanup,
 *   plus unified bottom-centered frame alignment so AI-generated sprite sheets animate smoothly.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectRasterMagic } from './pet_storage.mjs';

const execFileAsync = promisify(execFile);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard IEEE 802.3 CRC32 table for PNG chunks
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a standard non-interlaced 8-bit PNG buffer into { width, height, data: Uint8Array(RGBA) }.
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buffer.length) break;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }
  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth} (expected 8-bit)`);
  }
  if (interlace !== 0) {
    throw new Error('Interlaced Adam7 PNG is not supported directly');
  }

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = channelsByType[colorType];
  if (!bpp) {
    throw new Error(`Unsupported PNG color type: ${colorType}`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const expectedMin = height * (stride + 1);
  if (inflated.length < expectedMin) {
    throw new Error('Truncated PNG IDAT stream');
  }

  const raw = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    const srcRowStart = y * (stride + 1) + 1;
    const dstRowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const val = inflated[srcRowStart + x];
      const a = x >= bpp ? raw[dstRowStart + x - bpp] : 0;
      const b = y > 0 ? raw[prevRowStart + x] : 0;
      const c = x >= bpp && y > 0 ? raw[prevRowStart + x - bpp] : 0;
      let out = val;
      if (filter === 1) out = (val + a) & 0xff;
      else if (filter === 2) out = (val + b) & 0xff;
      else if (filter === 3) out = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) out = (val + paethPredictor(a, b, c)) & 0xff;
      raw[dstRowStart + x] = out;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  if (colorType === 6) {
    rgba.set(raw);
  } else if (colorType === 2) {
    const keyR = trns && trns.length >= 6 ? trns.readUInt16BE(0) & 0xff : -1;
    const keyG = trns && trns.length >= 6 ? trns.readUInt16BE(2) & 0xff : -1;
    const keyB = trns && trns.length >= 6 ? trns.readUInt16BE(4) & 0xff : -1;
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
      const r = raw[i];
      const g = raw[i + 1];
      const b = raw[i + 2];
      rgba[j] = r;
      rgba[j + 1] = g;
      rgba[j + 2] = b;
      rgba[j + 3] = keyR >= 0 && r === keyR && g === keyG && b === keyB ? 0 : 255;
    }
  } else if (colorType === 0) {
    const keyGray = trns && trns.length >= 2 ? trns.readUInt16BE(0) & 0xff : -1;
    for (let i = 0, j = 0; i < raw.length; i += 1, j += 4) {
      const v = raw[i];
      rgba[j] = v;
      rgba[j + 1] = v;
      rgba[j + 2] = v;
      rgba[j + 3] = keyGray >= 0 && v === keyGray ? 0 : 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, j = 0; i < raw.length; i += 2, j += 4) {
      const v = raw[i];
      rgba[j] = v;
      rgba[j + 1] = v;
      rgba[j + 2] = v;
      rgba[j + 3] = raw[i + 1];
    }
  } else if (colorType === 3) {
    if (!palette) throw new Error('Indexed PNG missing PLTE chunk');
    for (let i = 0, j = 0; i < raw.length; i += 1, j += 4) {
      const idx = raw[i];
      rgba[j] = palette[idx * 3] ?? 0;
      rgba[j + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[j + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[j + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }

  return { width, height, data: rgba };
}

/**
 * Encode RGBA pixel buffer into a standard 8-bit RGBA PNG Buffer.
 */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter None
    const srcOff = y * stride;
    raw.set(rgba.subarray(srcOff, srcOff + stride), y * (stride + 1) + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIG,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function convertNonPngToPngBuffer(inputBuf, extHint = '.img') {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-pet-conv-'));
  const inFile = path.join(tmpDir, `in${extHint}`);
  const outFile = path.join(tmpDir, 'out.png');
  try {
    await fs.writeFile(inFile, inputBuf);
    if (process.platform === 'win32') {
      const psScript = [
        'Add-Type -AssemblyName System.Drawing;',
        '$src = [System.Drawing.Image]::FromFile($env:AGY_CONV_IN);',
        '$bmp = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb);',
        '$g = [System.Drawing.Graphics]::FromImage($bmp);',
        '$g.DrawImage($src, 0, 0, $src.Width, $src.Height);',
        '$g.Dispose(); $src.Dispose();',
        '$bmp.Save($env:AGY_CONV_OUT, [System.Drawing.Imaging.ImageFormat]::Png);',
        '$bmp.Dispose();',
      ].join(' ');
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        {
          timeout: 15000,
          windowsHide: true,
          env: { ...process.env, AGY_CONV_IN: inFile, AGY_CONV_OUT: outFile },
        },
      );
      return await fs.readFile(outFile);
    }
    // Cross-platform fallback via Python PIL if installed
    await execFileAsync(
      'python3',
      [
        '-c',
        'import os; from PIL import Image; Image.open(os.environ["AGY_CONV_IN"]).convert("RGBA").save(os.environ["AGY_CONV_OUT"], "PNG")',
      ],
      {
        timeout: 15000,
        env: { ...process.env, AGY_CONV_IN: inFile, AGY_CONV_OUT: outFile },
      },
    );
    return await fs.readFile(outFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Decode PNG/JPEG/WEBP/GIF buffer into RGBA { width, height, data }.
 */
export async function decodeRasterToRgba(buffer) {
  const magic = detectRasterMagic(buffer);
  if (!magic) {
    throw Object.assign(new Error('文件头校验失败：仅支持真实 PNG、JPEG、WEBP 或 GIF 位图'), {
      code: 'INVALID_IMAGE_MAGIC',
    });
  }
  if (magic === 'image/png') {
    try {
      return decodePng(buffer);
    } catch {
      // Fallback for interlaced or 16-bit PNGs
      const converted = await convertNonPngToPngBuffer(buffer, '.png');
      return decodePng(converted);
    }
  }
  const extMap = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const pngBuf = await convertNonPngToPngBuffer(buffer, extMap[magic] || '.img');
  return decodePng(pngBuf);
}

function cropRgba(src, srcW, x0, y0, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcOff = ((y0 + y) * srcW + x0) * 4;
    const dstOff = y * w * 4;
    out.set(src.subarray(srcOff, srcOff + w * 4), dstOff);
  }
  return out;
}

function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function detectBorderBackgroundColor(rgba, w, h) {
  let transparentBorder = 0;
  let totalBorder = 0;
  const samples = [];

  const pushSample = (x, y) => {
    totalBorder += 1;
    const o = (y * w + x) * 4;
    if (rgba[o + 3] < 24) {
      transparentBorder += 1;
      return;
    }
    samples.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
  };

  const stepX = Math.max(1, Math.floor(w / 24));
  const stepY = Math.max(1, Math.floor(h / 24));
  for (let x = 0; x < w; x += stepX) {
    pushSample(x, 0);
    if (h > 1) pushSample(x, h - 1);
  }
  for (let y = 1; y < h - 1; y += stepY) {
    pushSample(0, y);
    if (w > 1) pushSample(w - 1, y);
  }

  // Already has transparent background
  if (totalBorder > 0 && transparentBorder / totalBorder >= 0.15) {
    return { alreadyTransparent: true, r: 0, g: 0, b: 0 };
  }
  if (samples.length === 0) {
    return { alreadyTransparent: true, r: 0, g: 0, b: 0 };
  }

  // Quantize border samples into 16-unit buckets to find dominant background color
  const buckets = new Map();
  let bestKey = '';
  let bestCount = 0;
  for (const [r, g, b] of samples) {
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { count: 0, sr: 0, sg: 0, sb: 0 };
      buckets.set(key, entry);
    }
    entry.count += 1;
    entry.sr += r;
    entry.sg += g;
    entry.sb += b;
    if (entry.count > bestCount) {
      bestCount = entry.count;
      bestKey = key;
    }
  }

  const best = buckets.get(bestKey);
  return {
    alreadyTransparent: false,
    r: Math.round(best.sr / best.count),
    g: Math.round(best.sg / best.count),
    b: Math.round(best.sb / best.count),
    coverage: best.count / samples.length,
  };
}

/**
 * Remove uniform or chroma background from an RGBA image cell.
 * - `mode`: 'auto' (edge BFS flood-fill + anti-aliased edge feathering), 'chroma' (global), or 'none'.
 */
export function removeCellBackground(rgba, w, h, { mode = 'auto', tolerance = 28 } = {}) {
  const out = new Uint8Array(rgba);
  if (mode === 'none' || w <= 2 || h <= 2) return out;

  const bg = detectBorderBackgroundColor(out, w, h);
  if (bg.alreadyTransparent) return out;

  const tol = Math.max(4, Math.min(100, Number(tolerance) || 28));
  const hardDist = tol * 1.75;
  const softDist = hardDist * 1.7;

  if (mode === 'chroma') {
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 4;
      if (out[o + 3] === 0) continue;
      const d = colorDist(out[o], out[o + 1], out[o + 2], bg.r, bg.g, bg.b);
      if (d <= hardDist) {
        out[o + 3] = 0;
      } else if (d < softDist) {
        const t = (d - hardDist) / (softDist - hardDist);
        out[o + 3] = Math.round(out[o + 3] * t);
      }
    }
    return out;
  }

  // 'auto': edge BFS flood-fill from border pixels so interior highlights matching bg color stay intact
  const total = w * h;
  const visited = new Uint8Array(total);
  const removed = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  const trySeed = (x, y) => {
    const idx = y * w + x;
    if (visited[idx]) return;
    const o = idx * 4;
    if (out[o + 3] < 16 || colorDist(out[o], out[o + 1], out[o + 2], bg.r, bg.g, bg.b) <= hardDist) {
      visited[idx] = 1;
      removed[idx] = 1;
      queue[qTail++] = idx;
    }
  };

  for (let x = 0; x < w; x += 1) {
    trySeed(x, 0);
    trySeed(x, h - 1);
  }
  for (let y = 1; y < h - 1; y += 1) {
    trySeed(0, y);
    trySeed(w - 1, y);
  }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % w;
    const y = (idx - x) / w;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x + 1 < w ? idx + 1 : -1,
      y > 0 ? idx - w : -1,
      y + 1 < h ? idx + w : -1,
    ];
    for (const nIdx of neighbors) {
      if (nIdx < 0 || visited[nIdx]) continue;
      visited[nIdx] = 1;
      const o = nIdx * 4;
      const d = colorDist(out[o], out[o + 1], out[o + 2], bg.r, bg.g, bg.b);
      if (out[o + 3] < 16 || d <= hardDist) {
        removed[nIdx] = 1;
        queue[qTail++] = nIdx;
      }
    }
  }

  // Apply removal & soft 1px edge feathering
  for (let idx = 0; idx < total; idx += 1) {
    if (removed[idx]) {
      out[idx * 4 + 3] = 0;
      continue;
    }
    const x = idx % w;
    const y = (idx - x) / w;
    const touchesRemoved =
      (x > 0 && removed[idx - 1]) ||
      (x + 1 < w && removed[idx + 1]) ||
      (y > 0 && removed[idx - w]) ||
      (y + 1 < h && removed[idx + w]);
    if (!touchesRemoved) continue;
    const o = idx * 4;
    const d = colorDist(out[o], out[o + 1], out[o + 2], bg.r, bg.g, bg.b);
    if (d < softDist) {
      const alphaFactor = Math.max(0.15, (d - hardDist) / Math.max(1, softDist - hardDist));
      out[o + 3] = Math.round(out[o + 3] * alphaFactor);
    }
  }

  return out;
}

function findAlphaBounds(rgba, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rgba[(y * w + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { empty: true, x: 0, y: 0, w, h };
  }
  return { empty: false, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function resizeRgbaBilinear(src, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return new Uint8Array(src);
  const out = new Uint8Array(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy += 1) {
    const sy = (dy + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sy - y0));

    for (let dx = 0; dx < dstW; dx += 1) {
      const sx = (dx + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sx - x0));

      const o00 = (y0 * srcW + x0) * 4;
      const o10 = (y0 * srcW + x1) * 4;
      const o01 = (y1 * srcW + x0) * 4;
      const o11 = (y1 * srcW + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      // Premultiplied alpha interpolation prevents dark fringes around transparent edges
      const a00 = src[o00 + 3] / 255;
      const a10 = src[o10 + 3] / 255;
      const a01 = src[o01 + 3] / 255;
      const a11 = src[o11 + 3] / 255;

      const outA = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      const dstOff = (dy * dstW + dx) * 4;
      if (outA <= 0.001) {
        out[dstOff + 3] = 0;
        continue;
      }
      const r = (src[o00] * a00 * w00 + src[o10] * a10 * w10 + src[o01] * a01 * w01 + src[o11] * a11 * w11) / outA;
      const g =
        (src[o00 + 1] * a00 * w00 + src[o10 + 1] * a10 * w10 + src[o01 + 1] * a01 * w01 + src[o11 + 1] * a11 * w11) /
        outA;
      const b =
        (src[o00 + 2] * a00 * w00 + src[o10 + 2] * a10 * w10 + src[o01 + 2] * a01 * w01 + src[o11 + 2] * a11 * w11) /
        outA;

      out[dstOff] = Math.max(0, Math.min(255, Math.round(r)));
      out[dstOff + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[dstOff + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[dstOff + 3] = Math.max(0, Math.min(255, Math.round(outA * 255)));
    }
  }
  return out;
}

function placeAlignedOnSquareCanvas(rgba, w, h, bounds, targetSize, sharedScale) {
  const canvas = new Uint8Array(targetSize * targetSize * 4);
  if (bounds.empty) return canvas;

  const cropped = cropRgba(rgba, w, bounds.x, bounds.y, bounds.w, bounds.h);
  const drawW = Math.max(1, Math.min(targetSize, Math.round(bounds.w * sharedScale)));
  const drawH = Math.max(1, Math.min(targetSize, Math.round(bounds.h * sharedScale)));
  const resized = resizeRgbaBilinear(cropped, bounds.w, bounds.h, drawW, drawH);

  const offsetX = Math.floor((targetSize - drawW) / 2);
  const bottomMargin = Math.max(2, Math.round(targetSize * 0.05));
  const offsetY = Math.max(0, targetSize - drawH - bottomMargin);

  for (let y = 0; y < drawH; y += 1) {
    const ty = offsetY + y;
    if (ty < 0 || ty >= targetSize) continue;
    const srcOff = y * drawW * 4;
    const dstOff = (ty * targetSize + offsetX) * 4;
    canvas.set(resized.subarray(srcOff, srcOff + drawW * 4), dstOff);
  }
  return canvas;
}

/**
 * Process a single frame image buffer (optional background removal & resize/align) -> PNG buffer.
 */
export async function processSingleFrameBuffer(
  inputBuf,
  { removeBackground = 'none', bgTolerance = 28, trimAndAlign = false, maxSize = 256 } = {},
) {
  const decoded = await decodeRasterToRgba(inputBuf);
  const targetSize = Math.max(48, Math.min(512, Math.round(Number(maxSize) || 256)));
  const bgMode = removeBackground === 'chroma' || removeBackground === 'auto' ? removeBackground : 'none';

  // Fast path: untouched PNG/GIF/WEBP/JPEG when no background removal or resizing needed
  if (bgMode === 'none' && !trimAndAlign && decoded.width <= targetSize && decoded.height <= targetSize) {
    const magic = detectRasterMagic(inputBuf);
    if (magic === 'image/png') {
      return {
        pngBuffer: inputBuf,
        width: decoded.width,
        height: decoded.height,
        rgba: decoded.data,
      };
    }
  }

  let data = removeCellBackground(decoded.data, decoded.width, decoded.height, {
    mode: bgMode,
    tolerance: bgTolerance,
  });

  if (trimAndAlign) {
    const bounds = findAlphaBounds(data, decoded.width, decoded.height);
    const usable = Math.round(targetSize * 0.9);
    const scale = bounds.empty ? 1 : Math.min(usable / Math.max(1, bounds.w), usable / Math.max(1, bounds.h));
    const aligned = placeAlignedOnSquareCanvas(data, decoded.width, decoded.height, bounds, targetSize, scale);
    return {
      pngBuffer: encodePng(targetSize, targetSize, aligned),
      width: targetSize,
      height: targetSize,
      rgba: aligned,
    };
  }

  let outW = decoded.width;
  let outH = decoded.height;
  if (outW > targetSize || outH > targetSize) {
    const scale = Math.min(targetSize / outW, targetSize / outH);
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));
    data = resizeRgbaBilinear(data, decoded.width, decoded.height, outW, outH);
  }
  return {
    pngBuffer: encodePng(outW, outH, data),
    width: outW,
    height: outH,
    rgba: data,
  };
}

/**
 * Slice a horizontal or grid (cols x rows) sprite sheet buffer into clean transparent PNG frames.
 */
export async function sliceSpriteSheetBuffer(
  inputBuf,
  {
    cols = 4,
    rows = 1,
    frameCount = null,
    removeBackground = 'auto',
    bgTolerance = 28,
    trimAndAlign = true,
    maxSize = 256,
  } = {},
) {
  const safeCols = Math.max(1, Math.min(32, Math.round(Number(cols) || 4)));
  const safeRows = Math.max(1, Math.min(16, Math.round(Number(rows) || 1)));
  const maxFrames = Math.min(48, safeCols * safeRows);
  const count = frameCount
    ? Math.max(1, Math.min(maxFrames, Math.round(Number(frameCount))))
    : maxFrames;
  const targetSize = Math.max(48, Math.min(512, Math.round(Number(maxSize) || 256)));
  const bgMode =
    removeBackground === 'none' || removeBackground === 'chroma' ? removeBackground : 'auto';

  const decoded = await decodeRasterToRgba(inputBuf);
  const cellW = Math.floor(decoded.width / safeCols);
  const cellH = Math.floor(decoded.height / safeRows);
  if (cellW < 4 || cellH < 4) {
    throw Object.assign(
      new Error(`精灵表尺寸 (${decoded.width}x${decoded.height}) 过小，无法按 ${safeCols}x${safeRows} 切分`),
      { code: 'EMPTY_PAYLOAD' },
    );
  }

  const cells = [];
  for (let idx = 0; idx < count; idx += 1) {
    const r = Math.floor(idx / safeCols);
    const c = idx % safeCols;
    const rawCell = cropRgba(decoded.data, decoded.width, c * cellW, r * cellH, cellW, cellH);
    const cleaned = removeCellBackground(rawCell, cellW, cellH, {
      mode: bgMode,
      tolerance: bgTolerance,
    });
    const bounds = findAlphaBounds(cleaned, cellW, cellH);
    cells.push({ rgba: cleaned, w: cellW, h: cellH, bounds });
  }

  const nonEmptyCells = cells.filter((c) => !c.bounds.empty);
  const activeCells = nonEmptyCells.length > 0 ? nonEmptyCells : cells;

  let sharedScale = 1;
  if (trimAndAlign) {
    let maxBoundW = 1;
    let maxBoundH = 1;
    for (const cell of activeCells) {
      if (!cell.bounds.empty) {
        if (cell.bounds.w > maxBoundW) maxBoundW = cell.bounds.w;
        if (cell.bounds.h > maxBoundH) maxBoundH = cell.bounds.h;
      }
    }
    const usable = Math.round(targetSize * 0.9);
    sharedScale = Math.min(usable / maxBoundW, usable / maxBoundH);
  }

  const frames = [];
  for (let i = 0; i < activeCells.length; i += 1) {
    const cell = activeCells[i];
    let finalRgba;
    let outW;
    let outH;
    if (trimAndAlign) {
      outW = targetSize;
      outH = targetSize;
      finalRgba = placeAlignedOnSquareCanvas(cell.rgba, cell.w, cell.h, cell.bounds, targetSize, sharedScale);
    } else {
      const scale = Math.min(1, targetSize / Math.max(cell.w, cell.h));
      outW = Math.max(1, Math.round(cell.w * scale));
      outH = Math.max(1, Math.round(cell.h * scale));
      finalRgba = resizeRgbaBilinear(cell.rgba, cell.w, cell.h, outW, outH);
    }
    frames.push({
      index: i,
      width: outW,
      height: outH,
      rgba: finalRgba,
      pngBuffer: encodePng(outW, outH, finalRgba),
      mime: 'image/png',
    });
  }

  return {
    sourceWidth: decoded.width,
    sourceHeight: decoded.height,
    cols: safeCols,
    rows: safeRows,
    frames,
  };
}

/**
 * Build a checkerboard-backed contact sheet PNG of RGBA frames for quick visual inspection.
 */
export function buildContactSheetPng(frames, { thumbSize = 128, columns = 6, padding = 8 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const cols = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const cell = Math.max(48, Math.min(256, Math.round(thumbSize)));
  const pad = Math.max(4, Math.round(padding));
  const outW = cols * cell + (cols + 1) * pad;
  const outH = rows * cell + (rows + 1) * pad;
  const out = new Uint8Array(outW * outH * 4);

  // Dark slate outer frame
  for (let i = 0; i < outW * outH; i += 1) {
    const o = i * 4;
    out[o] = 24;
    out[o + 1] = 27;
    out[o + 2] = 36;
    out[o + 3] = 255;
  }

  for (let idx = 0; idx < frames.length; idx += 1) {
    const fr = frames[idx];
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const x0 = pad + c * (cell + pad);
    const y0 = pad + r * (cell + pad);

    // Checkerboard inside each cell to reveal transparency clearly
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        const light = (((x >> 3) + (y >> 3)) & 1) === 0;
        const v = light ? 52 : 38;
        const o = ((y0 + y) * outW + (x0 + x)) * 4;
        out[o] = v;
        out[o + 1] = v + 3;
        out[o + 2] = v + 10;
        out[o + 3] = 255;
      }
    }

    const scale = Math.min(cell / Math.max(1, fr.width), cell / Math.max(1, fr.height));
    const dw = Math.max(1, Math.round(fr.width * scale));
    const dh = Math.max(1, Math.round(fr.height * scale));
    const resized = resizeRgbaBilinear(fr.rgba, fr.width, fr.height, dw, dh);
    const dx0 = x0 + Math.floor((cell - dw) / 2);
    const dy0 = y0 + Math.floor((cell - dh) / 2);

    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const so = (y * dw + x) * 4;
        const sa = resized[so + 3] / 255;
        if (sa <= 0) continue;
        const doff = ((dy0 + y) * outW + (dx0 + x)) * 4;
        out[doff] = Math.round(resized[so] * sa + out[doff] * (1 - sa));
        out[doff + 1] = Math.round(resized[so + 1] * sa + out[doff + 1] * (1 - sa));
        out[doff + 2] = Math.round(resized[so + 2] * sa + out[doff + 2] * (1 - sa));
        out[doff + 3] = 255;
      }
    }
  }

  return encodePng(outW, outH, out);
}
