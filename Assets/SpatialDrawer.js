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
// @input SceneObject btnExport {"hint": "Button visual for Export"}
// @input SceneObject btnPreview {"hint": "Button visual for AR Preview Toggle"}
// @input SceneObject btnHandedness {"hint": "Button visual for Hand Toggle"}
// @input Asset.Material previewMaterial {"hint": "Unlit material for the AR trail"}
// @input SceneObject btnSetOrigin {"hint": "Button visual for Set Origin"}
// @input SceneObject btnUndo {"hint": "Button visual for Undo"}
// @input SceneObject btnColors {"hint": "Button to open Colors sub-menu"}
// @input SceneObject colorPaletteParent {"hint": "Parent object holding color buttons as children"}
// @input vec4[] colors {"widget": "color", "hint": "List of matching colors"}

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
var currentTrail = null;
var currentBuilder = null;
var currentTrailPoints = [];
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

    // ── Main ring buttons ──────────────────────────────────────────────────
    // Ordered to place Brushes near 135 deg and Colors near 225 deg
    var bPreview = radialMenu.addButton(getOrCreateButton(script.btnPreview, "preview"),  "preview");
    var bBrushes = radialMenu.addButton(getOrCreateButton(script.btnBrushMenu, "brushes"), "brushes");
    var bGrab    = radialMenu.addButton(getOrCreateButton(script.btnGrab, "grab"), "grab");
    var bColors  = radialMenu.addButton(getOrCreateButton(script.btnColors, "colors"), "colors");
    var bOrigin  = radialMenu.addButton(getOrCreateButton(script.btnSetOrigin, "origin"), "origin");
    var bExport  = radialMenu.addButton(getOrCreateButton(script.btnExport, "export"),    "export");
    var bUndo    = radialMenu.addButton(getOrCreateButton(script.btnUndo, "undo"),      "undo");
    var bHand    = radialMenu.addButton(getOrCreateButton(script.btnHandedness, "hands"), "hands");

    // Radio-state buttons: sceneObj passed so active/inactive visual persists correctly
    bindButtonHoverState(bPreview, "Preview AR",  script.btnPreview);
    bindButtonHoverState(bGrab,    "Grab Tool",   script.btnGrab);
    bindButtonHoverState(bHand,    "Swap Hands",  script.btnHandedness);
    // Action / sub-menu-parent buttons: pass null so no setState is called — prevents stuck "active" visuals
    bindButtonHoverState(bBrushes, "Brushes",     null);
    bindButtonHoverState(bColors,  "Colors",      null);
    bindButtonHoverState(bOrigin,  "Set Origin",  null);
    bindButtonHoverState(bExport,  "Export",      null);
    bindButtonHoverState(bUndo,    "Undo",        null);

    // ── Brush sub-buttons ──────────────────────────────────────────────────
    var bTube   = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnTube, "tube"),      "tube");
    var bRibbon = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnRibbon, "ribbon"),  "ribbon");
    var bPoly   = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnPoly, "poly"),      "poly");
    var bEraser = radialMenu.addSubButton("brushes", getOrCreateButton(script.btnEraser, "eraser"),  "eraser");

    bindButtonHoverState(bTube, "Tube Brush", script.btnTube);
    bindButtonHoverState(bRibbon, "Ribbon Brush", script.btnRibbon);
    bindButtonHoverState(bPoly, "Polyline Brush", script.btnPoly);
    bindButtonHoverState(bEraser, "Eraser", script.btnEraser);

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
    // colors: no default radio state — they highlight on hover only

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
                if (script.previewMaterial) rmv.mainMaterial = script.previewMaterial.clone();
                currentBuilder = new MeshBuilder([ { name: "position", components: 3 } ]);
                currentBuilder.topology = MeshTopology.LineStrip;
                currentTrailPoints = [pos.x, pos.y, pos.z];
                currentBuilder.appendVerticesInterleaved(currentTrailPoints);
                currentBuilder.updateMesh();
                rmv.mesh = currentBuilder.getMesh();
                previewTrails.push(currentTrail);
                currentTrail.bounds = { min: new vec3(pos.x, pos.y, pos.z), max: new vec3(pos.x, pos.y, pos.z) };
                print("[BEZ] CURVE START — id=" + activeCurveId.slice(-8) + " pos=(" + pos.x.toFixed(1) + "," + pos.y.toFixed(1) + "," + pos.z.toFixed(1) + ")");
                send("start", pos, extras);
            } else {
                activeCurveId = bezierActiveCurveId;
                print("[BEZ] ADD POINT #" + (currentTrailPoints.length / 3) + " pos=(" + pos.x.toFixed(1) + "," + pos.y.toFixed(1) + "," + pos.z.toFixed(1) + ")");
                send("bezier-add", pos, extras);
                if (currentBuilder && currentTrail) {
                    currentTrailPoints.push(pos.x, pos.y, pos.z);
                    currentBuilder.appendVerticesInterleaved([pos.x, pos.y, pos.z]);
                    currentBuilder.updateMesh();
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
            if (script.previewMaterial) rmv.mainMaterial = script.previewMaterial.clone();
            currentBuilder = new MeshBuilder([ { name: "position", components: 3 } ]);
            currentBuilder.topology = MeshTopology.LineStrip;
            currentTrailPoints = [pos.x, pos.y, pos.z];
            currentBuilder.appendVerticesInterleaved(currentTrailPoints);
            currentBuilder.updateMesh();
            rmv.mesh = currentBuilder.getMesh();
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
        await client.auth.signInWithIdToken({ provider: "snapchat", token: "" });
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
                
                // Update AR Preview Mesh dynamically!
                if (brushMode !== "eraser" && currentBuilder && currentTrail) {
                    currentTrailPoints.push(pos.x, pos.y, pos.z);
                    currentBuilder.appendVerticesInterleaved([pos.x, pos.y, pos.z]);
                    var idx = (currentTrailPoints.length / 3) - 1;
                    if (idx > 0) {
                        currentBuilder.appendIndices([idx - 1, idx]);
                    }
                    currentBuilder.updateMesh();
                    currentTrail.getComponent("Component.RenderMeshVisual").mesh = currentBuilder.getMesh();
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
