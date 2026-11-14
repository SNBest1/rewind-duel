using System;
using UnityEngine;

// Serializable DTOs matching the JSON written by `npm run export:unity`.
// Unity's JsonUtility maps these field names 1:1, so the names must match the exporter exactly.
// Map X,Y (2D) become world X,Z; up is Y. The simulation stays 2D in Node — this is only a renderer.

namespace RewindDuel
{
    [Serializable]
    public class Rect2D
    {
        public float x;
        public float y;
        public float w;
        public float h;
    }

    [Serializable]
    public class Sites
    {
        public Rect2D A;
        public Rect2D B;
    }

    [Serializable]
    public class Spawn
    {
        public float x;
        public float y;
    }

    [Serializable]
    public class Spawns
    {
        public Spawn attacker;
        public Spawn defender;
    }

    [Serializable]
    public class MapData
    {
        public string id;
        public float width;
        public float height;
        public Rect2D[] walls;
        public Sites sites;
        public Spawns spawns;
    }

    [Serializable]
    public class Smoke
    {
        public float x;
        public float y;
        public float r;
    }

    [Serializable]
    public class Frame
    {
        public int tick;
        public int round;
        public string phase;
        public float p0x, p0y, p0aim, p0hp;
        public int p0move;
        public float p1x, p1y, p1aim, p1hp;
        public int p1move;
        public string spikeState;
        public float spikeX, spikeY;
        public Smoke[] smokes;
    }

    [Serializable]
    public class PlayerInfo
    {
        public int slot;
        public string name;
    }

    [Serializable]
    public class MatchData
    {
        public string id;
        public string map;
        public PlayerInfo[] players;
        public int ticks;
        public int tickRate;
        public Frame[] frames;
    }
}
