# Changelog

All notable changes to this project will be documented in this file.

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
