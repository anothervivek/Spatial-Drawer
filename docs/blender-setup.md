# Blender Setup

## Install the Add-on

```txt
Edit > Preferences > Add-ons > Install...
select blender_plugin/spectacles_bridge.py
enable the checkbox next to "Spatial Drawer — Spectacles Bridge"
```

Blender 4.0+ is required (`bl_info["blender"] = (4, 0, 0)`). The panel appears under **3D Viewport > Sidebar (N panel) > Spectacles**.

## Install the WebSocket Dependency

The add-on depends on `websocket-client`, which is not bundled with Blender's Python. On first run the panel only shows one button:

```txt
Install WebSocket Library
```

Click it, then restart Blender. This runs:

```txt
{blender_python} -m pip install websocket-client
```

If the install fails with a permissions error, close Blender and reopen it with elevated permissions once (Administrator on Windows, `sudo` from a terminal on macOS/Linux), click the button again, then go back to running Blender normally — you do not need elevated permissions after the package is installed.

## Connection Fields

```txt
URL       Supabase Project URL, e.g. https://xxxxx.supabase.co
Token     Supabase anon public key
Channel   Realtime channel name, default "spatial-drawer" — must match the Lens
```

Click **Start Listening**. The panel label switches to a connected state once the WebSocket opens and the Realtime channel join succeeds. Click **Stop** to disconnect; this also unregisters the internal event-processing timer.

## Brush Fields

```txt
Scale               drawing size multiplier, default 10.0 — Lens Studio units are small; this scales them into a usable Blender scene size
Thickness            curve bevel depth, default 3.0 — independent of the Lens-side brush size presets
Dynamic Thickness     when enabled, faster hand movement produces thinner curve segments
Color                 base color for new curves from the local (non-multiplayer) user; overridden by set-color broadcasts
```

## Modifier Fields

```txt
Mirror X    adds a Mirror modifier across the X axis to every new curve object
Auto-Smooth  adds a Subdivision Surface modifier (levels=1, render_levels=2) to every new curve object
```

Both are applied at curve creation time — toggling them mid-session only affects strokes drawn afterward.

## Multiplayer Panel

Once at least one remote `userId` has sent an event, a **Users Online** box appears listing each `userId` and its assigned color. Colors are assigned in order of first appearance from a fixed 6-color palette and cycle if more than 6 users connect. **Clear Offline Users** resets this list without affecting drawn curves — use it between test sessions so stale user entries don't linger.

## Export

Triggered remotely by the **Export** radial menu button on Spectacles — there is no local Blender button for this. When triggered:

1. every curve in the registry is duplicated, converted to mesh, and joined into one object
2. the joined object is exported as FBX to `~/Desktop/SpatialDrawing_<unix-timestamp>.fbx`
3. the duplicate is deleted, leaving the original curves untouched in the scene
4. the panel's status line shows the saved filename, or `Export Failed!` if the FBX exporter raised an exception

## Troubleshooting

If Blender reports `websocket-client` missing even after clicking **Install WebSocket Library**:

```txt
find Blender's bundled Python executable
run: {that python} -m pip install websocket-client
restart Blender
```

If strokes never appear after **Start Listening**:

- confirm the channel name matches exactly on both sides — it is case-sensitive
- confirm the Supabase anon key was copied from **Project Settings > API**, not a service-role key
- check Blender's system console for `[Spectacles] WebSocket error:` lines

If curves appear in the wrong place or scale, check the **Scale** field first — Lens Studio positions are in centimeters and need a multiplier to be usable in a typical Blender scene.
