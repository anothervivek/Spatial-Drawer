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
var bezierActiveCurveId = null;
var activeCurveId  = "";

var lastSendTimeMs   = 0;
var sendIntervalMs   = 80;
var lastRightPinchMs = 0;
var pinchHoldTimer   = 0;
var GRAB_HOLD_SEC    = 1.0;
var DRAW_MIN_DIST = 1.5;
var lastGrabPos      = null;
var lastSendPos      = null;

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

// ── Grab Handle: lazily attach SIK Interactable+Manipulation to a trail ──────
function attachGrabHandle(trail) {
    if (!script.originGizmo || !trail || trail.isDestroyed || trail.grabHandle) return;
    
    // Create a temporary root so copyWholeHierarchy always has a valid parent
    var tempRoot = global.scene.createSceneObject("_grabTemp");
    var grabHandle = script.originGizmo.copyWholeHierarchy(tempRoot);
    
    // Un-parent from temp root and destroy temp
    grabHandle.setParent(null);
    tempRoot.destroy();
    
    grabHandle.name = "GrabHandle_" + (trail.name || "trail");
    grabHandle.enabled = true;
    
    // Remove visual children — we only want the SIK scripts + collider
    while (grabHandle.getChildrenCount() > 0) grabHandle.getChild(0).destroy();
    var oldVis = grabHandle.getComponents("Component.RenderMeshVisual");
    for (var v = 0; v < oldVis.length; v++) oldVis[v].destroy();
    
    // Position at the trail's anchor (first drawn point)
    var anchor = trail.anchorPos || vec3.zero();
    grabHandle.getTransform().setWorldPosition(anchor);
    grabHandle.getTransform().setLocalScale(vec3.one());
    
    // Parent trail under grab handle so moving the handle moves the mesh
    trail.setParent(grabHandle);
    // Preserve trail world transform so vertices stay in place
    trail.getTransform().setWorldPosition(vec3.zero());
    trail.getTransform().setWorldRotation(quat.quatIdentity());
    trail.getTransform().setWorldScale(vec3.one());
    
    trail.grabHandle = grabHandle;
    print("[SpatialDrawer] Attached grab handle to " + trail.name);
}

// ── Destroy a trail and its grab handle cleanly ──────────────────────────────
function destroyTrail(trail) {
    if (!trail || trail.isDestroyed) return;
    var handle = trail.grabHandle;
    if (handle && !handle.isDestroyed) {
        // Un-parent trail first so it can be destroyed independently
        trail.setParent(null);
        handle.destroy();
    }
    trail.destroy();
}

function updateGrabColliders(enabled) {
    for (var i = 0; i < previewTrails.length; i++) {
        var trail = previewTrails[i];
        if (!trail || trail.isDestroyed) continue;
        
        // Lazily create grab handle when entering grab mode
        if (enabled && !trail.grabHandle) {
            attachGrabHandle(trail);
        }
        
        var handle = trail.grabHandle;
        if (handle && !handle.isDestroyed) {
            var scripts = handle.getComponents("Component.ScriptComponent");
            for (var s = 0; s < scripts.length; s++) {
                scripts[s].enabled = enabled;
            }
            var colliders = handle.getComponents("Physics.ColliderComponent");
            for (var c = 0; c < colliders.length; c++) {
                colliders[c].enabled = enabled;
            }
        }
    }
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

    bindButtonHoverState(bPreview, "Preview AR", script.btnPreview);
    bindButtonHoverState(bBrushes, "Brushes", script.btnBrushMenu);
    bindButtonHoverState(bGrab, "Grab Tool", script.btnGrab);
    bindButtonHoverState(bColors, "Colors", script.btnColors);
    bindButtonHoverState(bOrigin, "Set Origin", script.btnSetOrigin);
    bindButtonHoverState(bExport, "Export", script.btnExport);
    bindButtonHoverState(bUndo, "Undo", script.btnUndo);
    bindButtonHoverState(bHand, "Swap Hands", script.btnHandedness);

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

    // ── Brush mode callbacks ───────────────────────────────────────────────
    bGrab.onPress.add(function() {
        brushMode = "grab";
        bezierActiveCurveId = null;
        updateGrabColliders(true);
        print("[SpatialDrawer] Brush → GRAB");
    });

    bTube.onPress.add(function() {
        brushMode      = "tube";
        bezierActiveCurveId = null;
        updateGrabColliders(false);
        print("[SpatialDrawer] Brush → TUBE");
    });

    bRibbon.onPress.add(function() {
        brushMode      = "ribbon";
        bezierActiveCurveId = null;
        updateGrabColliders(false);
        print("[SpatialDrawer] Brush → RIBBON");
    });

    bPoly.onPress.add(function() {
        brushMode = "polyline";
        updateGrabColliders(false);
        print("[SpatialDrawer] Brush → POLYLINE");
    });

    bEraser.onPress.add(function() {
        brushMode      = "eraser";
        bezierActiveCurveId = null;
        updateGrabColliders(false);
        print("[SpatialDrawer] Brush → ERASER");
    });

    bExport.onPress.add(function() {
        var pos = getDrawHand().isTracked() ? getDrawHand().indexTip.position : getMenuHand().indexTip.position;
        send("export", pos, null);
        print("[SpatialDrawer] Action → EXPORT");
    });

    bPreview.onPress.add(function() {
        isPreviewEnabled = !isPreviewEnabled;
        for (var i = 0; i < previewTrails.length; i++) {
            if (previewTrails[i]) {
                previewTrails[i].enabled = isPreviewEnabled;
            }
        }
        print("[SpatialDrawer] AR Preview: " + (isPreviewEnabled ? "ON" : "OFF"));
    });

    bHand.onPress.add(function() {
        isLeftHanded = !isLeftHanded;
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
        var extras = {};

        if (brushMode === "ribbon") {
            var fwd = drawHand.indexTip.forward;
            extras.fx = fwd.x; extras.fy = fwd.y; extras.fz = fwd.z;
        }

        if (brushMode === "polyline") {
            if (!bezierActiveCurveId) {
                bezierActiveCurveId = "curve_" + userId + "_" + nowMs;
                activeCurveId = bezierActiveCurveId;
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
                }
                send("start", pos, extras);
            } else {
                activeCurveId = bezierActiveCurveId;
                send("bezier-add", pos, extras);
                if (brushMode !== "eraser" && currentBuilder && currentTrail) {
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
        
        // Start AR Preview Mesh
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
        }
        send("start", pos, extras);
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
            send("grab-end", drawHand.indexTip.position, null);
            isGrabbing = false;
            print("[SpatialDrawer] Grab END");
            return;
        }
        if (!isDrawing || brushMode === "polyline") return;
        send("end", drawHand.indexTip.position, null);
        isDrawing = false;
        currentBuilder = null; // stop mesh preview for this stroke
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

        // ── Grab streaming ───────────────────────────────────────────────
        if (isGrabbing && drawHand.isTracked()) {
            if (nowMs - lastSendTimeMs > sendIntervalMs) {
                send("grab-move", drawHand.indexTip.position, null);
                lastSendTimeMs = nowMs;
            }
            return;
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

        // Bezier Handle Move
        if (brushMode === "polyline") {
            // When pinching and moving in polyline mode, we are adjusting the curve handle!
            if (dist > DRAW_MIN_DIST) {
                send("bezier-move", pos, null);
                lastSendPos = pos;
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
