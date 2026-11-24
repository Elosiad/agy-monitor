---
name: desktop-pet-animator
description: >-
  Generate, slice, assemble, and live-preview custom multi-track Desktop Pet frame animations
  in AGY Console (agy-monitor) using Antigravity's image-generator and the `agy-monitor_desktop_pet_mcp`
  MCP tools. Use when the user asks to draw, generate, animate, or preview a desktop pet or sprite animation.
---

# Desktop Pet AI Frame Animator (`agy-monitor_desktop_pet_mcp`)

This skill connects Antigravity's image generation (`image-generator` subagent) with the
**AGY Console** Desktop Pet Frame Animation Studio via the **`agy-monitor_desktop_pet_mcp`**
MCP server.

## MCP Tool Catalog

| Tool | Purpose |
| :--- | :--- |
| `pet_get_state` | Read current desktop pet settings, active pet, custom animations, and companion status. |
| `pet_slice_sprite_sheet` | Slice a local sprite sheet (`cols x rows`) into transparent PNG frames + checkerboard `contact_sheet.png` for visual inspection. |
| `pet_create_frame_animation` | Create or update a multi-track frame animation (`idle`, `running`, `unread`, `interact`, `walk`, `drag`) from local frame paths and/or sprite sheets with automatic background removal & alignment. Triggers live preview and exports interactive HTML + contact-sheet PNG. |
| `pet_preview_animation` | Switch AGY Console live preview stage to a pet & track (`idle`/`running`/`unread`/`interact`/`walk`/`drag`), pop a preview bubble, and export interactive HTML + contact-sheet PNG. |
| `pet_update_settings` | Toggle desktop pet on/off (`enabled`), switch `active_pet_id`, change `display_mode` (`auto`/`desktop`/`panel`), `size` (`60–500`), `opacity` (`40–100`), `always_on_top`, `show_speech_bubble`, `auto_wander`, or `reset_position`. |
| `pet_delete` | Delete a custom pet and clean up all frame files. |

---

## End-to-End Workflow (Generate -> Slice -> Import -> Live Preview)

### Step 1: Generate Consistent Sprite Sheets with `image-generator`

Delegate image generation to the **`image-generator`** subagent. To make automatic slicing
and transparent cutout crisp and jitter-free, ALWAYS include these constraints in the image brief:

1. **Layout**: Horizontal 4-frame sprite sheet (`4 columns x 1 row`, aspect ratio `16:9` or `2:1` wide strip, or `2x2` grid if square). Four equally spaced cells with NO visible grid borders, NO dividing lines, NO text, and NO labels.
2. **Background**: Solid flat uniform background color with high contrast against the character — e.g. pure solid chroma green (`#00FF00`) for red/warm characters or pure solid magenta (`#FF00FF`) for green/cool characters, completely uniform with **zero ground shadow, zero gradient, zero scenery**.
3. **Character Consistency**: Same character design, same proportion, same camera angle (front-3/4 cute chibi/pixel/anime style), feet/base aligned on the same horizontal baseline across all 4 frames, forming a seamless loop.
4. **Tracks**:
   - **Idle (`idle`)** *(required)*: gentle breathing, blinking, ear twitch, or tail sway (4 frames).
   - **Running (`running`)** *(optional)*: typing fast, casting magic, spinning gears, or thinking intently (4 frames).
   - **Unread (`unread`)** *(optional)*: jumping happily, waving a flag, sparkles celebrating task completion (4 frames).
   - **Interact (`interact`)** *(optional)*: blushing/squishing happily when patted (2–4 frames).
   - **Walk (`walk`)** *(optional)*: cute side-stepping or strolling cycle for autonomous desktop wandering (4 frames).
   - **Drag (`drag`)** *(optional)*: dangling / flailing playfully when picked up and dragged by cursor (2–4 frames).

If the user asks for a quick single-style pet, generating `idle` (required) + `running` (or all 4 tracks) gives the best interactive experience.

### Step 2: Slice & Visually Verify (Recommended)

Call `pet_slice_sprite_sheet` on the generated sprite sheet path (or pass directly to `pet_create_frame_animation`):

- Use `cols: 4, rows: 1` for a 4-frame horizontal strip (or `cols: 2, rows: 2` for a 2×2 grid).
- Use `remove_background: "auto"` (edge flood-fill + anti-aliased edge feathering), or `"chroma"` (with `bg_tolerance: 45–50`) when the character has enclosed transparent holes such as floating halos, rings, or gaps between limbs on a `#00FF00`/`#FF00FF` chroma background.
- Keep `trim_and_align: true` so every frame shares a unified scale and bottom-center anchor.
- Call `read_file` on the returned `contactSheetPath` to verify the cutout is clean and frames are properly centered before finalizing. If the background had slight noise, re-run with higher `bg_tolerance` (e.g. `40`).

### Step 3: Save Frame Animation into AGY Console

Call `pet_create_frame_animation`:

```json
{
  "name": "赛博小柴犬",
  "fps": 6,
  "sprite_sheets": {
    "idle": { "path": "C:/path/to/idle_sheet.png", "cols": 4, "rows": 1, "remove_background": "auto" },
    "running": { "path": "C:/path/to/running_sheet.png", "cols": 4, "rows": 1, "remove_background": "auto" },
    "unread": { "path": "C:/path/to/unread_sheet.png", "cols": 4, "rows": 1, "remove_background": "auto" },
    "interact": { "path": "C:/path/to/interact_sheet.png", "cols": 4, "rows": 1, "remove_background": "auto" }
  },
  "activate": true,
  "enable_pet": true,
  "preview_now": true,
  "preview_track": "idle",
  "generate_preview": true
}
```

- Set `enable_pet: true` only when the user wants to immediately show it live on their desktop/panel; otherwise leave `enable_pet` omitted so it previews safely inside the AGY Console stage first.
- Tip: Typical cute sprite loops look best at `5–8 FPS` for 4 frames, or `8–12 FPS` for 6–8 frames.

### Step 4: Present Live Preview to the User

After `pet_create_frame_animation` or `pet_preview_animation` succeeds:

1. **Always include the one-click sidecar pill** so the user can jump straight to the AGY Console `桌宠` live stage (which auto-switches to the Pet tab and plays the animation):

   ```markdown
   [AGY 控制台](sidecar://agy-monitor/agy_monitor/)
   ```

2. **Share the generated preview files** using clickable `file://` links:
   - `preview.htmlPath` — standalone offline interactive preview player (track switcher, Play/Pause, frame stepper, live FPS & scale sliders, checkerboard/dark/light backgrounds).
   - `preview.contactSheetPath` — frame-by-frame checkerboard contact sheet PNG.
3. Ask the user if they want to tweak the FPS, scale (`60%–500%`), toggle autonomous wandering (`auto_wander`), regenerate any specific track (`running` / `unread` / `interact` / `walk` / `drag`), or toggle the live Windows desktop pet on.
