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
});
