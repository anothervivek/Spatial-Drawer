import bpy
import json
import threading
import time
import sys
import subprocess
import math

try:
    import websocket
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

# ─── Palette ──────────────────────────────────────────────────────────────────
COLOR_PALETTE = [
    (0.10, 0.80, 0.60),   # 0 Teal (default)
    (1.00, 0.40, 0.10),   # 1 Orange
    (0.90, 0.20, 0.30),   # 2 Red
    (0.30, 0.40, 1.00),   # 3 Blue
    (0.90, 0.85, 0.10),   # 4 Yellow
    (0.60, 0.10, 0.90),   # 5 Purple
]

# ─── Global State ─────────────────────────────────────────────────────────────
is_listening     = False
ws_app           = None
ws_thread        = None
heartbeat_thread = None
incoming_events  = []

origin_offset  = {"x": 0.0, "y": 0.0, "z": 0.0}

# Multiplayer: userId → color tuple
user_colors = {}

# Registry: curveId → {"obj": bpy.types.Object, "anchor": (x,y,z)}
curve_registry = {}
drawn_stack    = []      # list of curveIds for undo

# Active strokes: curveId → {"spline": spline, "brush_mode": str, "last_pos": tuple}
active_strokes = {}

# Grab state
grabbed_curve  = None
grabbed_offset = (0.0, 0.0, 0.0)


# ─── Helpers ──────────────────────────────────────────────────────────────────
def world_to_blender(x, y, z):
    sc = bpy.context.scene.spectacles_scale
    # Lens Studio is Y-up, Blender is Z-up. Swap Y and Z, and invert depth (-Z)
    return (
        (x - origin_offset["x"]) * sc,
        -(z - origin_offset["z"]) * sc,
        (y - origin_offset["y"]) * sc,
    )

def get_user_color(user_id):
    """Auto-assign a color from the palette for each unique user."""
    if user_id not in user_colors:
        idx = len(user_colors) % len(COLOR_PALETTE)
        user_colors[user_id] = COLOR_PALETTE[idx]
    return user_colors[user_id]

def make_material(rgb):
    mat = bpy.data.materials.new(name="SpectaclesMat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    # Ensure color shows up in default "Solid" viewport mode!
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return mat

def create_curve_object(bx, by, bz, user_id, brush_mode, curve_id):
    """Create a new Blender curve with the right settings for the brush mode."""
    sc = bpy.context.scene

    cdata = bpy.data.curves.new(name="Spec_" + curve_id[-6:], type='CURVE')
    cdata.dimensions = '3D'

    if brush_mode == "ribbon":
        cdata.extrude      = sc.spectacles_thickness * 0.5
        cdata.bevel_depth  = 0.0
    elif brush_mode == "polyline":
        cdata.bevel_depth = sc.spectacles_thickness * 0.8
    else:
        cdata.bevel_depth = sc.spectacles_thickness

    obj = bpy.data.objects.new("SpectaclesDrawing", cdata)
    bpy.context.collection.objects.link(obj)

    # ── Material (per-user for multiplayer; local color picker overrides) ──────
    color = get_user_color(user_id)
    sc_color = sc.spectacles_color
    # If the user is the "local" one, use the color picker; otherwise use palette
    color = (sc_color[0], sc_color[1], sc_color[2])  
    # For remote users coming in via multiplayer, get_user_color was already set
    # For a cleaner implementation this is handled via set-color events
    if user_id in user_colors:
        color = user_colors[user_id]
    mat = make_material(color)
    cdata.materials.append(mat)

    # ── Modifiers ─────────────────────────────────────────────────────────────
    if sc.spectacles_mirror_x:
        mod = obj.modifiers.new("Mirror", 'MIRROR')
        mod.use_axis[0] = True

    if sc.spectacles_smooth:
        mod = obj.modifiers.new("Smooth", 'SUBSURF')
        mod.levels       = 1
        mod.render_levels = 2

    # ── First spline point ────────────────────────────────────────────────────
    if brush_mode == "polyline":
        spline = cdata.splines.new('POLY')
        spline.points[0].co = (bx, by, bz, 1.0)
    else:
        spline = cdata.splines.new('BEZIER')
        bp = spline.bezier_points[0]
        bp.co                = (bx, by, bz)
        bp.handle_left_type  = 'AUTO'
        bp.handle_right_type = 'AUTO'
        bp.radius            = 1.0

    return obj, spline


# ─── Event Processor (Blender Timer) ─────────────────────────────────────────
def process_events():
    global incoming_events, active_strokes, origin_offset
    global curve_registry, drawn_stack, grabbed_curve, grabbed_offset, is_listening

    if not is_listening:
        return 0.1

    while incoming_events:
        pt         = incoming_events.pop(0)
        action     = pt.get("action", "")
        user_id    = pt.get("userId", "unknown")
        brush_mode = pt.get("brushMode", "tube")
        curve_id   = pt.get("curveId", action)  # fallback for undo/origin events

        # ── Set Origin ────────────────────────────────────────────────────────
        if action == "set-origin":
            origin_offset["x"] = pt.get("x", 0.0)
            origin_offset["y"] = pt.get("y", 0.0)
            origin_offset["z"] = pt.get("z", 0.0)
            print(f"[Spectacles] Origin set → {origin_offset}")
            continue

        # ── Undo ──────────────────────────────────────────────────────────────
        if action == "undo":
            if drawn_stack:
                cid   = drawn_stack.pop()
                entry = curve_registry.pop(cid, None)
                if entry:
                    try: bpy.data.objects.remove(entry["obj"], do_unlink=True)
                    except: pass
                active_strokes.pop(cid, None)
                print(f"[Spectacles] Undo → removed {cid[-8:]}")
            continue

        # ── Cancel Last (entered grab mode) ───────────────────────────────────
        if action == "cancel-last":
            if drawn_stack:
                cid   = drawn_stack.pop()
                entry = curve_registry.pop(cid, None)
                if entry:
                    try: bpy.data.objects.remove(entry["obj"], do_unlink=True)
                    except: pass
                active_strokes.pop(cid, None)
            print("[Spectacles] Last stroke cancelled (entering grab)")
            continue

        # ── Set Color ─────────────────────────────────────────────────────────
        if action == "set-color":
            color_idx  = pt.get("colorIdx", 0)
            color      = COLOR_PALETTE[color_idx % len(COLOR_PALETTE)]
            sc         = bpy.context.scene
            sc.spectacles_color = (color[0], color[1], color[2])
            user_colors[user_id] = color
            print(f"[Spectacles] Color → index {color_idx} = {color}")
            continue

        # ── Grab Start ────────────────────────────────────────────────────────
        if action == "grab-start":
            bx, by, bz = world_to_blender(pt.get("x", 0), pt.get("y", 0), pt.get("z", 0))
            min_dist       = float('inf')
            grabbed_curve  = None
            grabbed_offset = (0.0, 0.0, 0.0)

            for cid, entry in curve_registry.items():
                ax, ay, az = entry["anchor"]
                d = math.sqrt((ax - bx)**2 + (ay - by)**2 + (az - bz)**2)
                if d < min_dist:
                    min_dist      = d
                    grabbed_curve = entry["obj"]
                    grabbed_offset = (
                        entry["obj"].location.x - bx,
                        entry["obj"].location.y - by,
                        entry["obj"].location.z - bz,
                    )

            print(f"[Spectacles] Grab start → {grabbed_curve.name if grabbed_curve else 'none'} (dist={min_dist:.1f})")
            continue

        # ── Grab Move ─────────────────────────────────────────────────────────
        if action == "grab-move":
            if grabbed_curve:
                bx, by, bz = world_to_blender(pt.get("x", 0), pt.get("y", 0), pt.get("z", 0))
                grabbed_curve.location = (
                    bx + grabbed_offset[0],
                    by + grabbed_offset[1],
                    bz + grabbed_offset[2],
                )
            continue

        # ── Grab End ──────────────────────────────────────────────────────────
        if action == "grab-end":
            grabbed_curve  = None
            grabbed_offset = (0.0, 0.0, 0.0)
            print("[Spectacles] Grab end")
            continue

        # ── Start Stroke ──────────────────────────────────────────────────────
        if action == "start":
            bx, by, bz = world_to_blender(pt.get("x", 0), pt.get("y", 0), pt.get("z", 0))
            obj, spline = create_curve_object(bx, by, bz, user_id, brush_mode, curve_id)

            active_strokes[curve_id] = {
                "spline":     spline,
                "brush_mode": brush_mode,
                "last_pos":   (bx, by, bz),
            }
            curve_registry[curve_id] = {"obj": obj, "anchor": (bx, by, bz)}
            drawn_stack.append(curve_id)
            print(f"[Spectacles] Stroke START [{brush_mode}] user={user_id} id={curve_id[-8:]}")
            continue

        # ── Move / Add Vertex ─────────────────────────────────────────────────
        if action == "move" and curve_id in active_strokes:
            bx, by, bz  = world_to_blender(pt.get("x", 0), pt.get("y", 0), pt.get("z", 0))
            stroke      = active_strokes[curve_id]
            spline      = stroke["spline"]
            bmode       = stroke["brush_mode"]
            last_pos    = stroke["last_pos"]

            if bmode == "polyline":
                spline.points.add(1)
                idx = len(spline.points) - 1
                spline.points[idx].co = (bx, by, bz, 1.0)

            else:
                spline.bezier_points.add(1)
                idx = len(spline.bezier_points) - 1
                bp  = spline.bezier_points[idx]
                bp.co                = (bx, by, bz)
                bp.handle_left_type  = 'AUTO'
                bp.handle_right_type = 'AUTO'

                # Dynamic Thickness
                if bpy.context.scene.spectacles_dynamic_thickness:
                    dx = bx - last_pos[0]; dy = by - last_pos[1]; dz = bz - last_pos[2]
                    dist = math.sqrt(dx*dx + dy*dy + dz*dz)
                    bp.radius = max(0.1, min(2.0, 0.5 / max(0.01, dist)))
                else:
                    bp.radius = 1.0

                # Ribbon tilt — rotate cross-section to match hand orientation
                if bmode == "ribbon":
                    fx = pt.get("fx", 0.0)
                    fy = pt.get("fy", 1.0)
                    fz = pt.get("fz", 0.0)
                    bp.tilt = math.atan2(fz, fy)

            stroke["last_pos"] = (bx, by, bz)
            continue

        # ── End Stroke ────────────────────────────────────────────────────────
        if action == "end":
            if curve_id in active_strokes:
                active_strokes.pop(curve_id)
            print(f"[Spectacles] Stroke END id={curve_id[-8:]}")
            continue

    return 0.05


# ─── WebSocket ────────────────────────────────────────────────────────────────
def heartbeat(ws):
    ref = 2
    while is_listening and ws and ws.keep_running:
        time.sleep(30)
        if not is_listening: break
        try:
            ws.send(json.dumps({
                "topic": "phoenix", "event": "heartbeat",
                "payload": {}, "ref": str(ref)
            }))
            ref += 1
        except: break

def on_message(ws, message):
    try:
        data = json.loads(message)
        if data.get("event") == "broadcast":
            payload = data.get("payload", {})
            if payload.get("event") == "draw-event":
                incoming_events.append(payload.get("payload", {}))
    except Exception as e:
        print("[Spectacles] Message error:", e)

def on_error(ws, error):
    print("[Spectacles] WebSocket error:", error)

def on_close(ws, *args):
    print("[Spectacles] WebSocket closed")

def on_open(ws):
    print("[Spectacles] WebSocket connected!")
    channel = bpy.context.scene.spectacles_channel
    ws.send(json.dumps({
        "topic":   f"realtime:{channel}",
        "event":   "phx_join",
        "payload": {"config": {"broadcast": {"self": False}}},
        "ref":     "1"
    }))
    global heartbeat_thread
    heartbeat_thread = threading.Thread(target=heartbeat, args=(ws,))
    heartbeat_thread.daemon = True
    heartbeat_thread.start()

def connect_websocket():
    global ws_app
    url   = bpy.context.scene.spectacles_url.replace("https://", "wss://").replace("http://", "ws://")
    token = bpy.context.scene.spectacles_token
    ws_url = f"{url}/realtime/v1/websocket?apikey={token}&vsn=1.0.0"
    websocket.enableTrace(False)
    ws_app = websocket.WebSocketApp(
        ws_url,
        on_open=on_open, on_message=on_message,
        on_error=on_error, on_close=on_close
    )
    ws_app.run_forever()


# ─── Operators ────────────────────────────────────────────────────────────────
class SPECTACLES_OT_install_deps(bpy.types.Operator):
    bl_idname    = "spectacles.install_deps"
    bl_label     = "Install WebSocket Library"
    bl_description = "Installs websocket-client into Blender's Python"
    def execute(self, context):
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "websocket-client"])
            self.report({'INFO'}, "Installed! Please restart Blender.")
        except Exception as e:
            self.report({'ERROR'}, f"Failed: {e}")
        return {'FINISHED'}

class SPECTACLES_OT_listen(bpy.types.Operator):
    bl_idname = "spectacles.listen"
    bl_label  = "Start Listening"
    def execute(self, context):
        global is_listening, ws_thread
        if not is_listening:
            if not HAS_WEBSOCKETS:
                self.report({'ERROR'}, "Install WebSocket Library first!"); return {'CANCELLED'}
            if not context.scene.spectacles_url or not context.scene.spectacles_token:
                self.report({'ERROR'}, "Enter URL and Token first!"); return {'CANCELLED'}
            
            is_listening = True
            ws_thread = threading.Thread(target=connect_websocket)
            ws_thread.daemon = True
            ws_thread.start()
            if not bpy.app.timers.is_registered(process_events):
                bpy.app.timers.register(process_events)
            self.report({'INFO'}, "Listening started...")
        return {'FINISHED'}

class SPECTACLES_OT_stop(bpy.types.Operator):
    bl_idname = "spectacles.stop"
    bl_label  = "Stop"
    def execute(self, context):
        global is_listening, ws_app
        is_listening = False
        if ws_app: ws_app.close(); ws_app = None
        if bpy.app.timers.is_registered(process_events):
            bpy.app.timers.unregister(process_events)
        self.report({'INFO'}, "Disconnected from Snap Cloud")
        return {'FINISHED'}

class SPECTACLES_OT_undo(bpy.types.Operator):
    bl_idname = "spectacles.undo"
    bl_label  = "Undo Last Stroke"
    def execute(self, context):
        incoming_events.append({"action": "undo"})
        return {'FINISHED'}


# ─── Panel ────────────────────────────────────────────────────────────────────
class SPECTACLES_PT_panel(bpy.types.Panel):
    bl_label      = "✏️ Spatial Drawer"
    bl_idname     = "SPECTACLES_PT_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category   = 'Spectacles'

    def draw(self, context):
        layout = self.layout
        sc     = context.scene

        if not HAS_WEBSOCKETS:
            layout.operator("spectacles.install_deps", icon='PLUGIN')
            layout.label(text="Restart Blender after installing!", icon='INFO')
            return

        # ── Connection ──────────────────────────────────────────────────────
        box = layout.box()
        box.label(text="Connection", icon='URL')
        box.prop(sc, "spectacles_url")
        box.prop(sc, "spectacles_token")
        box.prop(sc, "spectacles_channel")

        # ── Brush ───────────────────────────────────────────────────────────
        box2 = layout.box()
        box2.label(text="Brush", icon='BRUSH_DATA')
        box2.prop(sc, "spectacles_scale")
        box2.prop(sc, "spectacles_thickness")
        box2.prop(sc, "spectacles_dynamic_thickness")
        box2.prop(sc, "spectacles_color")

        # ── Modifiers ───────────────────────────────────────────────────────
        box3 = layout.box()
        box3.label(text="Modifiers", icon='MOD_MIRROR')
        row = box3.row(align=True)
        row.prop(sc, "spectacles_mirror_x")
        row.prop(sc, "spectacles_smooth")

        layout.separator()

        # ── Controls ────────────────────────────────────────────────────────
        if not is_listening:
            layout.operator("spectacles.listen", icon='RADIOBUT_ON')
        else:
            layout.operator("spectacles.stop", icon='RADIOBUT_OFF')
            layout.label(text="🟢 Connected — Listening...", icon='CHECKMARK')

        layout.operator("spectacles.undo", icon='LOOP_BACK')

        # ── Multiplayer Status ───────────────────────────────────────────────
        if user_colors:
            box4 = layout.box()
            box4.label(text=f"Users Online: {len(user_colors)}", icon='COMMUNITY')
            for uid, col in user_colors.items():
                box4.label(text=f"  {uid}  ● {col}")


# ─── Registration ─────────────────────────────────────────────────────────────
classes = (
    SPECTACLES_OT_install_deps,
    SPECTACLES_OT_listen,
    SPECTACLES_OT_stop,
    SPECTACLES_OT_undo,
    SPECTACLES_PT_panel,
)

def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    bpy.types.Scene.spectacles_url = bpy.props.StringProperty(
        name="URL", description="Supabase Project URL (https://...)", default="")
    bpy.types.Scene.spectacles_token = bpy.props.StringProperty(
        name="Token", description="Supabase Public Token (Anon Key)", default="")
    bpy.types.Scene.spectacles_channel = bpy.props.StringProperty(
        name="Channel", description="Realtime channel name", default="spatial-drawer")
    bpy.types.Scene.spectacles_scale = bpy.props.FloatProperty(
        name="Scale", description="Drawing size multiplier",
        default=10.0, min=1.0, max=1000.0)
    bpy.types.Scene.spectacles_thickness = bpy.props.FloatProperty(
        name="Thickness", description="Curve bevel depth",
        default=3.0, min=0.001, max=10.0)
    bpy.types.Scene.spectacles_dynamic_thickness = bpy.props.BoolProperty(
        name="Dynamic Thickness",
        description="Thickness changes with hand speed (fast = thin, slow = thick)",
        default=False)
    bpy.types.Scene.spectacles_color = bpy.props.FloatVectorProperty(
        name="Color", subtype='COLOR',
        default=(0.1, 0.8, 0.6), min=0.0, max=1.0)
    bpy.types.Scene.spectacles_mirror_x = bpy.props.BoolProperty(
        name="Mirror X", description="Mirror strokes across the X axis", default=False)
    bpy.types.Scene.spectacles_smooth = bpy.props.BoolProperty(
        name="Auto-Smooth", description="Apply Subdivision modifier to curves", default=True)

def unregister():
    global is_listening, ws_app
    is_listening = False
    if ws_app: ws_app.close()
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
    props = [
        "spectacles_url", "spectacles_token", "spectacles_channel",
        "spectacles_scale", "spectacles_thickness", "spectacles_dynamic_thickness",
        "spectacles_color", "spectacles_mirror_x", "spectacles_smooth",
    ]
    for p in props:
        if hasattr(bpy.types.Scene, p):
            try: delattr(bpy.types.Scene, p)
            except: pass

if __name__ == "__main__":
    register()
