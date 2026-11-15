using System.Collections.Generic;
using UnityEngine;

// Previous attempts: every rewind of this match that finished is stored on the server as a branch (its fork tick,
// who played, how it ended). They are marked on the timeline and listed under their round, and any one can be
// watched as its own replay: GET /api/viewer/matches/:id/branches/:n rebuilds it from the original inputs up to
// the fork plus the attempt's inputs.

namespace RewindDuel
{
    public partial class DuelClient
    {
        List<object> rpBranches;
        int rpBranch;          // 0 = the original match, n = attempt n
        object rpBranchInfo;

        string AttemptLabel(object b) =>
            (Json.Str(b, "outcome") == "won" ? "WON" : "LOST") + " · " + HowRoundEnded(Json.Str(b, "reason"), Json.Str(b, "outcome") == "won");

        Color AttemptColour(object b) => Json.Str(b, "outcome") == "won" ? Gfx.Ally : Gfx.Enemy;

        /// Attempts whose fork lies in round `ri`, as (attempt number, branch).
        List<(int n, object b)> AttemptsIn(int ri)
        {
            var list = new List<(int, object)>();
            if (rpBranches == null) return list;
            for (int i = 0; i < rpBranches.Count; i++)
                if (RoundAt((float)Json.Num(rpBranches[i], "forkTick")) == ri) list.Add((i + 1, rpBranches[i]));
            return list;
        }

        /// Starts a little before the fork so the moment of the change is seen building up.
        void WatchAttempt(int n)
        {
            if (rpBranches == null || n < 1 || n > rpBranches.Count) return;
            int fork = (int)Json.Num(rpBranches[n - 1], "forkTick");
            StartCoroutine(OpenReplay(rpId, Mathf.Max(0, fork - 2 * TickRate), n));
        }

        void BackToOriginal()
        {
            int fork = (int)Json.Num(rpBranchInfo, "forkTick");
            StartCoroutine(OpenReplay(rpId, Mathf.Max(0, fork - 2 * TickRate), 0));
        }

        /// Fork marks under the timeline: a notch per attempt in its outcome's colour, the one being watched brighter.
        void DrawAttemptMarks(Rect bar, System.Func<double, float> X)
        {
            if (rpBranches == null) return;
            for (int i = 0; i < rpBranches.Count; i++)
            {
                var b = rpBranches[i];
                float x = X(Json.Num(b, "forkTick"));
                var c = AttemptColour(b);
                bool cur = rpBranch == i + 1;
                Fill(new Rect(x - 4 * S, bar.yMax + 12 * S, 8 * S, 8 * S), new Color(c.r, c.g, c.b, cur ? 1f : 0.7f));
                if (cur) Fill(new Rect(x - 1 * S, bar.y - 4 * S, 2 * S, bar.height + 16 * S), c);
            }
            // While watching an attempt, everything after its fork is the attempt: a band over the bar says so.
            if (rpBranch > 0 && rpBranchInfo != null)
            {
                float x0 = X(Json.Num(rpBranchInfo, "forkTick")), x1 = bar.xMax;
                var c = AttemptColour(rpBranchInfo);
                Fill(new Rect(x0, bar.y - 3 * S, x1 - x0, 3 * S), c);
                // Below the bar, so it never runs into the clock above it when the fork is near the end.
                Text(new Rect(x0 + 8 * S, bar.yMax + 10 * S, 200 * S, 14 * S), "ATTEMPT " + rpBranch + " FROM HERE", St(9, true, TextAnchor.MiddleLeft, true), c, false);
            }
        }

        /// The banner at the top while an attempt is being watched.
        void DrawAttemptBanner(float w, float y)
        {
            if (rpBranch == 0 || rpBranchInfo == null) return;
            var b = rpBranchInfo;
            int fork = (int)Json.Num(b, "forkTick");
            int human = (int)Json.Num(b, "human");
            string who = rpNames[Mathf.Clamp(human, 0, 1)];
            string hand = Json.IsNull(b, "handoffTick") ? "the AI never took over" : "the AI took over after " + ((Json.Num(b, "handoffTick") - fork) / TickRate).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " s";
            var r = new Rect(w / 2 - 260 * S, y, 520 * S, 26 * S);
            var c = AttemptColour(b);
            Panel(r, new Color(c.r * 0.35f, c.g * 0.35f, c.b * 0.35f, 0.9f));
            Text(r, "ATTEMPT " + rpBranch + "  ·  " + who + " from " + Clock(fork) + "  ·  " + AttemptLabel(b) + "  ·  " + hand,
                St(11, true, TextAnchor.MiddleCenter, true), Gfx.Label, false);
        }
    }
}
