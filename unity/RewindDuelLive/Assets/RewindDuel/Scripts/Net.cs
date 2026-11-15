using System;
using System.Collections.Concurrent;

// The WebSocket to the Rewind Duel server. Two implementations behind one interface:
//  - Editor and desktop builds use .NET's ClientWebSocket on background tasks. The game thread only touches
//    the two queues, so no Unity API is ever called off the main thread.
//  - WebGL builds have no .NET sockets and no threads, so they use the browser's WebSocket through
//    Plugins/WebGL/RewindSocket.jslib, polled once a frame by Pump().
// Either way the caller calls Pump() each frame and then drains Inbox.

namespace RewindDuel
{
#if UNITY_WEBGL && !UNITY_EDITOR
    public class Net : IDisposable
    {
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern int RD_Open(string url);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern int RD_State(int id);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern void RD_Send(int id, string msg);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern string RD_Recv(int id);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern string RD_Error(int id);
        [System.Runtime.InteropServices.DllImport("__Internal")] static extern void RD_Close(int id);

        int id = -1;
        bool disposed;
        readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
        public readonly ConcurrentQueue<string> Inbox = new ConcurrentQueue<string>();
        public string Error;
        public bool Open => id >= 0 && RD_State(id) == 1;

        public static Uri ToWsUri(string url) => NetUrl.ToWsUri(url);

        public void Connect(Uri uri, string firstMessage)
        {
            id = RD_Open(uri.ToString());
            Send(firstMessage);
        }

        /// Messages wait here until the socket opens, so the first `join` is never lost.
        public void Send(string msg) => outbox.Enqueue(msg);

        public void Pump()
        {
            if (disposed || id < 0) return;
            int state = RD_State(id);
            if (state == 1) while (outbox.TryDequeue(out var m)) RD_Send(id, m);
            string text;
            while ((text = RD_Recv(id)) != null) Inbox.Enqueue(text);
            if (state == 3 && Error == null) Error = RD_Error(id) ?? "closed";
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (id >= 0) RD_Close(id);
        }
    }
#else
    public class Net : IDisposable
    {
        readonly System.Net.WebSockets.ClientWebSocket ws = new System.Net.WebSockets.ClientWebSocket();
        readonly System.Threading.CancellationTokenSource cts = new System.Threading.CancellationTokenSource();
        // An async queue: the sender awaits a semaphore instead of parking a thread-pool thread in a blocking
        // wait, because a parked thread can stall the editor's domain reload (seen with BlockingCollection).
        readonly ConcurrentQueue<string> outbox = new ConcurrentQueue<string>();
        readonly System.Threading.SemaphoreSlim outboxReady = new System.Threading.SemaphoreSlim(0);
        public readonly ConcurrentQueue<string> Inbox = new ConcurrentQueue<string>();
        public volatile string Error; // set once if the connection fails or drops
        public bool Open => ws.State == System.Net.WebSockets.WebSocketState.Open;

        public static Uri ToWsUri(string url) => NetUrl.ToWsUri(url);

        public void Connect(Uri uri, string firstMessage)
        {
            System.Threading.Tasks.Task.Run(async () =>
            {
                try
                {
                    await ws.ConnectAsync(uri, cts.Token);
                    Send(firstMessage);
                    _ = System.Threading.Tasks.Task.Run(SendLoop);
                    await ReceiveLoop();
                }
                catch (Exception e)
                {
                    if (!cts.IsCancellationRequested) Error = e.Message;
                }
            });
        }

        public void Send(string msg)
        {
            outbox.Enqueue(msg);
            outboxReady.Release();
        }

        /// Nothing to do here: the background tasks fill the inbox. Kept so callers are the same on every platform.
        public void Pump() { }

        async System.Threading.Tasks.Task SendLoop()
        {
            try
            {
                // One sender keeps messages in order, which the input sequence numbers rely on.
                while (true)
                {
                    await outboxReady.WaitAsync(cts.Token);
                    if (outbox.TryDequeue(out var msg))
                        await ws.SendAsync(new ArraySegment<byte>(System.Text.Encoding.UTF8.GetBytes(msg)), System.Net.WebSockets.WebSocketMessageType.Text, true, cts.Token);
                }
            }
            catch (Exception e)
            {
                if (!cts.IsCancellationRequested) Error = e.Message;
            }
        }

        async System.Threading.Tasks.Task ReceiveLoop()
        {
            var buf = new byte[64 * 1024];
            var msg = new System.IO.MemoryStream();
            while (ws.State == System.Net.WebSockets.WebSocketState.Open)
            {
                var r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token);
                if (r.MessageType == System.Net.WebSockets.WebSocketMessageType.Close)
                {
                    Error ??= "closed";
                    return;
                }
                msg.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                // Decode the whole message at once so a character split across frames stays intact.
                Inbox.Enqueue(System.Text.Encoding.UTF8.GetString(msg.GetBuffer(), 0, (int)msg.Length));
                msg.SetLength(0);
            }
        }

        public void Dispose()
        {
            if (cts.IsCancellationRequested) return;
            cts.Cancel();
            try { ws.Abort(); } catch { /* already closed */ }
            ws.Dispose();
        }
    }
#endif

    public static class NetUrl
    {
        /// Accepts ws://, wss://, http:// or https:// (a tunnel URL pasted from the browser works).
        public static Uri ToWsUri(string url)
        {
            url = url.Trim().TrimEnd('/');
            if (url.StartsWith("https://")) url = "wss://" + url.Substring(8);
            else if (url.StartsWith("http://")) url = "ws://" + url.Substring(7);
            else if (!url.StartsWith("ws://") && !url.StartsWith("wss://")) url = "ws://" + url;
            return new Uri(url);
        }

        /// In a WebGL build: the server that served this page (its origin), so a tunnel link just works.
        public static string PageServer(string absoluteUrl)
        {
            try
            {
                var u = new Uri(absoluteUrl);
                return (u.Scheme == "https" ? "wss://" : "ws://") + u.Authority;
            }
            catch { return null; }
        }
    }
}
