import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKDROP_CS = path.resolve(__dirname, '..', 'sidecars', 'agy_monitor', 'backdrop', 'AgyBackdrop.cs');

test('AgyBackdrop.cs prevents re-entrant orphaned HUD/Backdrop windows', () => {
  const src = fs.readFileSync(BACKDROP_CS, 'utf8');

  // 1. SyncHudForWindow must assign item.Hud BEFORE calling hud.Show()
  const syncHudStart = src.indexOf('private void SyncHudForWindow(');
  assert.ok(syncHudStart > 0, 'SyncHudForWindow method missing');
  const hudBlockStart = src.indexOf('if (item.Hud == null)', syncHudStart);
  assert.ok(hudBlockStart > syncHudStart, 'SyncHudForWindow HUD creation block missing');
  const hudBlock = src.slice(hudBlockStart, hudBlockStart + 1200);
  const assignIdx = hudBlock.indexOf('item.Hud = hud;');
  const showIdx = hudBlock.indexOf('hud.Show();');
  assert.ok(assignIdx > 0 && showIdx > 0, 'item.Hud assignment or hud.Show() missing');
  assert.ok(assignIdx < showIdx, 'item.Hud must be assigned before hud.Show() to prevent re-entrant ghost HUDs');

  // 2. Re-entrancy guard around SyncAllWindows and OnWinEvent
  assert.match(src, /private\s+bool\s+_inSync\s*=\s*false;/, '_inSync guard missing');
  assert.match(src, /if\s*\(_inSync\)\s*\{\s*_syncPending\s*=\s*true;\s*return;\s*\}/s, 'SyncAllWindows must defer re-entrant calls');
  assert.match(src, /EVENT_OBJECT_LOCATIONCHANGE\s*&&\s*isTracked\s*&&\s*!_inSync/, 'OnWinEvent must skip synchronous SyncAllWindows during _inSync');

  // 3. Guaranteed force-hide/close and Application.Current.Windows orphan sweeper
  assert.match(src, /private\s+static\s+void\s+ForceCloseOwnedWindow\s*\(\s*Window\s+win\s*\)/, 'ForceCloseOwnedWindow helper missing');
  assert.match(src, /private\s+void\s+SweepOrphanedWindows\s*\(\s*\)/, 'SweepOrphanedWindows safety net missing');
  assert.match(src, /SweepOrphanedWindows\(\);/, 'SweepOrphanedWindows must be invoked');

  // 4. Minimized (iconic) Antigravity windows remain tracked so minimize/restore never thrashes overlays
  assert.match(src, /if\s*\(!Native\.IsIconic\(hWnd\)\)/, 'FindAntigravityTopWindows must keep iconic windows tracked');

  // 5. Z-order occlusion walk covers deep Windows desktop stacks (>= 128 steps)
  const zMatch = src.match(/while\s*\(prev\s*!=\s*IntPtr\.Zero\s*&&\s*steps\s*<\s*(\d+)\)/);
  assert.ok(zMatch && Number(zMatch[1]) >= 128, 'Z-order occlusion walk must inspect at least 128 top-level windows');

  // 6. Native 100%-opaque WPF ImageLightboxWindow guards (non-locking load, advertised support, orphan sweep & dispose cleanup)
  assert.match(src, /internal\s+sealed\s+class\s+ImageLightboxWindow\s*:\s*Window/, 'ImageLightboxWindow class missing');
  assert.match(src, /"supportsLightbox"\s*,\s*true/, 'WriteStatusFile must advertise supportsLightbox=true');
  assert.match(src, /IsTargetFile\(name,\s*"lightbox_cmd\.json"\)/, 'FileSystemWatcher must react to lightbox_cmd.json');
  assert.match(src, /w\s+is\s+ImageLightboxWindow/, 'SweepOrphanedWindows must sweep orphaned ImageLightboxWindow instances');
  const openLbIdx = src.indexOf('private void OpenNativeLightbox(');
  assert.ok(openLbIdx > 0, 'OpenNativeLightbox method missing');
  const lbBlock = src.slice(openLbIdx, openLbIdx + 2800);
  const lbAssign = lbBlock.indexOf('_lightbox = win;');
  const lbShow = lbBlock.indexOf('win.Show();');
  assert.ok(lbAssign > 0 && lbShow > 0 && lbAssign < lbShow, '_lightbox must be bound before win.Show()');

  // 7. v1.0.5 companion resource safety, mixed-DPI lightbox & comma-safe Explorer selection
  assert.match(src, /SHOpenFolderAndSelectItems/, 'OpenTargetFolder should use SHOpenFolderAndSelectItems');
  assert.match(src, /using\s*\(\s*Process\s+/, 'Process instances must be disposed with using');
  assert.match(src, /private\s+volatile\s+bool\s+_disposed\s*=\s*false;/, '_disposed must be volatile across threads');
  const lbClassStart = src.indexOf('internal sealed class ImageLightboxWindow');
  const hudClassStart = src.indexOf('internal sealed class HudOverlayWindow');
  assert.ok(lbClassStart > 0 && hudClassStart > lbClassStart);
  const lbClassSrc = src.slice(lbClassStart, hudClassStart);
  assert.match(lbClassSrc, /TransformToDevice/, 'ImageLightboxWindow must compensate mixed-DPI via TransformToDevice');

  // 8. v1.0.6 GPU hardware-accelerated backdrop, atomic DeferWindowPos, VSync render-follow & progress-tag header filter
  const bdStart = src.indexOf('internal sealed class BackdropSurfaceWindow');
  assert.ok(bdStart > 0 && lbClassStart > bdStart);
  const bdSrc = src.slice(bdStart, lbClassStart);
  assert.match(bdSrc, /AllowsTransparency\s*=\s*false;/, 'BackdropSurfaceWindow must use hardware-accelerated AllowsTransparency=false');
  assert.match(bdSrc, /DwmSetWindowAttribute/, 'BackdropSurfaceWindow must apply native DWM rounded corners');
  assert.doesNotMatch(bdSrc, /Native\.WS_EX_TRANSPARENT/, 'Non-layered BackdropSurfaceWindow must NOT set GDI WS_EX_TRANSPARENT');
  assert.match(bdSrc, /0x0084/, 'BackdropSurfaceWindow must handle WM_NCHITTEST for click-through');
  assert.match(bdSrc, /0x0021/, 'BackdropSurfaceWindow must handle WM_MOUSEACTIVATE to never steal focus');
  assert.match(src, /BeginDeferWindowPos/, 'SyncAllWindows must batch window updates via DeferWindowPos');
  assert.match(src, /CommitPendingMoves\s*\(\s*backdropMoves\s*\)/, 'SyncAllWindows must commit backdropMoves separately');
  assert.match(src, /CommitPendingMoves\s*\(\s*hudMoves\s*\)/, 'SyncAllWindows must commit hudMoves separately');
  const syncAllIdx = src.indexOf('private void SyncAllWindows(');
  const commitBdIdx = src.indexOf('CommitPendingMoves(backdropMoves);', syncAllIdx);
  const applyAlphaIdx = src.indexOf('SetLayeredWindowAttributes(item.Hwnd, 0, targetAlpha', syncAllIdx);
  assert.ok(commitBdIdx > syncAllIdx && applyAlphaIdx > commitBdIdx, 'Backdrop must be positioned BEFORE making host window translucent');
  assert.match(src, /CompositionTarget\.Rendering\s*\+=\s*OnCompositionRendering/, 'Companion must VSync-track window moves/resizes');
  assert.match(src, /EVENT_OBJECT_REORDER/, 'Companion must hook EVENT_OBJECT_REORDER for instant Z-order sync');
  assert.match(src, /\[AGY_PROGRESS/, 'IsHeaderChromeText must reject [AGY_PROGRESS...] chat lines as titles');
  assert.match(src, /IsNewConversationTitle/, 'ProbeActiveConversationView must detect blank New Conversation headers');

  // 9. Constructor null-safety & global unhandled-exception host-opacity safety net
  const applyDipIdx = src.indexOf('private void ApplyAvailableDipLayout()');
  assert.ok(applyDipIdx > 0, 'ApplyAvailableDipLayout missing');
  const applyDipSnippet = src.slice(applyDipIdx, applyDipIdx + 240);
  assert.match(applyDipSnippet, /if\s*\(_metaPill\s*==\s*null\s*\|\|\s*_modelText\s*==\s*null\)\s*return;/, 'ApplyAvailableDipLayout must guard against pre-init null controls');
  assert.match(src, /DispatcherUnhandledException/, 'Program.Main must hook DispatcherUnhandledException');
  assert.match(src, /AppDomain\.CurrentDomain\.UnhandledException/, 'Program.Main must hook AppDomain.CurrentDomain.UnhandledException');
  assert.match(src, /RestoreAllHostOpacityEmergency/, 'CompanionController must provide pure-Win32 emergency host opacity restore');
});
