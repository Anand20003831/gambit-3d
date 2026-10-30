# Blender batch converter: FBX/OBJ -> GLB.
#
# Run headless:
#   blender --background --factory-startup --python scripts/lib/fbx_to_glb.py -- \
#       --out <dir> --scale 1.0 <input files...>
#
# Each input becomes one .glb containing a single merged object, re-origined so
# its base sits at y = 0 and it is centred on X/Z. That is the convention the
# renderer expects, and doing it here means the runtime never has to guess.

import os
import sys

import bpy


def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    out_dir = "."
    scale = 1.0
    inputs = []

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--out":
            out_dir = argv[i + 1]
            i += 2
        elif arg == "--scale":
            scale = float(argv[i + 1])
            i += 2
        else:
            inputs.append(arg)
            i += 1

    return out_dir, scale, inputs


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        # Blender 4+/5 uses the new OBJ importer.
        bpy.ops.wm.obj_import(filepath=path)
    elif ext in (".gltf", ".glb"):
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise RuntimeError("unsupported input: " + path)


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def normalise(scale):
    """Merges every mesh, drops the base to y=0, and centres it on X/Z."""
    meshes = mesh_objects()
    if not meshes:
        return None

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    if len(meshes) > 1:
        bpy.ops.object.join()

    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Blender is Z-up; the glTF exporter converts to Y-up on the way out, so we
    # work out the offsets in Blender space and let the exporter handle the swap.
    coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
    if not coords:
        return None

    min_x = min(c.x for c in coords)
    max_x = max(c.x for c in coords)
    min_y = min(c.y for c in coords)
    max_y = max(c.y for c in coords)
    min_z = min(c.z for c in coords)

    centre_x = (min_x + max_x) / 2.0
    centre_y = (min_y + max_y) / 2.0

    for v in obj.data.vertices:
        v.co.x -= centre_x
        v.co.y -= centre_y
        v.co.z -= min_z

    if scale != 1.0:
        obj.scale = (scale, scale, scale)
        bpy.ops.object.transform_apply(scale=True)

    return obj


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=False,
        use_selection=False,
    )


def main():
    out_dir, scale, inputs = parse_args(sys.argv)
    os.makedirs(out_dir, exist_ok=True)

    ok = 0
    failed = 0

    for path in inputs:
        name = os.path.splitext(os.path.basename(path))[0]
        dest = os.path.join(out_dir, name + ".glb")
        try:
            clear_scene()
            import_file(path)
            obj = normalise(scale)
            if obj is None:
                raise RuntimeError("no mesh data after import")
            export_glb(dest)
            size = os.path.getsize(dest)
            print("CONVERT_OK %s -> %s (%d bytes)" % (name, dest, size))
            ok += 1
        except Exception as error:  # noqa: BLE001 - report and keep going
            print("CONVERT_FAIL %s: %s" % (name, error))
            failed += 1

    print("CONVERT_SUMMARY ok=%d failed=%d" % (ok, failed))


main()
