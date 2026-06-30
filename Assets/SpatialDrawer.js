// ─── Inputs ───────────────────────────────────────────────────────────────────
// @input Asset.SupabaseProject supabaseProject {"hint": "Drag your SupabaseProject asset here"}
// @input string channelName = "spatial-drawer"

// ─── Spatial reference objects ────────────────────────────────────────────────
// @input SceneObject originGizmo {"hint": "Small cube that snaps to your origin"}
// @input SceneObject gridPlane {"hint": "Floor reference grid"}

// ─── Radial Menu Button Visuals (create simple planes/cubes in Lens Studio) ──
// @input SceneObject btnBrushMenu {"hint": "Main button visual for Brushes"}
// @input SceneObject btnTube {"hint": "Sub-button: Tube brush"}
// @input SceneObject btnRibbon {"hint": "Sub-button: Ribbon brush"}
// @input SceneObject btnPoly {"hint": "Sub-button: Polyline brush"}
// @input SceneObject btnEraser {"hint": "Sub-button: Eraser"}
// @input SceneObject btnClearAll {"hint": "Sub-button: Clear All strokes"}
// @input SceneObject btnExport {"hint": "Button visual for Export"}
// @input SceneObject btnPreview {"hint": "Button visual for AR Preview Toggle"}
// @input SceneObject btnHandedness {"hint": "Button visual for Hand Toggle"}
// @input Asset.Material previewMaterial {"hint": "Unlit material for the AR trail"}
// @input SceneObject btnSetOrigin {"hint": "Button visual for Set Origin"}
// @input SceneObject btnUndo {"hint": "Button visual for Undo"}
// @input SceneObject btnColors {"hint": "Button to open Colors sub-menu"}
// @input SceneObject colorPaletteParent {"hint": "Parent object holding color buttons as children"}
// @input vec4[] colors {"widget": "color", "hint": "List of matching colors"}
// @input SceneObject btnSize {"hint": "Main ring button for Brush Size"}
// @input SceneObject sizePaletteParent {"hint": "Parent object holding size sub-buttons as children (XS→XL order)"}

// ─── Radial Menu Customization ────────────────────────────────────────────────
// @input float radialRadius = 7.0 {"hint": "Radius of the main menu ring (cm)"}
// @input float radialSubRadius = 12.0 {"hint": "Radius of the sub menu ring (cm)"}
// @input float radialButtonSize = 3.5 {"hint": "Size of the main buttons"}
// @input float radialSubButtonSize = 3.5 {"hint": "Size of the sub buttons"}

// @input SceneObject centerTextObj {"hint": "Optional: SceneObject with Text component to show button names"}
// @input SceneObject btnGrab {"hint": "Button visual for Grab tool"}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
const SIK = require("SpectaclesInteractionKit.lspkg/SIK").SIK;

var supabaseClient = null;
try {
    supabaseClient = require("SupabaseClient.lspkg/supabase-snapcloud").createClient;
} catch (e) {
    print("[SpatialDrawer] ERROR: SupabaseClient.lspkg not found!");
}

var cameraProvider = null;
try {
    var WorldCam = require("SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider");
    cameraProvider = WorldCam.getInstance();
} catch (e) {}

// ─────────────────────────────────────────────────────────────────────────────
// HANDS
// ─────────────────────────────────────────────────────────────────────────────
const rightHand = SIK.HandInputData.getHand("right");
const leftHand  = SIK.HandInputData.getHand("left");

var isLeftHanded = false;
var isPreviewEnabled = true;

function getDrawHand() { return isLeftHanded ? leftHand : rightHand; }
function getMenuHand() { return isLeftHanded ? rightHand : leftHand; }

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY & STATE
// ─────────────────────────────────────────────────────────────────────────────
var userId    = "user_" + Math.random().toString(36).substr(2, 6);
var brushMode = "tube";   // "tube" | "ribbon" | "polyline" | "eraser"
var currentThickness = 1.0;

var isConnected    = false;
var client         = null;
var realtimeChannel = null;

var isDrawing      = false;
var isGrabbing     = false;
var bezierActiveCurveId  = null;
var bezierLastAnchorPos  = null; // world position of last tapped bezier point (for handle vector)
var activeCurveId  = "";

var lastSendTimeMs   = 0;
var sendIntervalMs   = 80;
var lastRightPinchMs = 0;
var pinchHoldTimer   = 0;
var GRAB_HOLD_SEC    = 1.0;
var DRAW_MIN_DIST = 1.5;
var lastGrabPos      = null;
var lastSendPos      = null;
var grabStartHandPos = null; // hand position at moment of grab-start

// Menu hand pinch state (for feeding to radial menu)
var menuPinching       = false;
var lastMenuPinchMs    = 0;
var menuOpenPosition   = null;

// AR Preview State
var currentColor = new vec4(1, 1, 1, 1); // active stroke color, updated when user picks a color

var currentTrail = null;
var currentRmv   = null;   // cached RMV for the active ribbon stroke
var currentBuilder = null;
var currentTrailPoints = [];
var ribbonHalfWidth = 0.8; // cm, half-width of the ribbon strip
var ribbonVertCount = 0;   // verts committed to currentBuilder so far

// Tube brush state (ATC-style 3D tube, full rebuild each sample)
var tubeTrailData   = [];   // [{pos: vec3, refVec: vec3}]
var tubeLastRefVec  = null;
var tubeRadius      = 0.8;  // cm
var tubeFaces       = 8;

// Polyline tube state (separate builder, rebuilt on each anchor tap)
var polyTubeRadius  = 0.5;
var polyTubeFaces   = 8;
var polyAnchorPoints = [];
var polyRefVectors   = [];
var polyLastRefVec   = null;
var polyTubeBuilder  = null;
var polyTubeRmv      = null;

var previewTrails = []; // Store them to clear on undo
var centerTextRef = null; // Shared reference for radial center text
var manualGrabbedTrail = null;
var manualGrabOffset = vec3.zero();
var lastBrushMode = "tube"; // remembers last active brush before switching to grab

// ── Destroy a trail cleanly ──────────────────────────────────────────────
function destroyTrail(trail) {
    if (!trail || trail.isDestroyed) return;
    trail.destroy();
}

// ── Stable reference vector — evolves to prevent tube twisting ───────────
function getStablePolyRef(dir) {
    if (!polyLastRefVec) polyLastRefVec = vec3.up();
    var dot = dir.dot(polyLastRefVec);
    var proj = polyLastRefVec.sub(dir.uniformScale(dot));
    if (proj.length < 0.001) {
        var alt = Math.abs(dir.dot(vec3.up())) < 0.9 ? vec3.up() : vec3.forward();
        dot = dir.dot(alt);
        proj = alt.sub(dir.uniformScale(dot));
    }
    polyLastRefVec = proj.normalize();
    return polyLastRefVec;
}

// ── Circle of verts around pos, perpendicular to dir ────────────────────
function getCircleVerts(pos, dir, refVec, radius, faceCount) {
    var perp = dir.cross(refVec);
    if (perp.length < 0.001) perp = dir.cross(vec3.up());
    if (perp.length < 0.001) perp = dir.cross(vec3.right());
    perp = perp.normalize().uniformScale(radius);
    var step = (2 * Math.PI) / faceCount;
    var verts = [];
    for (var i = 0; i < faceCount; i++) {
        verts.push(quat.angleAxis(i * step, dir).multiplyVec3(perp).add(pos));
    }
    return verts;
}

// ── Erase all verts + indices from a builder so it can be reused ─────────
function clearMeshBuilder(b) {
    if (!b) return;
    try {
        var vc = b.getVerticesCount();
        if (vc > 0) { b.eraseVertices(0, vc); b.eraseIndices(0, b.getIndicesCount()); }
    } catch(e) {}
}

// ── Full tube rebuild from polyAnchorPoints ──────────────────────────────
function rebuildPolyTube() {
    if (!polyTubeBuilder || !polyTubeRmv) return;
    clearMeshBuilder(polyTubeBuilder);
    var n = polyAnchorPoints.length;
    if (n < 2) return;

    var fc = polyTubeFaces;
    var r  = polyTubeRadius;
    var allIndices = [];
    var prevLastIdx = -1;

    for (var i = 0; i < n - 1; i++) {
        var p1 = polyAnchorPoints[i];
        var p2 = polyAnchorPoints[i + 1];
        var seg = p2.sub(p1);
        if (seg.length < 0.001) continue;
        var dir = seg.normalize();

        var ring1 = getCircleVerts(p1, dir, polyRefVectors[i],     r, fc);
        var ring2 = getCircleVerts(p2, dir, polyRefVectors[i + 1], r, fc);

        var base = polyTubeBuilder.getVerticesCount();

        // fc+1 pairs: ring[0..fc-1] + ring[0] to close the loop
        for (var j = 0; j <= fc; j++) {
            var v1 = ring1[j % fc];
            var v2 = ring2[j % fc];
            polyTubeBuilder.appendVerticesInterleaved([v1.x, v1.y, v1.z, v2.x, v2.y, v2.z]);
        }

        var firstIdx = base;
        var lastIdx  = base + fc * 2 + 1;

        // Degenerate bridge from previous segment
        if (prevLastIdx >= 0) {
            allIndices.push(prevLastIdx, prevLastIdx, firstIdx, firstIdx);
        }

        // Strip indices: ring1[0], ring2[0], ring1[1], ring2[1], ..., ring1[0], ring2[0]
        for (var k = 0; k <= fc; k++) {
            allIndices.push(base + k * 2, base + k * 2 + 1);
        }

        prevLastIdx = lastIdx;
    }

    if (allIndices.length > 0) polyTubeBuilder.appendIndices(allIndices);
    polyTubeRmv.mesh = polyTubeBuilder.getMesh();
    polyTubeBuilder.updateMesh();
}

// ── ATC-faithful tube helpers ─────────────────────────────────────────────

function getStableTubeRef(dir) {
    if (!tubeLastRefVec) tubeLastRefVec = vec3.up();
    var dot = dir.dot(tubeLastRefVec);
    var proj = tubeLastRefVec.sub(dir.uniformScale(dot));
    if (proj.length < 0.001) {
        var alt = Math.abs(dir.dot(vec3.up())) < 0.9 ? vec3.up() : vec3.forward();
        dot = dir.dot(alt);
        proj = alt.sub(dir.uniformScale(dot));
    }
    tubeLastRefVec = proj.normalize();
    return tubeLastRefVec;
}

function getTubeCircle(pos, dir, refVec, radius, fc) {
    // Check length BEFORE normalize to avoid NaN when cross product is near-zero (ATC bug fix)
    var perp = dir.cross(refVec);
    if (perp.length < 0.001) perp = dir.cross(vec3.up());
    if (perp.length < 0.001) perp = dir.cross(vec3.forward());
    perp = perp.normalize().uniformScale(radius);
    var step = (2 * Math.PI) / fc;
    var verts = [];
    for (var i = 0; i < fc; i++) {
        verts.push(quat.angleAxis(i * step, dir).multiplyVec3(perp).add(pos));
    }
    return verts;
}

// Direct port of ATC's rebuildMesh + addSegmentWithGradient
function rebuildTubeMesh() {
    if (!currentBuilder || !currentRmv) return;

    var vc = currentBuilder.getVerticesCount();
    if (vc > 0) { currentBuilder.eraseVertices(0, vc); currentBuilder.eraseIndices(0, currentBuilder.getIndicesCount()); }

    var n = tubeTrailData.length;
    if (n < 2) return;

    var fc = tubeFaces;
    var r  = tubeRadius;

    for (var i = 0; i < n - 1; i++) {
        var d1 = tubeTrailData[i];
        var d2 = tubeTrailData[i + 1];
        var dir = d2.pos.sub(d1.pos);
        if (dir.length < 0.001) continue;
        dir = dir.normalize();

        var cs1 = getTubeCircle(d1.pos, dir, d1.refVec, r, fc);
        var cs2 = getTubeCircle(d2.pos, dir, d2.refVec, r, fc);

        var startIdx = currentBuilder.getVerticesCount();

        for (var j = 0; j < fc; j++) {
            var n1 = cs1[j].sub(d1.pos).normalize();
            var n2 = cs2[j].sub(d2.pos).normalize();
            currentBuilder.appendVertices([[cs1[j].x, cs1[j].y, cs1[j].z], [n1.x, n1.y, n1.z]]);
            currentBuilder.appendVertices([[cs2[j].x, cs2[j].y, cs2[j].z], [n2.x, n2.y, n2.z]]);
        }

        if (i > 0) {
            // ATC join: bridge from last ring of prev segment to first ring of this segment
            var lastSegEnd = startIdx - (2 * fc - 1);
            for (var jj = 0; jj < fc * 2; jj += 2) {
                currentBuilder.appendIndices([lastSegEnd + jj, startIdx + jj]);
            }
            // ATC's degenerate-triangle seam fix (doubles both anchor indices)
            currentBuilder.appendIndices([lastSegEnd, lastSegEnd, startIdx, startIdx]);
        }

        // Main strip for this segment
        var seg = [];
        for (var k = 0; k < fc * 2; k++) seg.push(startIdx + k);
        currentBuilder.appendIndices(seg);
        currentBuilder.appendIndices([startIdx, startIdx + 1]); // close the ring
    }

    // ATC's finalizeMesh pattern: getMesh() BEFORE updateMesh()
    currentRmv.mesh = currentBuilder.getMesh();
    currentBuilder.updateMesh();
}

// ─────────────────────────────────────────────────────────────────────────────
// RADIAL MENU
// ─────────────────────────────────────────────────────────────────────────────
var radialMenu = null;

function getOrCreateButton(inputObj, name) {
    if (inputObj) {
        // Wrap the user's object in an empty SceneObject.
        // This prevents the Radial Menu script from overwriting the user's custom rotation.
        var wrapper = global.scene.createSceneObject("wrap_" + name);
        inputObj.setParent(wrapper);
        inputObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
        return wrapper;
    }
    print("[SpatialDrawer] WARNING: Button '" + name + "' not assigned in Inspector. Creating a text placeholder.");
    var placeholder = global.scene.createSceneObject("btn_" + name);
    try {
        var textComp = placeholder.createComponent("Component.Text");
        textComp.text = name.toUpperCase();
        textComp.size = 14;
        textComp.horizontalAlignment = 1; // Center
        textComp.verticalAlignment = 1; // Center
    } catch (e) {
        print("[SpatialDrawer] Error creating text placeholder for " + name + ": " + e);
    }
    return placeholder;
}

function buildRadialMenu() {
    if (!global.SpectaclesRadialMenu) {
        print("[SpatialDrawer] SpectaclesRadialMenu not found!");
        return;
    }

    radialMenu = new global.SpectaclesRadialMenu.Create();
    radialMenu.radius        = script.radialRadius || 7.0;
    radialMenu.subRadius     = script.radialSubRadius || 12.0;
    radialMenu.buttonSize    = script.radialButtonSize || 3.5;
    radialMenu.subButtonSize = script.radialSubButtonSize || 3.5;

    // ── Hover callbacks use module-level centerTextRef directly ──
    function bindButtonHoverState(btnObj, textStr, sceneObj) {
        if (!btnObj) return;
        btnObj.onHighlight.add(function() { 
            if (centerTextRef) {
                centerTextRef.text = textStr;
                print("[SpatialDrawer] CenterText → " + textStr);
            }
            if (sceneObj) {
                var scripts = sceneObj.getComponents("Component.ScriptComponent");
                for (var j = 0; j < scripts.length; j++) {
                    var comp = scripts[j];
                    if (comp.isToggled !== true && comp.setState !== undefined) {
                        comp.setState("toggledDefault");
                    }
                }
            }
        });
        btnObj.onUnHighlight.add(function() { 
            if (centerTextRef) centerTextRef.text = ""; 
            if (sceneObj) {
                var scripts = sceneObj.getComponents("Component.ScriptComponent");
                for (var j = 0; j < scripts.length; j++) {
                    var comp = scripts[j];
                    if (comp.isToggled !== true && comp.setState !== undefined) {
                        comp.setState("default");
                    }
                }
            }
        });
    }

    // ── Main ring buttons (10 total) ───────────────────────────────────────
    var bPreview  = radialMenu.addButton(getOrCreateButton(script.btnPreview,    "preview"),  "preview");
    var bBrushes  = radialMenu.addButton(getOrCreateButton(script.btnBrushMenu,  "brushes"),  "brushes");
    var bSize     = radialMenu.addButton(getOrCreateButton(script.btnSize,        "size"),     "size");
    var bGrab     = radialMenu.addButton(getOrCreateButton(script.btnGrab,        "grab"),     "grab");
    var bColors   = radialMenu.addButton(getOrCreateButton(script.btnColors,      "colors"),   "colors");
    var bOrigin   = radialMenu.addButton(getOrCreateButton(script.btnSetOrigin,   "origin"),   "origin");
    var bExport   = radialMenu.addButton(getOrCreateButton(script.btnExport,      "export"),   "export");
    var bUndo     = radialMenu.addButton(getOrCreateButton(script.btnUndo,        "undo"),     "undo");
    var bClearAll = radialMenu.addButton(getOrCreateButton(script.btnClearAll,    "clearall"), "clearall");
    var bHand     = radialMenu.addButton(getOrCreateButton(script.btnHandedness,  "hands"),    "hands");

    // Radio-state buttons
    bindButtonHoverState(bPreview,  "Preview AR",   script.btnPreview);
    bindButtonHoverState(bGrab,     "Grab Tool",    script.btnGrab);
    bindButtonHoverState(bHand,     "Swap Hands",   script.btnHandedness);
    // Action / sub-menu-parent buttons: null = no stuck active visual
    bindButtonHoverState(bBrushes,  "Brushes",      null);
    bindButtonHoverState(bSize,     "Brush Size",   null);
    bindButtonHoverState(bColors,   "Colors",       null);
    bindButtonHoverState(bOrigin,   "Set Origin",   null);
    bindButtonHoverState(bExport,   "Export",       null);
    bindButtonHoverState(bUndo,     "Undo",         null);
    bindButtonHoverState(bClearAll, "Clear All",    null);

    // ── Brush sub-buttons (4 brushes, no Clear All) ───────────────────────
    var bTube   = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnTube,   "tube"),   "tube");
    var bRibbon = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnRibbon, "ribbon"), "ribbon");
    var bPoly   = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnPoly,   "poly"),   "poly");
    var bEraser = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnEraser, "eraser"), "eraser");

    bindButtonHoverState(bTube,   "Tube Brush",     script.btnTube);
    bindButtonHoverState(bRibbon, "Ribbon Brush",   script.btnRibbon);
    bindButtonHoverState(bPoly,   "Polyline Brush", script.btnPoly);
    bindButtonHoverState(bEraser, "Eraser",         script.btnEraser);

    // ── Size sub-buttons (auto-detected from sizePaletteParent children) ──
    var sizeValues = [0.3, 0.5, 0.8, 1.3, 2.0]; // XS → XL tube radius in cm
    var sizeLabels = ["XS", "S", "M", "L", "XL"];
    var sizeSceneObjs = [];
    if (script.sizePaletteParent) {
        var sizeChildCount = script.sizePaletteParent.getChildrenCount();
        for (var s = 0; s < sizeChildCount; s++) {
            sizeSceneObjs.push(script.sizePaletteParent.getChild(s));
        }
    }
    var sizeBtns = [];
    for (var si = 0; si < sizeSceneObjs.length; si++) {
        var sb = radialMenu.addSubButton("size", getOrCreateButton(sizeSceneObjs[si], "size_" + si), "size_" + si);
        bindButtonHoverState(sb, sizeLabels[si] || ("Size " + si), sizeSceneObjs[si]);
        sizeBtns.push(sb);
    }

    // ── Size callbacks ────────────────────────────────────────────────────
    function applySize(idx) {
        var r = sizeValues[idx] !== undefined ? sizeValues[idx] : 0.8;
        tubeRadius       = r;
        ribbonHalfWidth  = r;
        polyTubeRadius   = r * 0.6;
        setRadioButtonState(sizeSceneObjs, sizeSceneObjs[idx]);
        print("[SpatialDrawer] Size → " + (sizeLabels[idx] || idx) + " (" + r + "cm)");
    }

    for (var sci = 0; sci < sizeBtns.length; sci++) {
        (function(idx) { sizeBtns[idx].onPress.add(function() { applySize(idx); }); })(sci);
    }

    // ── Build color array from parent ─────────────────────────────────────────
    var internalColorPalette = [];
    if (script.colorPaletteParent) {
        var childCount = script.colorPaletteParent.getChildrenCount();
        for (var c = 0; c < childCount; c++) {
            internalColorPalette.push(script.colorPaletteParent.getChild(c));
        }
    }

    // ── Color sub-buttons (appear when 'Colors' is highlighted) ───────────
    for (var i = 0; i < internalColorPalette.length; i++) {
        radialMenu.addSubButton("colors", getOrCreateButton(internalColorPalette[i], "color_" + i), "color_" + i);
    }

    // Helper to toggle RadioButtons
    function setRadioButtonState(groupObjects, activeObj) {
        for (var i = 0; i < groupObjects.length; i++) {
            var obj = groupObjects[i];
            if (!obj) continue;
            var scripts = obj.getComponents("Component.ScriptComponent");
            for (var j = 0; j < scripts.length; j++) {
                var comp = scripts[j];
                // Check if the script has an isToggled property (our RadioButton does)
                if (comp.isToggled !== undefined) {
                    comp.isToggled = (obj === activeObj);
                } else if (comp.setState !== undefined) {
                    // Fallback for custom state management if isToggled isn't exposed
                    comp.setState((obj === activeObj) ? "toggledDefault" : "default");
                }
            }
        }
    }

    var brushButtons = [script.btnTube, script.btnRibbon, script.btnPoly, script.btnEraser, script.btnGrab];

    // Returns the SceneObject button for a given brush mode name
    function getBrushButton(mode) {
        if (mode === "tube")     return script.btnTube;
        if (mode === "ribbon")   return script.btnRibbon;
        if (mode === "polyline") return script.btnPoly;
        if (mode === "eraser")   return script.btnEraser;
        return script.btnTube; // fallback
    }

    // Activate a brush mode and update radio state (does not touch grab)
    function activateBrush(mode) {
        brushMode = mode;
        lastBrushMode = mode;
        if (mode !== "polyline") {
            bezierActiveCurveId = null;
            bezierLastAnchorPos = null;
        }
        setRadioButtonState(brushButtons, getBrushButton(mode));
        print("[SpatialDrawer] Brush → " + mode.toUpperCase());
    }

    // ── Grab toggle: active ↔ inactive; restores last brush when deactivated ──
    bGrab.onPress.add(function() {
        if (brushMode === "grab") {
            // Tap grab again → deactivate, restore last brush
            activateBrush(lastBrushMode);
        } else {
            // Activate grab, remember current brush
            lastBrushMode = brushMode;
            brushMode = "grab";
            setRadioButtonState(brushButtons, script.btnGrab);
            print("[SpatialDrawer] Brush -> GRAB");
        }
    });

    // ── Brush menu button tapped directly (no sub-button chosen) → restore last brush ──
    bBrushes.onPress.add(function() {
        if (brushMode === "grab") {
            activateBrush(lastBrushMode);
        }
        // If already in brush mode, the sub-button choice handles the switch; nothing extra needed
    });

    // ── Brush sub-button callbacks ─────────────────────────────────────────
    bTube.onPress.add(function()   { activateBrush("tube"); });
    bRibbon.onPress.add(function() { activateBrush("ribbon"); });
    bPoly.onPress.add(function()   { activateBrush("polyline"); });
    bEraser.onPress.add(function() { activateBrush("eraser"); });

    bClearAll.onPress.add(function() {
        for (var i = 0; i < previewTrails.length; i++) destroyTrail(previewTrails[i]);
        previewTrails = [];
        currentTrail = null; currentRmv = null; currentBuilder = null;
        currentTrailPoints = []; ribbonVertCount = 0;
        tubeTrailData = []; tubeLastRefVec = null;
        polyTubeBuilder = null; polyTubeRmv = null;
        polyAnchorPoints = []; polyRefVectors = []; polyLastRefVec = null;
        isDrawing = false; isGrabbing = false;
        manualGrabbedTrail = null;
        bezierActiveCurveId = null; bezierLastAnchorPos = null;
        send("clear-all", getMenuHand().indexTip.position, null);
        if (script.btnClearAll) {
            var cls = script.btnClearAll.getComponents("Component.ScriptComponent");
            for (var j = 0; j < cls.length; j++) {
                if (cls[j].setState !== undefined) cls[j].setState("default");
            }
        }
        print("[SpatialDrawer] CLEAR ALL");
    });

    bExport.onPress.add(function() {
        var pos = getDrawHand().isTracked() ? getDrawHand().indexTip.position : getMenuHand().indexTip.position;
        send("export", pos, null);
        print("[SpatialDrawer] Action → EXPORT");
    });

    // ── Visibility toggle: active by default, tapping flips active/inactive ──
    bPreview.onPress.add(function() {
        isPreviewEnabled = !isPreviewEnabled;
        for (var i = 0; i < previewTrails.length; i++) {
            if (previewTrails[i]) {
                previewTrails[i].enabled = isPreviewEnabled;
            }
        }
        setRadioButtonState([script.btnPreview], isPreviewEnabled ? script.btnPreview : null);
        print("[SpatialDrawer] AR Preview: " + (isPreviewEnabled ? "ON" : "OFF"));
    });

    bHand.onPress.add(function() {
        isLeftHanded = !isLeftHanded;
        setRadioButtonState([script.btnHandedness], isLeftHanded ? script.btnHandedness : null);
        print("[SpatialDrawer] Drawing Hand: " + (isLeftHanded ? "LEFT" : "RIGHT"));
    });

    // ── Set Origin callback ────────────────────────────────────────────────
    bOrigin.onPressAndClosed.add(function() {
        var pos = menuOpenPosition || getMenuHand().indexTip.position;
        print("[SpatialDrawer] Origin SET");
        if (script.originGizmo) script.originGizmo.getTransform().setWorldPosition(pos);
        if (script.gridPlane)   script.gridPlane.getTransform().setWorldPosition(pos);
        send("set-origin", pos, null);
    });

    // ── Undo callback ──────────────────────────────────────────────────────
    bUndo.onPressAndClosed.add(function() {
        send("undo", getMenuHand().indexTip.position, null);
        if (previewTrails.length > 0) {
            var lastTrail = previewTrails.pop();
            destroyTrail(lastTrail);
        }
        print("[SpatialDrawer] UNDO");
    });

    // ── Color callbacks ────────────────────────────────────────────────────
    for (var i = 0; i < internalColorPalette.length; i++) {
        (function(colorIdx) {
            var btnRef = radialMenu.getAllButtons()["color_" + colorIdx];
            if (btnRef) {
                btnRef.onPressAndClosed.add(function() {
                    var payload = { colorIdx: colorIdx };
                    if (script.colors && colorIdx < script.colors.length) {
                        var cv = script.colors[colorIdx];
                        payload.r = cv.r;
                        payload.g = cv.g;
                        payload.b = cv.b;
                    }
                    if (script.colors && colorIdx < script.colors.length) {
                        var cv2 = script.colors[colorIdx];
                        currentColor = new vec4(cv2.r, cv2.g, cv2.b, 1.0);
                    }
                    send("set-color", leftHand.indexTip.position, payload);
                    print("[SpatialDrawer] Color → " + colorIdx);
                });
            }
        })(i);
    }

    radialMenu.build();

    // ── Parent center text to the radial root (root is created inside build) ──
    var menuRoot = radialMenu.getRootObject();
    // Buttons are rotated 180° on Y to face the user (see Spectacles Radial Menu.js noRotation)
    var textRotation = quat.angleAxis(Math.PI, vec3.up());
    var defaultCenterLabel = "●"; // visible default label at center
    
    if (script.centerTextObj) {
        script.centerTextObj.setParent(menuRoot);
        script.centerTextObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
        script.centerTextObj.getTransform().setLocalRotation(textRotation);
        script.centerTextObj.getTransform().setLocalScale(vec3.one().uniformScale(script.radialButtonSize || 3.5));
        var textComp = script.centerTextObj.getComponent("Component.Text");
        if (textComp) {
            centerTextRef = textComp;
            centerTextRef.text = defaultCenterLabel;
            print("[SpatialDrawer] Center text linked! component found.");
        } else {
            print("[SpatialDrawer] WARNING: centerTextObj has no Component.Text!");
        }
    } else {
        var centerTextObj = global.scene.createSceneObject("RadialCenterText");
        centerTextObj.setParent(menuRoot);
        centerTextObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
        centerTextObj.getTransform().setLocalRotation(textRotation);
        centerTextObj.getTransform().setLocalScale(vec3.one().uniformScale(script.radialButtonSize || 3.5));
        centerTextRef = centerTextObj.createComponent("Component.Text");
        centerTextRef.text = defaultCenterLabel;
        centerTextRef.size = 36;
        centerTextRef.horizontalAlignment = 1; // Center
        centerTextRef.verticalAlignment = 1; // Center
        print("[SpatialDrawer] Center text auto-created");
    }

    // When no button is highlighted, show default label
    radialMenu.onNoneHighlighted.add(function() {
        if (centerTextRef) centerTextRef.text = defaultCenterLabel;
    });

    // ── Initialize default button states ────────────────────────────────────
    setRadioButtonState(brushButtons, script.btnTube);           // tube brush active by default
    setRadioButtonState([script.btnPreview], script.btnPreview); // visibility ON by default
    setRadioButtonState([script.btnHandedness], isLeftHanded ? script.btnHandedness : null);
    if (sizeSceneObjs.length > 2) applySize(2);                  // M size active by default

    print("[SpatialDrawer] ✅ Radial Menu ready! centerTextRef=" + (centerTextRef ? "OK" : "NULL"))
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAW HAND — PINCH LOGIC
// ─────────────────────────────────────────────────────────────────────────────
function onDrawHandPinchDown() {
    try {
        var drawHand = getDrawHand();
        if (!drawHand.isTracked()) return;

        var pos = drawHand.indexTip.position;
        var nowMs = getTime() * 1000;
        
        if (brushMode === "grab") {
            var closestTrail = null;
            var minDist = 99999;
            for (var i = 0; i < previewTrails.length; i++) {
                var t = previewTrails[i];
                if (!t || t.isDestroyed || !t.bounds) continue;
                
                // Get absolute bounds dynamically
                var wpos = t.getTransform().getWorldPosition();
                var min = t.bounds.min.add(wpos).sub(new vec3(15,15,15)); // 15cm grab radius padding
                var max = t.bounds.max.add(wpos).add(new vec3(15,15,15));
                
                // Bounding box collision check
                if (pos.x >= min.x && pos.x <= max.x &&
                    pos.y >= min.y && pos.y <= max.y &&
                    pos.z >= min.z && pos.z <= max.z) {
                    
                    var center = min.add(max).uniformScale(0.5);
                    var d = pos.distance(center);
                    if (d < minDist) {
                        minDist = d;
                        closestTrail = t;
                    }
                }
            }
            if (closestTrail) {
                isGrabbing = true;
                manualGrabbedTrail = closestTrail;
                // Offset: trail's current world origin minus hand position, so the trail follows the hand delta exactly
                var trailOrigin = closestTrail.getTransform().getWorldPosition();
                manualGrabOffset = trailOrigin.sub(pos);
                grabStartHandPos = pos;

                // Extract curve ID to notify blender
                var nameParts = closestTrail.name.replace("PreviewTrail_", "");
                activeCurveId = nameParts;

                send("grab-start", pos, { ox: trailOrigin.x, oy: trailOrigin.y, oz: trailOrigin.z });
                print("[SpatialDrawer] Manually grabbed curve: " + activeCurveId);
            }
            return;
        }

        var extras = {};

        if (brushMode === "ribbon") {
            var fwd = drawHand.indexTip.forward;
            extras.fx = fwd.x; extras.fy = fwd.y; extras.fz = fwd.z;
        }

        if (brushMode === "polyline") {
            bezierLastAnchorPos = pos;
            if (!bezierActiveCurveId) {
                bezierActiveCurveId = "curve_" + userId + "_" + nowMs;
                activeCurveId = bezierActiveCurveId;
                currentTrail = global.scene.createSceneObject("PreviewTrail_" + activeCurveId);
                currentTrail.enabled = isPreviewEnabled;
                currentTrail.anchorPos = new vec3(pos.x, pos.y, pos.z);
                var rmv = currentTrail.createComponent("Component.RenderMeshVisual");
                if (script.previewMaterial) {
                    rmv.mainMaterial = script.previewMaterial.clone();
                    try { rmv.mainMaterial.mainPass.baseColor = currentColor; } catch(e) {}
                }
                polyTubeBuilder = new MeshBuilder([{ name: "position", components: 3 }]);
                polyTubeBuilder.topology = MeshTopology.TriangleStrip;
                polyTubeBuilder.indexType = MeshIndexType.UInt16;
                polyTubeRmv = rmv;
                polyAnchorPoints = [new vec3(pos.x, pos.y, pos.z)];
                polyLastRefVec = null;
                polyRefVectors = [vec3.up()];
                currentTrailPoints = [pos.x, pos.y, pos.z];
                currentBuilder = null;
                previewTrails.push(currentTrail);
                currentTrail.bounds = { min: new vec3(pos.x, pos.y, pos.z), max: new vec3(pos.x, pos.y, pos.z) };
                print("[BEZ] CURVE START — id=" + activeCurveId.slice(-8) + " pos=(" + pos.x.toFixed(1) + "," + pos.y.toFixed(1) + "," + pos.z.toFixed(1) + ")");
                send("start", pos, extras);
            } else {
                activeCurveId = bezierActiveCurveId;
                print("[BEZ] ADD POINT #" + (currentTrailPoints.length / 3) + " pos=(" + pos.x.toFixed(1) + "," + pos.y.toFixed(1) + "," + pos.z.toFixed(1) + ")");
                send("bezier-add", pos, extras);
                if (polyTubeBuilder && currentTrail) {
                    var lastP = polyAnchorPoints[polyAnchorPoints.length - 1];
                    var newP  = new vec3(pos.x, pos.y, pos.z);
                    var segDir = newP.sub(lastP);
                    segDir = segDir.length > 0.001 ? segDir.normalize() : vec3.forward();
                    polyAnchorPoints.push(newP);
                    polyRefVectors.push(getStablePolyRef(segDir));
                    currentTrailPoints.push(pos.x, pos.y, pos.z);
                    rebuildPolyTube();
                }
            }
            isDrawing = true;
            isGrabbing = false;
            pinchHoldTimer = 0;
            lastSendTimeMs = nowMs;
            lastSendPos = pos;
            return;
        }

        activeCurveId = "curve_" + userId + "_" + nowMs;
        isDrawing = true;
        isGrabbing = false;
        pinchHoldTimer = 0;
        lastGrabPos = pos;
        
        // Start AR Preview Mesh (eraser has no preview trail)
        if (brushMode !== "eraser") {
            currentTrail = global.scene.createSceneObject("PreviewTrail_" + activeCurveId);
            currentTrail.enabled = isPreviewEnabled;
            currentTrail.anchorPos = new vec3(pos.x, pos.y, pos.z);
            var rmv = currentTrail.createComponent("Component.RenderMeshVisual");
            if (script.previewMaterial) {
                rmv.mainMaterial = script.previewMaterial.clone();
                try { rmv.mainMaterial.mainPass.baseColor = currentColor; } catch(e) {}
            }
            currentRmv = rmv;
            currentTrailPoints = [pos.x, pos.y, pos.z];
            if (brushMode === "tube") {
                // ATC-style 3D tube — needs normals, full rebuild each point
                currentBuilder = new MeshBuilder([
                    { name: "position", components: 3 },
                    { name: "normal",   components: 3, normalized: true }
                ]);
                tubeTrailData  = [{ pos: new vec3(pos.x, pos.y, pos.z), refVec: vec3.up() }];
                tubeLastRefVec = null;
            } else {
                // Flat ribbon (ribbon brush) — incremental append, deferred first pair
                currentBuilder = new MeshBuilder([{ name: "position", components: 3 }]);
                ribbonVertCount = 0;
            }
            currentBuilder.topology = MeshTopology.TriangleStrip;
            currentBuilder.indexType = MeshIndexType.UInt16;
            previewTrails.push(currentTrail);
            currentTrail.bounds = { min: new vec3(pos.x, pos.y, pos.z), max: new vec3(pos.x, pos.y, pos.z) };
            send("start", pos, extras); // don't send "start" for eraser — Blender would try to create a curve
        }
        lastSendTimeMs = nowMs;
        lastSendPos = pos;
    } catch (e) {
        print("[SpatialDrawer] onDrawHandPinchDown error: " + e);
    }
}

function onDrawHandPinchUp() {
    try {
        var drawHand = getDrawHand();
        if (isGrabbing) {
            var pos = drawHand.isTracked() ? drawHand.indexTip.position : vec3.zero();
            
            if (brushMode === "grab" && manualGrabbedTrail) {
                // Broadcast final SceneObject world position so Blender knows the total displacement
                pos = manualGrabbedTrail.getTransform().getWorldPosition();
                var handDelta = drawHand.isTracked() ? drawHand.indexTip.position.sub(grabStartHandPos) : vec3.zero();
                send("grab-end", pos, { dx: handDelta.x, dy: handDelta.y, dz: handDelta.z });
                manualGrabbedTrail = null;
                grabStartHandPos = null;
                isGrabbing = false;
                print("[SpatialDrawer] Grab END");
                return;
            }
            
            send("grab-end", pos, null);
            isGrabbing = false;
            print("[SpatialDrawer] Grab END");
            return;
        }
        if (!isDrawing) return;
        if (brushMode === "eraser") return; // eraser only uses discrete "erase" events
        if (brushMode === "polyline") {
            isDrawing = false;
            print("[BEZ] HANDLE RELEASED — isDrawing=false, ready for next tap");
            return;
        }
        send("end", drawHand.indexTip.position, null);
        isDrawing = false;
        currentBuilder = null;
        currentRmv = null;
        ribbonVertCount = 0;
        tubeTrailData = [];
        tubeLastRefVec = null;
        print("[SpatialDrawer] Draw END");
    } catch (e) {
        print("[SpatialDrawer] onDrawHandPinchUp error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MENU HAND — RADIAL MENU + QUICK UNDO
// ─────────────────────────────────────────────────────────────────────────────
function onMenuHandPinchDown() {
    try {
        var menuHand = getMenuHand();
        if (!menuHand.isTracked()) return;
        var nowMs = getTime() * 1000;

        // Double-pinch = open radial menu
        if (nowMs - lastMenuPinchMs < 350) {
            print("[SpatialDrawer] Double-pinch: Opening Radial Menu");
            menuPinching = true;
            if (radialMenu) {
                menuOpenPosition = menuHand.indexTip.position;
                var headPos = (cameraProvider && typeof cameraProvider.getTransform === 'function') ? cameraProvider.getTransform().getWorldPosition() : null;
                radialMenu.onPinchStart(menuOpenPosition, headPos);
            }
            lastMenuPinchMs = 0; // reset to avoid triple-pinch issues
            return;
        }
        lastMenuPinchMs = nowMs;
    } catch (e) {
        print("[SpatialDrawer] onMenuHandPinchDown error: " + e);
    }
}

function onMenuHandPinchUp() {
    try {
        menuPinching = false;
        if (radialMenu) radialMenu.onPinchEnd();
    } catch (e) {
        print("[SpatialDrawer] onMenuHandPinchUp error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
async function connectToSnapCloud() {
    if (!script.supabaseProject || !supabaseClient) {
        print("[SpatialDrawer] Cannot connect — check SupabaseProject input.");
        return;
    }
    print("[SpatialDrawer] Connecting... userId=" + userId);
    try {
        client = supabaseClient(
            script.supabaseProject.url,
            script.supabaseProject.publicToken,
            { realtime: { heartbeatIntervalMs: 2500 } }
        );
        // Auth only works on-device (not in Lens Studio preview); skip gracefully
        try { await client.auth.signInWithSnapchat(); } catch (authErr) {
            print("[SpatialDrawer] Auth skipped (preview mode): " + authErr);
        }
        realtimeChannel = client.channel(script.channelName, {
            config: { broadcast: { self: false } }
        });
        realtimeChannel.subscribe(function(status) {
            print("[SpatialDrawer] Channel: " + status);
            if (status === "SUBSCRIBED") {
                isConnected = true;
                print("[SpatialDrawer] ✅ Connected! userId=" + userId);
            }
        });
    } catch (e) {
        print("[SpatialDrawer] Connection error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────────────────────────────────────────
function send(action, pos, extras) {
    var payload = {
        action:    action,
        x:         pos ? pos.x : 0,
        y:         pos ? pos.y : 0,
        z:         pos ? pos.z : 0,
        userId:    userId,
        brushMode: brushMode,
        curveId:   activeCurveId,
        thickness: currentThickness,
        ts:        Date.now()
    };
    if (extras) { for (var k in extras) { payload[k] = extras[k]; } }
    
    if (isConnected && realtimeChannel) {
        try {
            realtimeChannel.send({ type: "broadcast", event: "draw-event", payload: payload });
        } catch (e) {
            print("[SpatialDrawer] send error: " + e);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE LOOP
// ─────────────────────────────────────────────────────────────────────────────
function onUpdate() {
    var dt    = getDeltaTime();
    var nowMs = getTime() * 1000;


    try {
        var drawHand = getDrawHand();
        var menuHand = getMenuHand();
        
        // ── Disable Gizmo Interactable if Drawing ─────────────────────────
        if (script.originGizmo) {
            var scripts = script.originGizmo.getComponents("Component.ScriptComponent");
            for (var i = 0; i < scripts.length; i++) {
                var s = scripts[i];
                // Check for Interactable (onGrabStart) or InteractableManipulation (enableTranslation)
                if (s.onGrabStart !== undefined || s.enableTranslation !== undefined || s.isDragging !== undefined) {
                    s.enabled = !isDrawing;
                }
            }
        }

        // ── Feed radial menu hold position ───────────────────────────────
        if (menuPinching && menuHand.isTracked() && radialMenu) {
            radialMenu.onPinchHold(menuHand.indexTip.position);
        }

        // ── Grab: hold draw pinch for 1s ────────────────────────────────
        if (isDrawing && !isGrabbing && brushMode !== "polyline" && drawHand.isTracked()) {
            var currentPos = drawHand.indexTip.position;
            if (lastGrabPos && currentPos.distance(lastGrabPos) > 1.5) {
                // Hand moved -> reset grab timer
                pinchHoldTimer = 0;
                lastGrabPos = currentPos;
            } else {
                pinchHoldTimer += dt;
            }

            if (pinchHoldTimer >= GRAB_HOLD_SEC) {
                send("cancel-last", currentPos, null);
                isDrawing      = false;
                isGrabbing     = true;
                pinchHoldTimer = 0;
                send("grab-start", currentPos, null);
                print("[SpatialDrawer] GRAB MODE — hold & drag to move curve");
                return;
            }
        }



        // ── Origin Gizmo Interactive Drag Tracking ───────────────────────
        if (script.originGizmo) {
            var originPos = script.originGizmo.getTransform().getWorldPosition();
            if (global.lastOriginPos === undefined) {
                global.lastOriginPos = originPos;
                global.originIdleFrames = 0;
            } else {
                var dist = originPos.distance(global.lastOriginPos);
                if (dist > 0.001) {
                    global.lastOriginPos = originPos;
                    global.originIdleFrames = 0;
                } else if (dist === 0 && global.originIdleFrames < 5) {
                    global.originIdleFrames++;
                    if (global.originIdleFrames === 5) {
                        // Stabilized after moving -> sync origin to Blender
                        send("set-origin", originPos, null);
                        print("[SpatialDrawer] Origin drag ended -> Broadcasted new origin");
                    }
                }
            }
        }

        // ── Legacy Grab Streaming (Hold 1s) ──────────────────────────────
        if (isGrabbing && brushMode !== "grab" && drawHand.isTracked()) {
            if (nowMs - lastSendTimeMs > sendIntervalMs) {
                send("grab-move", drawHand.indexTip.position, null);
                lastSendTimeMs = nowMs;
            }
            return;
        }

        // ── Custom Grab Streaming ────────────────────────────────────────
        if (isGrabbing && brushMode === "grab" && manualGrabbedTrail && !manualGrabbedTrail.isDestroyed && drawHand.isTracked()) {
            var gpos = drawHand.indexTip.position;
            var newPos = gpos.add(manualGrabOffset);
            manualGrabbedTrail.getTransform().setWorldPosition(newPos);
            
            if (nowMs - lastSendTimeMs > sendIntervalMs) {
                send("grab-move", newPos, null);
                lastSendTimeMs = nowMs;
            }
            return;
        }

        // ── Erase streaming ──────────────────────────────────────────────
        if (isDrawing && brushMode === "eraser" && drawHand.isTracked()) {
            if (nowMs - lastSendTimeMs > 200) {
                var erasePos = drawHand.indexTip.position;
                send("erase", erasePos, null);
                lastSendTimeMs = nowMs;

                // Local AR Erase
                var eraseDist = 15.0; // cm
                for (var i = previewTrails.length - 1; i >= 0; i--) {
                    var trail = previewTrails[i];
                    if (trail && !trail.isDestroyed && trail.anchorPos) {
                        if (trail.anchorPos.distance(erasePos) < eraseDist) {
                            destroyTrail(trail);
                            previewTrails.splice(i, 1);
                        }
                    }
                }
            }
            return;
        }

        // ── Dragging logic ──────────────────────────────────────────────
        if (!isDrawing || !drawHand.isTracked() || brushMode === "eraser") return;

        var pos = drawHand.indexTip.position;
        var dist = pos.distance(lastSendPos);

        // Bezier handle drag — send handle vector relative to the tapped anchor point
        // Blender uses: handle_right = anchor + handle, handle_left = anchor - handle (symmetric)
        if (brushMode === "polyline") {
            if (dist > DRAW_MIN_DIST && bezierLastAnchorPos) {
                var hx = pos.x - bezierLastAnchorPos.x;
                var hy = pos.y - bezierLastAnchorPos.y;
                var hz = pos.z - bezierLastAnchorPos.z;
                print("[BEZ] HANDLE DRAG — h=(" + hx.toFixed(1) + "," + hy.toFixed(1) + "," + hz.toFixed(1) + ") dist=" + dist.toFixed(1) + "cm");
                send("bezier-move", bezierLastAnchorPos, { hx: hx, hy: hy, hz: hz });
                lastSendPos = pos;
                if (currentTrail && currentTrail.bounds) {
                    var b = currentTrail.bounds;
                    b.min.x = Math.min(b.min.x, pos.x);
                    b.min.y = Math.min(b.min.y, pos.y);
                    b.min.z = Math.min(b.min.z, pos.z);
                    b.max.x = Math.max(b.max.x, pos.x);
                    b.max.y = Math.max(b.max.y, pos.y);
                    b.max.z = Math.max(b.max.z, pos.z);
                }
            }
            return;
        }

        // Normal Drawing Move
        if (dist > DRAW_MIN_DIST) {
            // Smoothing: Only send a point if the hand has moved more than 1.5cm
            if (!lastSendPos || pos.distance(lastSendPos) > 1.5) {
                var extras = {};
                if (brushMode === "ribbon") {
                    var fwd = drawHand.indexTip.forward;
                    extras.fx = fwd.x; extras.fy = fwd.y; extras.fz = fwd.z;
                }
                send("move", pos, extras);
                lastSendTimeMs = nowMs;
                lastSendPos = pos;
                
                if (currentTrail && currentTrail.bounds) {
                    var b = currentTrail.bounds;
                    b.min.x = Math.min(b.min.x, pos.x);
                    b.min.y = Math.min(b.min.y, pos.y);
                    b.min.z = Math.min(b.min.z, pos.z);
                    b.max.x = Math.max(b.max.x, pos.x);
                    b.max.y = Math.max(b.max.y, pos.y);
                    b.max.z = Math.max(b.max.z, pos.z);
                }
                
                // Update AR Preview
                if (brushMode === "tube" && currentBuilder && currentTrail && currentRmv) {
                    // ATC-style 3D tube: push point + stable ref, full rebuild
                    var prevTubePt = tubeTrailData[tubeTrailData.length - 1].pos;
                    var td = pos.sub(prevTubePt);
                    var tdir = td.length > 0.001 ? td.normalize() : vec3.forward();
                    tubeTrailData.push({ pos: new vec3(pos.x, pos.y, pos.z), refVec: getStableTubeRef(tdir) });
                    currentTrailPoints.push(pos.x, pos.y, pos.z);
                    rebuildTubeMesh();
                } else if (brushMode === "ribbon" && currentBuilder && currentTrail && currentRmv) {
                    // Flat ribbon: incremental 2-vert append
                    currentTrailPoints.push(pos.x, pos.y, pos.z);
                    var rn = currentTrailPoints.length / 3;
                    var rPrev = new vec3(
                        currentTrailPoints[(rn - 2) * 3],
                        currentTrailPoints[(rn - 2) * 3 + 1],
                        currentTrailPoints[(rn - 2) * 3 + 2]);
                    var rd = pos.sub(rPrev);
                    var rdir = rd.length > 0.001 ? rd.normalize() : vec3.forward();
                    var ref = drawHand.indexTip.forward;
                    var perp = rdir.cross(ref);
                    if (perp.length < 0.001) perp = rdir.cross(vec3.up());
                    if (perp.length < 0.001) perp = vec3.right();
                    perp = perp.normalize().uniformScale(ribbonHalfWidth);

                    if (ribbonVertCount === 0) {
                        var sp = new vec3(currentTrailPoints[0], currentTrailPoints[1], currentTrailPoints[2]);
                        var sL = sp.add(perp); var sR = sp.sub(perp);
                        currentBuilder.appendVerticesInterleaved([sL.x, sL.y, sL.z, sR.x, sR.y, sR.z]);
                        currentBuilder.appendIndices([0, 1]);
                        ribbonVertCount = 2;
                    }

                    var L = pos.add(perp); var R = pos.sub(perp);
                    currentBuilder.appendVerticesInterleaved([L.x, L.y, L.z, R.x, R.y, R.z]);
                    currentBuilder.appendIndices([ribbonVertCount, ribbonVertCount + 1]);
                    ribbonVertCount += 2;

                    currentBuilder.updateMesh();
                    currentRmv.mesh = currentBuilder.getMesh();
                }
            }
        }

    } catch (e) {
        print("[SpatialDrawer] onUpdate error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BINDINGS
// ─────────────────────────────────────────────────────────────────────────────
rightHand.onPinchDown.add(function() { if (!isLeftHanded) onDrawHandPinchDown(); else onMenuHandPinchDown(); });
rightHand.onPinchUp.add(function()   { if (!isLeftHanded) onDrawHandPinchUp(); else onMenuHandPinchUp(); });

leftHand.onPinchDown.add(function()  { if (isLeftHanded) onDrawHandPinchDown(); else onMenuHandPinchDown(); });
leftHand.onPinchUp.add(function()    { if (isLeftHanded) onDrawHandPinchUp(); else onMenuHandPinchUp(); });
script.createEvent("UpdateEvent").bind(onUpdate);

script.createEvent("OnStartEvent").bind(function() {
    print("[SpatialDrawer] Starting...");
    buildRadialMenu();
    connectToSnapCloud();
    
    print("[SpatialDrawer] Initialized. Left double-pinch = menu, Right pinch = draw");
});
