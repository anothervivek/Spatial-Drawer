# Changelog

All notable changes to this project will be documented in this file.

## [Phase 3] - 2026-06-15
### Added
- **Production Export Pipeline:** Added an "Export" button to the Lens Studio UI. When pressed, Blender automatically converts all AR sketch curves into a unified 3D mesh and exports it as an `.fbx` file to the Mac Desktop.
- **Generative AI Sketch-to-3D Pipeline:** Added an "AI Gen" button to the Lens Studio UI and a `tripo_api.py` helper to the Blender plugin. When pressed, Blender renders a 2D image of the spatial sketch, uploads it to the Tripo3D API, and automatically imports the generated high-poly 3D `.glb` model directly into the Blender scene, automatically scaling it to match the drawing.
- **Tripo3D API Key Field:** Added a new text field in the Blender UI panel for users to input their Tripo API key securely.

## [Phase 2.2] - 2026-06-15
### Added
- **Curve Smoothing:** Added a 1.5cm distance threshold to Lens Studio point streaming. Eliminates "clumping" of points when drawing slowly, resulting in beautifully smooth, low-poly curves in Blender.
- **Eraser Mode:** Added an Eraser brush to the script and radial menu. Pinching near a curve in Blender will delete the entire curve instantly.

### Changed
- **Variable Thickness:** Tweaked the mathematical mapping for the "Dynamic Thickness" option in Blender to provide smoother transitions between fast (thin) and slow (thick) hand movements.

## [Phase 2.1] - 2026-06-15
### Fixed
- **Ribbon Fix:** Blender now uses the `extrude` property for flat 2D ribbons instead of the bevel tube property.
- **Polyline Fix:** Fixed a bug where every pinch created a new curve ID, causing Blender to ignore stroke connections.
- **Color Fix:** Forced Blender's "Solid" viewport mode to display material colors by applying color to `mat.diffuse_color`.
