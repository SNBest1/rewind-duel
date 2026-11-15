// The browser's WebSocket for the WebGL build of the Rewind Duel client. WebGL has no .NET sockets and no
// threads, so Net.cs calls these from the game loop: open, send, and poll one received message at a time.
mergeInto(LibraryManager.library, {
  RD_Open: function (urlPtr) {
    var url = UTF8ToString(urlPtr);
    if (!window.__rd) window.__rd = { next: 1, socks: {} };
    var id = window.__rd.next++;
    var s = { inbox: [], state: 0, error: null, ws: null };
    try {
      s.ws = new WebSocket(url);
    } catch (e) {
      s.state = 3;
      s.error = 'could not open ' + url;
    }
    if (s.ws) {
      s.ws.onopen = function () { s.state = 1; };
      s.ws.onmessage = function (m) { if (typeof m.data === 'string') s.inbox.push(m.data); };
      s.ws.onerror = function () { if (!s.error) s.error = 'connection error'; };
      s.ws.onclose = function () { s.state = 3; if (!s.error) s.error = 'closed'; };
    }
    window.__rd.socks[id] = s;
    return id;
  },

  // 0 connecting, 1 open, 3 closed.
  RD_State: function (id) {
    var s = window.__rd && window.__rd.socks[id];
    return s ? s.state : 3;
  },

  RD_Send: function (id, msgPtr) {
    var s = window.__rd && window.__rd.socks[id];
    if (s && s.ws && s.ws.readyState === 1) s.ws.send(UTF8ToString(msgPtr));
  },

  // The next received message, or null. The string is allocated here and freed by Unity's marshalling.
  RD_Recv: function (id) {
    var s = window.__rd && window.__rd.socks[id];
    if (!s || !s.inbox.length) return null;
    var str = s.inbox.shift();
    var size = lengthBytesUTF8(str) + 1;
    var buf = _malloc(size);
    stringToUTF8(str, buf, size);
    return buf;
  },

  RD_Error: function (id) {
    var s = window.__rd && window.__rd.socks[id];
    if (!s || !s.error) return null;
    var size = lengthBytesUTF8(s.error) + 1;
    var buf = _malloc(size);
    stringToUTF8(s.error, buf, size);
    return buf;
  },

  RD_Close: function (id) {
    var s = window.__rd && window.__rd.socks[id];
    if (!s) return;
    try { if (s.ws) s.ws.close(); } catch (e) {}
    delete window.__rd.socks[id];
  },
});
