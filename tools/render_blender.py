#!/usr/bin/env python3
"""
Photoreal Cycles render of the body and garment exported from the app.

Run inside Blender:
  blender -b -P tools/render_blender.py -- --model cloth-on-body.glb --out renders
or with the `bpy` Python module (pip install bpy):
  python tools/render_blender.py --model cloth-on-body.glb --out renders

Use --body body.obj --garment garment.glb to render separate files. Objects named "body" (or "scan")
get the skin shader; everything else is treated as the garment and keeps the textures from the app.

The GPU is chosen automatically: OptiX/CUDA on NVIDIA (RTX), Metal on Apple silicon, else CPU.
"""
import argparse, math, os, sys

import bpy
from mathutils import Vector

FINISHES = {
    # name: (roughness, coat weight, coat roughness, sheen weight)
    "matte": (0.88, 0.0, 0.3, 0.25),
    "leather": (0.42, 0.45, 0.30, 0.0),
    "satin": (0.28, 0.0, 0.3, 1.0),
    "denim": (0.9, 0.0, 0.3, 0.15),
    "knit": (0.95, 0.0, 0.3, 0.7),
}
VIEWS = {"front": 0, "three_quarter": 35, "side": 90, "back": 180}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="GLB with garment and body (from the app's Download GLB)")
    ap.add_argument("--body", help="body OBJ/GLB (if not inside --model)")
    ap.add_argument("--garment", help="garment GLB")
    ap.add_argument("--out", default="renders")
    ap.add_argument("--views", default="front,three_quarter,side,back")
    ap.add_argument("--res", type=int, default=2048, help="image height in pixels")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--finish", default="auto", choices=["auto", "none"] + list(FINISHES))
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "gpu"])
    ap.add_argument("--turntable", type=int, default=0, help="frames for a 360 degree turntable")
    ap.add_argument("--save-blend", action="store_true")
    return ap.parse_args(argv)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_file(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path, forward_axis="Z", up_axis="Y")
    else:
        raise SystemExit(f"unsupported file {path}")
    return [o for o in bpy.data.objects if o not in before]


def principled(mat):
    mat.use_nodes = True
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def set_input(node, names, value):
    for n in names:
        if n in node.inputs:
            node.inputs[n].default_value = value
            return


def skin_material():
    mat = bpy.data.materials.new("skin")
    p = principled(mat)
    set_input(p, ["Base Color"], (0.80, 0.58, 0.46, 1))
    set_input(p, ["Roughness"], 0.5)
    set_input(p, ["Subsurface Weight", "Subsurface"], 0.35)
    set_input(p, ["Subsurface Radius"], (1.0, 0.35, 0.2))
    set_input(p, ["Subsurface Scale"], 0.01)
    set_input(p, ["Specular IOR Level", "Specular"], 0.35)
    return mat


def finish_material(mat, finish):
    p = principled(mat)
    if not p:
        return
    r, coat, coat_r, sheen = FINISHES[finish]
    set_input(p, ["Roughness"], r)
    set_input(p, ["Coat Weight", "Clearcoat"], coat)
    set_input(p, ["Coat Roughness", "Clearcoat Roughness"], coat_r)
    set_input(p, ["Sheen Weight", "Sheen"], sheen)
    set_input(p, ["Metallic"], 0.0)


def setup_device(choice):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cyc = scene.cycles
    cyc.device = "CPU"
    if choice == "cpu":
        return "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA", "METAL", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
        except Exception:
            continue
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in prefs.devices:
                d.use = d.type == kind or d.type == "CPU" and kind == "METAL"
            cyc.device = "GPU"
            return kind
    return "CPU"


def bounds(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def studio(center, height):
    world = bpy.data.worlds.new("studio")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.9, 0.89, 0.87, 1)
    bg.inputs["Strength"].default_value = 0.9
    # seamless floor
    bpy.ops.mesh.primitive_plane_add(size=40, location=(center.x, center.y, 0))
    floor = bpy.context.object
    fm = bpy.data.materials.new("floor")
    fp = principled(fm)
    set_input(fp, ["Base Color"], (0.86, 0.85, 0.83, 1))
    set_input(fp, ["Roughness"], 0.9)
    floor.data.materials.append(fm)
    floor.is_shadow_catcher = True  # the floor shows only shadows, over the seamless backdrop

    def area(name, loc, size, power, color=(1, 1, 1)):
        bpy.ops.object.light_add(type="AREA", location=loc)
        l = bpy.context.object
        l.name = name
        l.data.size = size
        l.data.energy = power
        l.data.color = color
        direction = center - Vector(loc)
        l.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    d = height * 2.2
    area("key", (-d * 0.8, -d, height * 1.4), height * 1.2, 380 * height, (1.0, 0.97, 0.93))
    area("fill", (d * 1.1, -d * 0.6, height * 0.9), height * 1.8, 120 * height, (0.92, 0.95, 1.0))
    area("rim", (d * 0.2, d * 1.1, height * 1.5), height * 1.0, 260 * height)


def add_camera(center, height, az_deg, name="cam", lens=85):
    az = math.radians(az_deg)
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.sensor_fit = "VERTICAL"
    cam_data.sensor_height = 36
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam)
    # field of view for a full-height portrait with some air around
    vfov = 2 * math.atan(36 / (2 * lens))
    dist = (height * 1.22 / 2) / math.tan(vfov / 2)
    target = Vector((center.x, center.y, height * 0.52))
    # the body faces -Y in Blender, so az=0 is the front view
    cam.location = target + Vector((math.sin(az) * dist, -math.cos(az) * dist, 0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    return cam


def main():
    a = parse()
    reset()
    objs = []
    for f in (a.model, a.body, a.garment):
        if f:
            objs += import_file(f)
    if not objs:
        raise SystemExit("give --model, or --body and/or --garment")
    skin = skin_material()
    garment_objs = []
    for o in objs:
        if o.type != "MESH":
            continue
        if o.name.lower().startswith(("body", "scan")) or (a.body and os.path.basename(a.body).split(".")[0] in o.name):
            o.data.materials.clear()
            o.data.materials.append(skin)
        else:
            garment_objs.append(o)
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.shade_smooth()
    # rest on the floor
    mn, mx = bounds(objs)
    center = (mn + mx) / 2
    height = mx.z - mn.z
    for o in objs:
        if o.parent is None:
            o.location.z -= mn.z
    bpy.context.view_layer.update()
    mn, mx = bounds(objs)
    center = (mn + mx) / 2
    height = mx.z

    # garment finish
    finish = a.finish
    if finish != "none":
        if finish == "auto":
            finish = "leather" if any("leather" in (m.name.lower()) for o in garment_objs for m in o.data.materials if m) else None
        if finish:
            for o in garment_objs:
                for m in o.data.materials:
                    if m:
                        finish_material(m, finish)

    scene = bpy.context.scene
    dev = setup_device(a.device)
    scene.cycles.samples = a.samples
    scene.cycles.use_denoising = True
    scene.cycles.use_adaptive_sampling = True
    scene.render.resolution_y = a.res
    scene.render.resolution_x = int(a.res * 0.7)
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    studio(center, height)
    os.makedirs(a.out, exist_ok=True)
    print(f"render device: {dev}; height {height:.2f} m; objects: {[o.name for o in objs]}")

    jobs = []
    if a.turntable:
        jobs = [(f"turn_{i:03d}", 360.0 * i / a.turntable) for i in range(a.turntable)]
    else:
        jobs = [(v, VIEWS[v]) for v in a.views.split(",")]
    for name, az in jobs:
        cam = add_camera(center, height, az, name)
        scene.camera = cam
        scene.render.filepath = os.path.join(a.out, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("wrote", scene.render.filepath)
    if a.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(a.out, "scene.blend"))


if __name__ == "__main__":
    main()
