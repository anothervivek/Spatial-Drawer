# Testing Checklist

## Blender Only

Start the add-on listening with a real Supabase project. There is no fake-client script in this project — unlike a local WebSocket server, Supabase Realtime doesn't support easily scripting broadcasts without the JS/Python client. The fastest sanity check is opening your Supabase project dashboard's Realtime inspector and confirming the channel shows a join event once Blender connects.

Expected panel state:

```txt
Start Listening button disabled/hidden, Stop button visible
"Connected — Listening..." label shown
```

## Lens Studio Editor Preview

1. Assign a Supabase Project asset with valid credentials.
2. Enter Preview in Lens Studio.
3. Watch the Logger panel for:

```txt
[SpatialDrawer] Connecting... userId=user_xxxxxx
[SpatialDrawer] Channel: SUBSCRIBED
[SpatialDrawer] Connected! userId=user_xxxxxx
```

4. Simulate a pinch with the preview hand controls and draw a short stroke.
5. Confirm the AR preview trail renders in the Preview panel.
6. Confirm Blender (already listening) logs:

```txt
[Spectacles] Stroke START [tube] user=user_xxxxxx id=xxxxxxxx
[Spectacles] Stroke END id=xxxxxxxx
```

## Radial Menu

With Blender listening:

```txt
double-pinch menu hand           -> menu opens at hand position
hover each main-ring button      -> center text updates, hovered button highlights
tap Brushes                      -> sub-menu opens with 4 brush options
tap a brush                      -> radio state updates, brush becomes active
tap Size                         -> sub-menu opens with XS-XL
tap a size                       -> subsequent strokes use the new radius
tap Colors                       -> sub-menu opens with palette
tap a color                      -> subsequent strokes use the new color in AR and Blender
tap Grab, then pinch near a stroke -> stroke follows the hand, releases on pinch-up
tap Undo                         -> most recent stroke disappears from AR and Blender
tap Clear All                    -> every stroke disappears from AR and Blender
tap Export                       -> Blender status line shows a saved filename
tap Preview                      -> AR trails hide/show; Blender is unaffected
tap Hands                        -> draw hand and menu hand swap
```

## Spectacles Device

Push the Lens to a physical Spectacles device (Interactive Preview or a published Lens). Repeat the radial menu checklist above with real pinches. Additionally verify:

```txt
pinch-hold draw hand for 1s without moving -> enters grab mode on the last stroke, no radial menu needed
drag the origin gizmo, release            -> grid snaps, Blender log shows "Origin set -> ..." and shifts existing curves
```

## Multiplayer

Connect two Lens sessions (two devices, or one device plus Lens Studio preview) to the same Supabase project and channel.

```txt
each session draws with a distinct userId
Blender's "Users Online" panel lists both, with different colors
strokes from each session use that session's assigned color
Clear Offline Users resets the list without deleting drawn curves
```

## Export Pipeline

```txt
draw at least one stroke of each brush type
tap Export from the radial menu
confirm a file named SpatialDrawing_<timestamp>.fbx appears on the Desktop
open the .fbx in a separate Blender instance or any FBX-compatible viewer to confirm geometry is intact
confirm the original curves are still present and editable in the source Blender scene
```

## Known Rough Edges to Watch For

```txt
tube mesh can look faceted or pinched on very fast, sharp direction changes
grab bounding-box hit test can grab the wrong stroke when many overlap tightly
WebSocket does not auto-reconnect if Blender's connection drops mid-session — Stop and Start Listening again
```
