# Protocol

Spatial Drawer sends a single JSON message type — `draw-event` — as a Supabase Realtime broadcast. There is no reply channel: Blender only ever receives, the Lens only ever sends.

## Broadcast Envelope

Every message is wrapped by the Supabase client like this:

```json
{
  "type": "broadcast",
  "event": "draw-event",
  "payload": { "...": "see below" }
}
```

Blender's `on_message` handler unwraps this and pushes `payload` onto its event queue.

## Base Payload

Every `draw-event` payload carries these fields, regardless of action:

```json
{
  "action": "move",
  "x": 12.4,
  "y": 5.1,
  "z": -3.2,
  "userId": "user_ab12cd",
  "brushMode": "tube",
  "curveId": "curve_user_ab12cd_1750000000000",
  "thickness": 1.0,
  "ts": 1750000000000
}
```

```txt
action      one of the action types below
x, y, z     Lens Studio world position, centimeters, Y-up (meaning depends on action)
userId      "user_" + 6 random base36 chars, generated once per Lens session
brushMode   current brush at send time: tube | ribbon | polyline | eraser | grab
curveId     stroke identifier: "curve_" + userId + "_" + timestampMs, or an action name for global events
thickness   currentThickness, currently always 1.0 — Blender's own Thickness field is authoritative
ts          Date.now() in the Lens, milliseconds
```

## Action Types

### start

Begins a new stroke. Blender creates a curve object and the first spline point.

```txt
extras: fx, fy, fz  (ribbon only — hand forward vector at the first point)
```

### move

Appends a point to the active stroke identified by `curveId`.

```txt
extras: fx, fy, fz  (ribbon only)
```

Not sent for `polyline` (see `bezier-add` / `bezier-move`) or `eraser` (see `erase`).

### bezier-add

Adds a new Bezier anchor point to a polyline stroke. `x/y/z` is the tapped position.

### bezier-move

Sets the Bezier handle vector for the most recently added anchor, sent continuously while dragging after a tap.

```txt
x, y, z    the anchor position (not the current hand position)
extras: hx, hy, hz   handle vector = currentHandPos - anchor, in Lens Studio space
```

Blender applies the vector symmetrically: `handle_right = anchor + handle`, `handle_left = anchor - handle`.

### end

Closes the active stroke. No extras. Blender stops tracking `curveId` in `active_strokes` but leaves the object in `curve_registry`.

### erase

Discrete point-based delete, sent up to once per 200ms while the eraser brush is held near a stroke.

```txt
x, y, z   current fingertip position
```

Blender finds the nearest curve by anchor distance and deletes it if within a fixed threshold.

### grab-start / grab-move / grab-end

Two grab flows share these three actions — see [docs/architecture.md](architecture.md) for the difference.

```txt
grab-start   x/y/z = grab point (manual) or hand position (legacy). extras: ox, oy, oz (manual only — trail's world origin)
grab-move    x/y/z = new absolute position to move the curve to
grab-end     x/y/z = final position. extras: dx, dy, dz (manual only — total hand displacement)
```

### cancel-last

Sent only by the legacy hold-to-grab flow, immediately before its own `grab-start`. Tells Blender to undo the stroke that was just being drawn when the hold-grab triggered.

### undo

No positional meaning beyond the menu hand's fingertip. Pops the most recent `curveId` off Blender's undo stack and removes that object.

### clear-all

Removes every curve currently in `curve_registry` and resets all server-side state.

### set-color

```txt
extras: colorIdx           index into the fixed palette (fallback)
extras: r, g, b             explicit float color, present when the Lens has script.colors configured
```

Sets both the "next new stroke" color for the sending user and updates `user_colors[userId]` for multiplayer attribution.

### set-origin

```txt
x, y, z   the new origin point, in Lens Studio world space
```

Sent once when the origin gizmo drag settles, and once from the **Set Origin** radial button. Blender computes the delta from the previous origin and shifts every existing curve object so nothing appears to move relative to the physical world.

### export

No extras. Triggers the FBX merge-and-export flow described in [docs/blender-setup.md](blender-setup.md).

## Design Notes

The protocol intentionally reuses one envelope (`draw-event`) for every action rather than defining a message type per action. This keeps the Lens-side `send()` helper and the Blender-side dispatch loop both trivial — a single `if action == "..."` chain — at the cost of every payload carrying fields (`brushMode`, `thickness`) that most actions ignore. Given the traffic volume (one broadcast every ~15-80ms while drawing), this tradeoff favors simplicity over payload size.
