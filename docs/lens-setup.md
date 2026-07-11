# Lens Setup

## Open the Project

Open `Spatial Drawer.esproj` in Lens Studio. The main script is attached to a scene object and lives at:

```txt
Assets/SpatialDrawer.js
```

## Connection Inputs

```txt
supabaseProject   Asset.SupabaseProject — drag your Supabase credentials asset here
channelName       string, default "spatial-drawer" — must match the Blender panel exactly
```

The Supabase credentials asset exposes `url` and `publicToken`, read directly by the script (`script.supabaseProject.url`, `script.supabaseProject.publicToken`). Auth (`client.auth.signInWithSnapchat()`) only succeeds on-device — in Lens Studio's editor preview it fails silently and the script continues without it, which is expected.

## Spatial Reference Inputs

```txt
originGizmo   SceneObject — small draggable object that snaps to your physical origin
gridPlane     SceneObject — floor reference grid, follows originGizmo
```

Dragging `originGizmo` broadcasts a `set-origin` event once the drag settles (5 idle frames after the last movement). Blender re-anchors every existing curve relative to the new origin — see [docs/architecture.md](architecture.md) for the coordinate math.

## Radial Menu Inputs

Every button is an optional `SceneObject` input. If left unassigned, the script auto-creates a text placeholder so the menu still works — useful for testing before art is ready.

```txt
btnPreview        toggles AR trail visibility
btnBrushMenu       opens Brushes sub-menu
btnTube            sub-button: tube brush
btnRibbon          sub-button: ribbon brush
btnPoly            sub-button: polyline brush
btnEraser          sub-button: eraser
btnSize            opens Size sub-menu
sizePaletteParent  parent SceneObject; each child becomes one size sub-button, in XS→XL order
btnGrab            toggles grab mode
btnColors          opens Colors sub-menu
colorPaletteParent parent SceneObject; each child becomes one color sub-button
colors             vec4[] — must be the same length and order as colorPaletteParent's children
btnSetOrigin       re-anchors originGizmo + gridPlane to the current hand position
btnExport          triggers the FBX export in Blender
btnUndo            removes the most recent stroke
btnClearAll        removes every stroke
btnHandedness      swaps which hand draws and which opens the menu
centerTextObj      optional SceneObject with a Component.Text, shows the hovered button's label
previewMaterial    Asset.Material — unlit material cloned per-stroke for the AR preview
```

`sizePaletteParent` and `colorPaletteParent` are read by child index at `OnStartEvent`, so reordering children in the Scene panel changes which size or color each sub-button represents.

## Radial Menu Tuning

```txt
radialRadius         7.0    main ring radius, cm
radialSubRadius       12.0   sub-menu ring radius, cm
radialButtonSize       3.5    main button scale
radialSubButtonSize     3.5    sub-button scale
```

## Gestures

```txt
draw hand pinch down    -> start or continue a stroke (grab, if brushMode is "grab")
draw hand pinch up      -> end the stroke
draw hand pinch + hold 1s, no movement -> legacy grab: cancels last stroke, enters grab mode
menu hand double-pinch (<350ms between pinches) -> opens the radial menu at the hand position
menu hand hold + move   -> highlights radial buttons under the fingertip
menu hand pinch release -> selects the highlighted button, closes the menu
```

`getDrawHand()` / `getMenuHand()` resolve to right/left based on `isLeftHanded`, toggled by the **Hands** button. All gesture bindings are wired once at load time (`rightHand.onPinchDown`, `leftHand.onPinchDown`, etc.) and internally route to draw-hand or menu-hand logic based on the current handedness flag — they are not rebound when handedness changes.

## Brush Modes

```txt
tube      3D tube mesh, per-vertex normals, full rebuild each sample (see docs/architecture.md)
ribbon    flat strip, tilts with hand forward vector, incremental append
polyline  tap to place Bezier anchors; drag after a tap to shape that anchor's handles
eraser    pinch near a stroke to delete it; sends discrete "erase" events, no preview trail
grab      not a drawing brush — bounding-box hit test against existing AR trails
```

Switching brushes mid-project is safe; each brush keeps its own local state (`tubeTrailData`, `polyAnchorPoints`, etc.) and starting a new stroke resets it.

## Size and Color

Size presets map to tube/ribbon/polyline radius:

```txt
XS  0.3cm
S   0.5cm
M   0.8cm   (default)
L   1.3cm
XL  2.0cm
```

Size only affects the local AR preview — Blender's curve `bevel_depth` is controlled independently by the `spectacles_thickness` scene property in the Blender panel. Color picked from the palette updates both the local preview material (`mainPass.baseColor`) and the broadcast payload (`r`, `g`, `b`), so Blender assigns the same color to the material it creates for that stroke.

## Sending Rate

```txt
sendIntervalMs   80    minimum ms between grab-move / erase broadcasts
DRAW_MIN_DIST    1.5   cm — a draw sample only broadcasts if the hand moved further than this since the last sample
```

Lowering `DRAW_MIN_DIST` produces smoother curves in Blender at the cost of more broadcast traffic; raising it reduces traffic but can visibly facet the tube mesh on fast strokes.
