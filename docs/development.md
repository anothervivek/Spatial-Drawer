# Development

## Prerequisites

```txt
Lens Studio (5.x recommended)
Blender 4.0+
Python 3 (bundled with Blender, but a system install helps for quick syntax checks)
A free Supabase project
```

## Checks

Lens Studio scripts are plain JavaScript (`.js`), not TypeScript — `jsconfig.json` at the project root enables editor-level type hints and autocomplete only, it does not gate builds. The fastest correctness check for `Assets/SpatialDrawer.js` is opening the project in Lens Studio and watching the Logger panel for script errors on load.

For the Blender add-on, run a syntax check before installing:

```bash
python3 -m py_compile blender_plugin/spectacles_bridge.py
```

## Project Boundaries

```txt
Assets/SpatialDrawer.js          all Lens-side gesture, brush, and menu logic
Assets/Spectacles Radial Menu.js  third-party widget — avoid modifying directly, wrap instead
blender_plugin/spectacles_bridge.py  all Blender-side listening, queueing, and curve building
docs/                              user-facing setup, protocol, and architecture docs
```

Keep protocol changes symmetric: a new field or action added in `SpatialDrawer.js`'s `send()` calls needs a matching branch in `spectacles_bridge.py`'s `process_events()`, and both should be reflected in [docs/protocol.md](protocol.md).

Avoid committing generated Lens Studio state:

```txt
Cache/
Workspaces/
PluginsUserPreferences/
Support/
*.lock
```

These are already covered by `.gitignore`.

## Feature Notes

All `bpy` scene mutation in the Blender add-on must happen inside `process_events()`, which runs on Blender's main thread via `bpy.app.timers`. The WebSocket client runs on a background thread (`threading.Thread`) and only ever appends to the plain list `incoming_events` — never call `bpy.*` directly from `on_message` or any WebSocket callback.

The AR preview mesh in the Lens is purely cosmetic and locally computed; it is never derived from anything Blender sends back, since Blender never sends anything back. If you need Blender-side state to reflect in AR (e.g., confirming an export succeeded), that has to be a separate, new channel or a polling mechanism — the current protocol is one-way by design.

Brush-specific mesh state (`tubeTrailData`, `polyAnchorPoints`, `ribbonVertCount`, etc.) is intentionally kept as loose module-level variables rather than a single brush-state object. When adding a new brush, follow the existing pattern: its own state variables, its own branch in `onDrawHandPinchDown` / `onUpdate`, and reset it explicitly in the `Clear All` handler.
