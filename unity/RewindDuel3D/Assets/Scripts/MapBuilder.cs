using UnityEngine;

// Builds the static 3D world from MapData: a floor, extruded wall boxes, and translucent site markers.
// Map X,Y become world X,Z. No gameplay logic here — geometry only, driven by the exported map.json.

namespace RewindDuel
{
    public static class MapBuilder
    {
        public const float WallHeight = 3f;

        // Magnetic-tape palette, matching the 2D client and the three.js FPV.
        static readonly Color Oxide = new Color(0.29f, 0.23f, 0.18f);
        static readonly Color Bakelite = new Color(0.55f, 0.45f, 0.37f);
        static readonly Color SiteRed = new Color(0.90f, 0.28f, 0.23f);

        static Material Lit(Color c)
        {
            var sh = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            var m = new Material(sh);
            m.color = c;
            return m;
        }

        static Material Transparent(Color c, float a)
        {
            var m = Lit(new Color(c.r, c.g, c.b, a));
            // URP transparent surface setup.
            m.SetFloat("_Surface", 1f);
            m.SetFloat("_Blend", 0f);
            m.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
            m.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            m.SetInt("_ZWrite", 0);
            m.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            return m;
        }

        /// Builds floor + walls + site patches under `root`. Returns nothing; the caller owns `root`.
        public static void Build(Transform root, MapData map)
        {
            var floorMat = Lit(Oxide);
            var wallMat = Lit(Bakelite);
            var siteMat = Transparent(SiteRed, 0.22f);

            // Floor: a flat box the size of the map, centered so world coords equal map coords.
            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            floor.name = "Floor";
            floor.transform.SetParent(root, false);
            floor.transform.localScale = new Vector3(map.width, 0.1f, map.height);
            floor.transform.localPosition = new Vector3(map.width / 2f, -0.05f, map.height / 2f);
            floor.GetComponent<Renderer>().sharedMaterial = floorMat;

            // Walls: one extruded box per rect.
            var wallsRoot = new GameObject("Walls").transform;
            wallsRoot.SetParent(root, false);
            foreach (var w in map.walls)
            {
                var box = GameObject.CreatePrimitive(PrimitiveType.Cube);
                box.transform.SetParent(wallsRoot, false);
                box.transform.localScale = new Vector3(w.w, WallHeight, w.h);
                box.transform.localPosition = new Vector3(w.x + w.w / 2f, WallHeight / 2f, w.y + w.h / 2f);
                box.GetComponent<Renderer>().sharedMaterial = wallMat;
            }

            // Site markers: thin translucent slabs on the floor.
            BuildSite(root, map.sites.A, siteMat, "SiteA");
            BuildSite(root, map.sites.B, siteMat, "SiteB");
        }

        static void BuildSite(Transform root, Rect2D r, Material mat, string name)
        {
            var site = GameObject.CreatePrimitive(PrimitiveType.Cube);
            site.name = name;
            site.transform.SetParent(root, false);
            site.transform.localScale = new Vector3(r.w, 0.04f, r.h);
            site.transform.localPosition = new Vector3(r.x + r.w / 2f, 0.02f, r.y + r.h / 2f);
            var rend = site.GetComponent<Renderer>();
            rend.sharedMaterial = mat;
            // Site markers are visual only; no collider needed.
            Object.Destroy(site.GetComponent<Collider>());
        }
    }
}
