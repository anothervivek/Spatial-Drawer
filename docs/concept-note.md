# Spatial Drawer Concept

Spatial Drawer turns a pinch gesture on Spectacles into a live curve in a Blender scene, with no manual export/import step in between.

The flow is:

1. Pinch with the draw hand to start a stroke.
2. Sample the fingertip position as the hand moves, building a smooth AR preview mesh locally.
3. Broadcast every sampled point to a Supabase Realtime channel as a `draw-event`.
4. A Blender add-on, listening on the same channel, appends each point to a live Bezier curve.
5. Release the pinch to end the stroke — the curve stays in the Blender scene.
6. Repeat with different brushes, colors, and sizes; grab and move existing strokes; erase what you don't want; undo the last action.
7. Tap Export to merge everything into one mesh and write it to disk as `.fbx`.

The core idea is that the AR headset and the 3D content tool never talk directly — they're both just clients of the same broadcast channel. That keeps the Lens simple (it only ever sends) and makes the system naturally multiplayer: any number of Spectacles wearers can draw into the same Blender scene by joining the same channel, and Blender tells them apart by `userId`.

Minimal `draw-event` payload:

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

See [docs/protocol.md](protocol.md) for the full action set, and [docs/architecture.md](architecture.md) for how each side processes it.
