using System.Collections.Generic;
using UnityEngine;

// What the server says the game contains: maps (with full geometry), difficulties, ranks, the armory and
// shields. Read from GET /api/catalog and from the `mapData` field of a `start` message. Nothing here is
// hardcoded in C#, so the Unity client always matches the server it talks to.

namespace RewindDuel
{
    public class SiteDef { public string label; public Rect2 rect; }
    public class TeleporterDef { public Rect2 pad; public double exitX, exitY; }

    public class MapDef
    {
        public string id, name, blurb;
        public double width, height;
        public readonly List<Rect2> walls = new List<Rect2>();
        public readonly List<SiteDef> sites = new List<SiteDef>();
        public readonly List<TeleporterDef> teleporters = new List<TeleporterDef>();
        public double atkX, atkY, defX, defY;

        static Rect2 R(object o) => new Rect2 { x = Json.Num(o, "x"), y = Json.Num(o, "y"), w = Json.Num(o, "w"), h = Json.Num(o, "h") };

        public static MapDef Parse(object o)
        {
            var m = new MapDef
            {
                id = Json.Str(o, "id"),
                name = Json.Str(o, "name") ?? Json.Str(o, "id"),
                blurb = Json.Str(o, "blurb") ?? "",
                width = Json.Num(o, "width"),
                height = Json.Num(o, "height"),
            };
            foreach (var w in Json.Arr(o, "walls")) m.walls.Add(R(w));
            var sites = Json.Obj(o, "sites");
            if (sites != null) foreach (var kv in sites) m.sites.Add(new SiteDef { label = kv.Key, rect = R(kv.Value) });
            m.sites.Sort((a, b) => string.CompareOrdinal(a.label, b.label));
            var tps = Json.Arr(o, "teleporters");
            if (tps != null)
                foreach (var t in tps)
                {
                    var exit = Json.Obj(t, "exit");
                    m.teleporters.Add(new TeleporterDef { pad = R(Json.Obj(t, "pad")), exitX = Json.Num(exit, "x"), exitY = Json.Num(exit, "y") });
                }
            var sp = Json.Obj(o, "spawns");
            if (sp != null)
            {
                m.atkX = Json.Num(Json.Obj(sp, "attacker"), "x"); m.atkY = Json.Num(Json.Obj(sp, "attacker"), "y");
                m.defX = Json.Num(Json.Obj(sp, "defender"), "x"); m.defY = Json.Num(Json.Obj(sp, "defender"), "y");
            }
            return m;
        }

        public SiteDef SiteAt(double x, double y)
        {
            foreach (var s in sites)
                if (x >= s.rect.x && x <= s.rect.x + s.rect.w && y >= s.rect.y && y <= s.rect.y + s.rect.h) return s;
            return null;
        }
    }

    public class WeaponDef
    {
        public int id, price, mag, pellets, reload, cooldown100;
        public string name, cls, kind, blurb;
        public bool silenced;
        public float[] spread = { 1, 4, 10 };
        public float bloom, bloomCap;
    }

    public class ShieldDef { public int id, amount, price; public string name; }
    public class RankDef { public int index; public string label; public Color color; }

    public class Catalog
    {
        public readonly List<MapDef> maps = new List<MapDef>();
        public readonly List<string> difficulties = new List<string>();
        public readonly List<RankDef> ranks = new List<RankDef>();
        public readonly Dictionary<int, WeaponDef> weapons = new Dictionary<int, WeaponDef>();
        public readonly List<ShieldDef> shields = new List<ShieldDef>();
        public int buyTicks = 128, roundTicks = 1920, tickRate = 32;

        public static Color Hex(string hex, Color fallback)
        {
            return hex != null && ColorUtility.TryParseHtmlString(hex, out var c) ? c : fallback;
        }

        public static Catalog Parse(object o)
        {
            var c = new Catalog
            {
                buyTicks = (int)Json.Num(o, "buyTicks", 128),
                roundTicks = (int)Json.Num(o, "roundTicks", 1920),
                tickRate = (int)Json.Num(o, "tickRate", 32),
            };
            foreach (var m in Json.Arr(o, "maps")) c.maps.Add(MapDef.Parse(m));
            foreach (var d in Json.Arr(o, "difficulties")) c.difficulties.Add(d as string);
            foreach (var r in Json.Arr(o, "ranks"))
                c.ranks.Add(new RankDef { index = (int)Json.Num(r, "index"), label = Json.Str(r, "label"), color = Hex(Json.Str(r, "color"), Color.white) });
            foreach (var w in Json.Arr(o, "weapons"))
            {
                var def = new WeaponDef
                {
                    id = (int)Json.Num(w, "id"), name = Json.Str(w, "name"), cls = Json.Str(w, "cls"), kind = Json.Str(w, "kind"),
                    blurb = Json.Str(w, "blurb") ?? "", price = (int)Json.Num(w, "price"), mag = (int)Json.Num(w, "mag"),
                    pellets = (int)Json.Num(w, "pellets", 1), reload = (int)Json.Num(w, "reload"), cooldown100 = (int)Json.Num(w, "cooldown100"),
                    silenced = Json.Bool(w, "silenced"), bloom = (float)Json.Num(w, "bloom"), bloomCap = (float)Json.Num(w, "bloomCap"),
                };
                var sp = Json.Arr(w, "spread");
                if (sp != null && sp.Count == 3) def.spread = new[] { (float)(double)sp[0], (float)(double)sp[1], (float)(double)sp[2] };
                c.weapons[def.id] = def;
            }
            foreach (var s in Json.Arr(o, "shields"))
                c.shields.Add(new ShieldDef { id = (int)Json.Num(s, "id"), name = Json.Str(s, "name"), amount = (int)Json.Num(s, "amount"), price = (int)Json.Num(s, "price") });
            return c;
        }

        public MapDef Map(string id) => maps.Find(m => m.id == id);
        public WeaponDef Weapon(int id) => weapons.TryGetValue(id, out var w) ? w : null;
        public string WeaponName(int id) => Weapon(id)?.name ?? (id < 0 ? "Unarmed" : "Gun");
    }
}
