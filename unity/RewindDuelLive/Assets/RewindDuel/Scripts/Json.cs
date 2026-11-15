using System.Collections.Generic;
using System.Globalization;
using System.Text;

// A small JSON reader for the server's messages. JsonUtility cannot represent the server's `enemy: null`
// (it would build a default object at 0,0) or its tagged event union, and the project has no Newtonsoft,
// so messages are read into Dictionary / List / double / string / bool / null and picked apart by hand.

namespace RewindDuel
{
    public static class Json
    {
        public static object Parse(string s)
        {
            int i = 0;
            return Value(s, ref i);
        }

        static void Ws(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            char c = s[i];
            if (c == '{')
            {
                var d = new Dictionary<string, object>();
                i++;
                Ws(s, ref i);
                if (s[i] == '}') { i++; return d; }
                while (true)
                {
                    Ws(s, ref i);
                    string k = Str(s, ref i);
                    Ws(s, ref i);
                    i++; // ':'
                    d[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if (s[i++] == '}') return d; // otherwise ','
                }
            }
            if (c == '[')
            {
                var l = new List<object>();
                i++;
                Ws(s, ref i);
                if (s[i] == ']') { i++; return l; }
                while (true)
                {
                    l.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (s[i++] == ']') return l;
                }
            }
            if (c == '"') return Str(s, ref i);
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (s.Length - i >= 5 && string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            return double.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
        }

        static string Str(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (s[i] != '"')
            {
                char c = s[i++];
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber)); i += 4; break;
                    default: sb.Append(e); break; // \" \\ \/
                }
            }
            i++;
            return sb.ToString();
        }

        /// Quotes a string for an outgoing message.
        public static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        // Accessors that keep the message-reading code short.
        public static Dictionary<string, object> Obj(object o, string k) => (o as Dictionary<string, object>)?.TryGetValue(k, out var v) == true ? v as Dictionary<string, object> : null;
        public static List<object> Arr(object o, string k) => (o as Dictionary<string, object>)?.TryGetValue(k, out var v) == true ? v as List<object> : null;
        public static double Num(object o, string k, double dflt = 0) => (o as Dictionary<string, object>)?.TryGetValue(k, out var v) == true && v is double d ? d : dflt;
        public static string Str(object o, string k) => (o as Dictionary<string, object>)?.TryGetValue(k, out var v) == true ? v as string : null;
        public static bool Bool(object o, string k) => (o as Dictionary<string, object>)?.TryGetValue(k, out var v) == true && v is bool b && b;
        public static bool IsNull(object o, string k) => !((o as Dictionary<string, object>)?.TryGetValue(k, out var v) == true) || v == null;
    }
}
