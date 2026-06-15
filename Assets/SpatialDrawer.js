// ─── Inputs ───────────────────────────────────────────────────────────────────
// @input Asset.SupabaseProject supabaseProject {"hint": "Drag your SupabaseProject asset here"}
// @input string channelName = "spatial-drawer"

// ─── Spatial reference objects ────────────────────────────────────────────────
// @input SceneObject originGizmo {"hint": "Small cube that snaps to your origin"}
// @input SceneObject gridPlane {"hint": "Floor reference grid"}

// ─── Radial Menu Button Visuals (create simple planes/cubes in Lens Studio) ──
// @input SceneObject btnTube {"hint": "Button visual for Tube brush"}
// @input SceneObject btnRibbon {"hint": "Button visual for Ribbon brush"}
// @input SceneObject btnPoly {"hint": "Button visual for Polyline brush"}
// @input SceneObject btnSetOrigin {"hint": "Button visual for Set Origin"}
// @input SceneObject btnUndo {"hint": "Button visual for Undo"}
// @input SceneObject btnColors {"hint": "Button visual for Colors (parent)"}
// @input SceneObject btnColor1 {"hint": "Sub-button: Color 1 (Teal)"}
// @input SceneObject btnColor2 {"hint": "Sub-button: Color 2 (Orange)"}
// @input SceneObject btnColor3 {"hint": "Sub-button: Color 3 (Red)"}
// @input SceneObject btnColor4 {"hint": "Sub-button: Color 4 (Blue)"}

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

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY & STATE
// ─────────────────────────────────────────────────────────────────────────────
var userId    = "user_" + Math.random().toString(36).substr(2, 6);
var brushMode = "tube";   // "tube" | "ribbon" | "polyline"

var isConnected    = false;
var client         = null;
var realtimeChannel = null;

var isDrawing      = false;
var isGrabbing     = false;
var polylineActive = false;
var activeCurveId  = "";

var lastSendTimeMs   = 0;
var sendIntervalMs   = 80;
var lastRightPinchMs = 0;
var pinchHoldTimer   = 0;
var GRAB_HOLD_SEC    = 1.0;
var lastGrabPos      = null;

// Left hand pinch state (for feeding to radial menu)
var leftPinching       = false;
var lastLeftPinchMs    = 0;

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
    // Check that the global is available (LSQuickScripts + Spectacles Radial Menu loaded)
    if (!global.SpectaclesRadialMenu) {
        print("[SpatialDrawer] SpectaclesRadialMenu not found! Make sure LSQuickScripts and Spectacles Radial Menu.js are both added as scripts.");
        return;
    }

    radialMenu = new global.SpectaclesRadialMenu.Create();
    radialMenu.radius     = 7;    // ring radius in cm
    radialMenu.buttonSize = 3.5;  // button visual size

    // ── Main ring buttons ──────────────────────────────────────────────────
    var bTube    = radialMenu.addButton(getOrCreateButton(script.btnTube, "tube"),      "tube");
    var bRibbon  = radialMenu.addButton(getOrCreateButton(script.btnRibbon, "ribbon"),    "ribbon");
    var bPoly    = radialMenu.addButton(getOrCreateButton(script.btnPoly, "poly"),      "poly");
    var bColors  = radialMenu.addButton(getOrCreateButton(script.btnColors, "colors"),    "colors");
    var bOrigin  = radialMenu.addButton(getOrCreateButton(script.btnSetOrigin, "origin"), "origin");
    var bUndo    = radialMenu.addButton(getOrCreateButton(script.btnUndo, "undo"),      "undo");

    // ── Color sub-buttons (appear when 'Colors' is highlighted) ───────────
    radialMenu.addSubButton("colors", getOrCreateButton(script.btnColor1, "teal"),   "color1");
    radialMenu.addSubButton("colors", getOrCreateButton(script.btnColor2, "orange"), "color2");
    radialMenu.addSubButton("colors", getOrCreateButton(script.btnColor3, "red"),    "color3");
    radialMenu.addSubButton("colors", getOrCreateButton(script.btnColor4, "blue"),   "color4");

    // ── Brush mode callbacks ───────────────────────────────────────────────
    bTube.onPress.add(function() {
        brushMode      = "tube";
        polylineActive = false;
        print("[SpatialDrawer] Brush → TUBE");
    });

    bRibbon.onPress.add(function() {
        brushMode      = "ribbon";
        polylineActive = false;
        print("[SpatialDrawer] Brush → RIBBON");
    });

    bPoly.onPress.add(function() {
        brushMode = "polyline";
        print("[SpatialDrawer] Brush → POLYLINE");
    });

    // ── Set Origin callback ────────────────────────────────────────────────
    bOrigin.onPressAndClosed.add(function() {
        var pos = leftHand.isTracked() ? leftHand.indexTip.position : rightHand.indexTip.position;
        print("[SpatialDrawer] Origin SET");
        if (script.originGizmo) script.originGizmo.getTransform().setWorldPosition(pos);
        if (script.gridPlane)   script.gridPlane.getTransform().setWorldPosition(pos);
        send("set-origin", pos, null);
    });

    // ── Undo callback ──────────────────────────────────────────────────────
    bUndo.onPressAndClosed.add(function() {
        send("undo", leftHand.indexTip.position, null);
        print("[SpatialDrawer] UNDO");
    });

    // ── Color callbacks ────────────────────────────────────────────────────
    var colorBtns = radialMenu.getAllButtons();
    var colorMap = { "color1": 0, "color2": 1, "color3": 2, "color4": 3 };
    for (var name in colorMap) {
        (function(colorIdx) {
            var btn = radialMenu.getAllButtons()[name];
            if (btn) {
                btn.onPressAndClosed.add(function() {
                    send("set-color", leftHand.indexTip.position, { colorIdx: colorIdx });
                    print("[SpatialDrawer] Color → " + colorIdx);
                });
            }
        })(colorMap[name]);
    }

    radialMenu.build();
    print("[SpatialDrawer] ✅ Radial Menu ready! Left pinch to open.");
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
// RIGHT HAND — DRAW / GRAB
// ─────────────────────────────────────────────────────────────────────────────
function onRightPinchDown() {
    try {
        if (!rightHand.isTracked()) return;

        var nowMs = getTime() * 1000;
        var pos   = rightHand.indexTip.position;

        // Polyline: double-pinch = close current line
        if (brushMode === "polyline" && polylineActive && (nowMs - lastRightPinchMs < 400)) {
            send("end", pos, null);
            polylineActive = false;
            isDrawing = false;
            print("[SpatialDrawer] Polyline CLOSED");
            lastRightPinchMs = nowMs;
            return;
        }
        lastRightPinchMs = nowMs;

        if (brushMode === "polyline" && polylineActive) {
            // Keep the existing activeCurveId for the ongoing polyline
        } else {
            activeCurveId  = userId + "_" + Date.now();
        }
        
        pinchHoldTimer = 0;
        isDrawing      = true;
        isGrabbing     = false;
        lastGrabPos    = pos;

        var extras = {};
        if (brushMode === "ribbon") {
            var fwd = rightHand.indexTip.forward;
            extras.fx = fwd.x; extras.fy = fwd.y; extras.fz = fwd.z;
        }

        if (brushMode === "polyline") {
            if (!polylineActive) {
                send("start", pos, extras);
                polylineActive = true;
                print("[SpatialDrawer] Polyline START");
            } else {
                send("move", pos, extras);
            }
            isDrawing = false;
        } else {
            send("start", pos, extras);
            lastSendTimeMs = nowMs;
            print("[SpatialDrawer] Draw START [" + brushMode + "]");
        }
    } catch (e) {
        print("[SpatialDrawer] onRightPinchDown error: " + e);
    }
}

function onRightPinchUp() {
    try {
        if (isGrabbing) {
            send("grab-end", rightHand.indexTip.position, null);
            isGrabbing = false;
            print("[SpatialDrawer] Grab END");
            return;
        }
        if (!isDrawing || brushMode === "polyline") return;
        send("end", rightHand.indexTip.position, null);
        isDrawing = false;
        print("[SpatialDrawer] Draw END");
    } catch (e) {
        print("[SpatialDrawer] onRightPinchUp error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEFT HAND — RADIAL MENU + QUICK UNDO
// ─────────────────────────────────────────────────────────────────────────────
function onLeftPinchDown() {
    try {
        if (!leftHand.isTracked()) return;
        var nowMs = getTime() * 1000;

        // Double-pinch = quick undo shortcut (menu won't be open yet)
        if (nowMs - lastLeftPinchMs < 350) {
            print("[SpatialDrawer] Quick UNDO (double-pinch)");
            send("undo", leftHand.indexTip.position, null);
            lastLeftPinchMs = nowMs;
            return;
        }
        lastLeftPinchMs = nowMs;

        // Single pinch = open radial menu
        leftPinching = true;
        if (radialMenu) {
            var headPos = (cameraProvider && typeof cameraProvider.getTransform === 'function') ? cameraProvider.getTransform().getWorldPosition() : null;
            radialMenu.onPinchStart(leftHand.indexTip.position, headPos);
        }
    } catch (e) {
        print("[SpatialDrawer] onLeftPinchDown error: " + e);
    }
}

function onLeftPinchUp() {
    try {
        leftPinching = false;
        if (radialMenu) radialMenu.onPinchEnd();
    } catch (e) {
        print("[SpatialDrawer] onLeftPinchUp error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE LOOP
// ─────────────────────────────────────────────────────────────────────────────
function onUpdate() {
    var dt    = getDeltaTime();
    var nowMs = getTime() * 1000;

    try {
        // ── Feed radial menu hold position ───────────────────────────────
        if (leftPinching && leftHand.isTracked() && radialMenu) {
            radialMenu.onPinchHold(leftHand.indexTip.position);
        }

        // ── Grab: hold right pinch for 1s ────────────────────────────────
        if (isDrawing && !isGrabbing && brushMode !== "polyline" && rightHand.isTracked()) {
            var currentPos = rightHand.indexTip.position;
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
        if (isGrabbing && rightHand.isTracked()) {
            if (nowMs - lastSendTimeMs > sendIntervalMs) {
                send("grab-move", rightHand.indexTip.position, null);
                lastSendTimeMs = nowMs;
            }
            return;
        }

        // ── Draw streaming ───────────────────────────────────────────────
        if (!isDrawing || !rightHand.isTracked() || brushMode === "polyline") return;
        if (nowMs - lastSendTimeMs > sendIntervalMs) {
            var extras = {};
            if (brushMode === "ribbon") {
                var fwd = rightHand.indexTip.forward;
                extras.fx = fwd.x; extras.fy = fwd.y; extras.fz = fwd.z;
            }
            send("move", rightHand.indexTip.position, extras);
            lastSendTimeMs = nowMs;
        }

    } catch (e) {
        print("[SpatialDrawer] onUpdate error: " + e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BINDINGS
// ─────────────────────────────────────────────────────────────────────────────
rightHand.onPinchDown.add(onRightPinchDown);
rightHand.onPinchUp.add(onRightPinchUp);
leftHand.onPinchDown.add(onLeftPinchDown);
leftHand.onPinchUp.add(onLeftPinchUp);
script.createEvent("UpdateEvent").bind(onUpdate);

script.createEvent("OnStartEvent").bind(function() {
    buildRadialMenu();
    connectToSnapCloud();
    print("[SpatialDrawer] Initialized. Left pinch = menu, Right pinch = draw");
});
