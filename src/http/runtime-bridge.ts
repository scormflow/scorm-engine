/**
 * Server-delivered SCORM runtime for the SDK-less embed flow.
 *
 * {@link renderRuntimeBridge} returns a self-contained browser script (no
 * imports) that exposes `window.API` (SCORM 1.2) and `window.API_1484_11`
 * (SCORM 2004), backed by an in-memory CMI model and syncing to the engine over
 * fetch with an attempt token. It mirrors the `@scormflow/player` bridge but is
 * dependency-free so it can be dropped into any page via `<script>`.
 *
 * {@link renderPlayerPage} returns a full HTML page that hydrates the runtime
 * server-side (so the API is synchronously ready), sets the auth cookie for
 * engine-hosted content, and embeds the SCO in an iframe.
 *
 * Both can opt in to session-replay capture (`config.replay`): tab visibility,
 * idle stretches, media playback, navigation and (optionally) pointer positions
 * inside same-origin content, batched to `POST /attempts/:id/replay/events`.
 */

/** Opt-in session-replay capture settings for the bridge. */
export interface BridgeReplayConfig {
  /** Record where the learner clicks in the content (x / y relative to its viewport). */
  pointer?: boolean;
  /** No input for this long records `idle.start`; `0` turns idle tracking off. Default 60 000. */
  idleMs?: number;
  /** How often buffered events are sent. Default 5 000. */
  flushMs?: number;
}

/** What the bridge reads from `window.__SCORMFLOW__`. */
export interface BridgeConfig {
  apiBase: string;
  attemptId: string;
  token: string;
  version: string;
  /** Server-hydrated CMI snapshot so GetValue works before the first fetch. */
  cmi: Record<string, unknown>;
  /** Present only when the host opted in to capture. */
  replay?: BridgeReplayConfig;
}

export interface PlayerPageOptions extends BridgeConfig {
  /** Resolved SCO content URL (engine-hosted or external). */
  contentUrl: string;
  theme: 'light' | 'dark' | 'auto';
}

/**
 * Inline `window.__SCORMFLOW__ = …;` statement. JSON is embedded in a script,
 * so `<` is escaped to keep it from closing the tag.
 */
export function renderBridgeConfig(config: BridgeConfig): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `window.__SCORMFLOW__ = ${json};`;
}

/** The standalone runtime bridge script (served at `/runtime.js`). */
export function renderRuntimeBridge(): string {
  // NOTE: kept as a single IIFE string so it can be served verbatim with a long
  // cache lifetime. Config is read from window.__SCORMFLOW__.
  return `/* @scormflow/runtime bridge — clean-room SCORM 1.2 + 2004 API */
(function () {
  "use strict";
  var cfg = window.__SCORMFLOW__ || {};
  var apiBase = (cfg.apiBase || "").replace(/\\/+$/, "");
  var attemptId = cfg.attemptId;
  var token = cfg.token;
  var is2004 = cfg.version && cfg.version !== "SCORM_1_2";
  var AUTO_COMMIT_MS = typeof cfg.autoCommitMs === "number" ? cfg.autoCommitMs : 10000;
  var LOCATION_KEY = is2004 ? "cmi.location" : "cmi.core.lesson_location";
  var capture = replayCapture(cfg.replay);

  var data = {};
  var dirty = {};
  (function seed(init) { if (!init) return; for (var k in init) if (init[k] != null) data[k] = String(init[k]); })(cfg.cmi);

  var phase = "not_initialized";
  var lastError = "0";
  var timer = null;
  var flushing = false;
  var reflush = false;

  function count(prefix) {
    var needle = prefix + ".", max = -1;
    for (var k in data) {
      if (k.indexOf(needle) !== 0) continue;
      var rest = k.slice(needle.length), dot = rest.indexOf(".");
      var idx = parseInt(dot === -1 ? rest : rest.slice(0, dot), 10);
      if (!isNaN(idx) && idx > max) max = idx;
    }
    return max + 1;
  }

  function drain() { var out = dirty; dirty = {}; return out; }
  function hasDirty() { for (var k in dirty) return true; return false; }

  function send(values, terminate) {
    return fetch(apiBase + "/attempts/" + encodeURIComponent(attemptId) + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ values: values, terminate: !!terminate }),
      keepalive: true
    });
  }

  function commit() {
    if (phase === "terminated") return;
    if (flushing) { reflush = true; return; }
    if (!hasDirty()) return;
    if (timer) { clearTimeout(timer); timer = null; }
    flushing = true;
    send(drain(), false).catch(function () {}).then(function () {
      flushing = false;
      if (reflush) { reflush = false; commit(); }
    });
  }

  function scheduleCommit() {
    if (AUTO_COMMIT_MS <= 0 || phase === "terminated") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; commit(); }, AUTO_COMMIT_MS);
  }

  function terminate() {
    if (phase === "terminated") return;
    phase = "terminated";
    if (timer) { clearTimeout(timer); timer = null; }
    send(drain(), true).catch(function () {});
    capture.stop();
  }

  function get(el) {
    if (el === "cmi._version") return "1.0";
    if (el.slice(-7) === "._count") return String(count(el.slice(0, -7)));
    return data.hasOwnProperty(el) ? data[el] : "";
  }
  function set(el, val) {
    // Commits only arrive every few seconds; record the move when it happens.
    if (el === LOCATION_KEY && String(val) !== "" && String(val) !== data[el]) capture.navigate(String(val));
    data[el] = String(val); dirty[el] = String(val); scheduleCommit();
  }

  // Error codes differ per edition; the bridge only reports lifecycle/keyword
  // errors — the engine is authoritative on value validation at commit time.
  var E = is2004
    ? { arg: "201", already: "103", term: "104", getBefore: "122", getAfter: "123", setBefore: "132", setAfter: "133", commitBefore: "142", commitAfter: "143", termBefore: "112", termAfter: "113", ro: "404" }
    : { arg: "201", already: "101", notInit: "301", ro: "403", keyword: "402" };

  function ok(v) { lastError = "0"; return v === undefined ? "true" : v; }
  function fail(c) { lastError = c; return "false"; }

  function initialize(p) {
    if (p !== "") return fail(E.arg);
    if (phase === "running") return fail(is2004 ? E.already : E.already);
    if (phase === "terminated") return fail(is2004 ? E.term : E.already);
    phase = "running"; return ok();
  }
  function finish(p) {
    if (p !== "") return fail(E.arg);
    if (is2004) {
      if (phase === "not_initialized") return fail(E.termBefore);
      if (phase === "terminated") return fail(E.termAfter);
    } else if (phase !== "running") return fail(E.notInit);
    terminate(); return ok();
  }
  function getValue(el) {
    if (phase === "not_initialized") { lastError = is2004 ? E.getBefore : E.notInit; return ""; }
    if (phase === "terminated") { lastError = is2004 ? E.getAfter : E.notInit; return ""; }
    return ok(get(el));
  }
  function setValue(el, val) {
    if (phase === "not_initialized") return fail(is2004 ? E.setBefore : E.notInit);
    if (phase === "terminated") return fail(is2004 ? E.setAfter : E.notInit);
    if (el.slice(-7) === "._count" || el.slice(-10) === "._children" || el === "cmi._version") return fail(E.ro);
    set(el, val); return ok();
  }
  function doCommit(p) {
    if (p !== "") return fail(E.arg);
    if (phase === "not_initialized") return fail(is2004 ? E.commitBefore : E.notInit);
    if (phase === "terminated") return fail(is2004 ? E.commitAfter : E.notInit);
    commit(); return ok();
  }
  function getLastError() { return lastError; }
  function getErrorString() { return ""; }
  function getDiagnostic() { return ""; }

  // ── Opt-in session replay capture ─────────────────────────────────────
  // Mirrors @scormflow/player's attachReplayCapture. Keystrokes and typed text
  // are never recorded — key presses only count as activity. Every event has a
  // client id, so a re-sent batch is stored once.
  function replayCapture(rc) {
    var noop = { navigate: function () {}, stop: function () {} };
    if (!rc || rc.enabled === false || !attemptId || !token || typeof fetch !== "function") return noop;
    var IDLE_MS = typeof rc.idleMs === "number" ? rc.idleMs : 60000;
    var FLUSH_MS = typeof rc.flushMs === "number" ? rc.flushMs : 5000;
    var BATCH = 100, KEEPALIVE_BATCH = 50, MAX_BUFFERED = 1000, THROTTLE_MS = 1000;
    var ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
    var MEDIA = { play: "media.play", pause: "media.pause", ended: "media.ended" };
    var doc = window.document;
    var buf = [], off = false, stopped = false, sending = false, seq = 0;
    var prefix = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    var idle = false, idleTimer = null, lastReset = 0, unbindContent = [];

    function record(type, location, data) {
      if (off || stopped) return;
      var e = { id: prefix + "-" + (seq++).toString(36), type: type, at: new Date().toISOString() };
      if (location) e.location = location.slice(0, 255);
      if (data) e.data = data;
      buf.push(e);
      if (buf.length > MAX_BUFFERED) buf.splice(0, buf.length - MAX_BUFFERED);
      if (buf.length >= BATCH) flush(false);
    }
    function flush(keepalive) {
      if (off || !buf.length || (sending && !keepalive)) return;
      // A one-off keepalive flush (tab hidden / closing) doesn't wait for the
      // in-flight send — ids make the overlap harmless. Once stopped, sends
      // chain until the buffer is drained, with keepalive in case the page is
      // unloading.
      var chained = !keepalive || stopped;
      var batch = buf.slice(0, keepalive ? KEEPALIVE_BATCH : BATCH);
      if (chained) sending = true;
      fetch(apiBase + "/attempts/" + encodeURIComponent(attemptId) + "/replay/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ events: batch }),
        keepalive: !!keepalive
      }).then(function (res) {
        // 403: capture is off on this engine. 400: the batch will never be accepted.
        if (res.status === 403) { off = true; buf = []; stopTimers(); return false; }
        if (!res.ok && res.status !== 400) return false;
        buf = buf.filter(function (e) { return batch.indexOf(e) === -1; });
        return true;
      }, function () { return false; }).then(function (progressed) {
        if (!chained) return;
        sending = false;
        if (progressed && (buf.length >= BATCH || (stopped && buf.length))) flush(stopped);
      });
    }

    function listen(target, type, fn, out) {
      var opts = { capture: true };
      target.addEventListener(type, fn, opts);
      out.push(function () { target.removeEventListener(type, fn, opts); });
    }
    var host = [];

    var hidden = doc && doc.visibilityState === "hidden";
    if (doc) listen(doc, "visibilitychange", function () {
      var now = doc.visibilityState === "hidden";
      if (now === hidden) return;
      hidden = now;
      record(now ? "page.hidden" : "page.visible");
      if (now) flush(true);
    }, host);
    listen(window, "pagehide", function () { flush(true); }, host);

    function armIdle() {
      if (IDLE_MS <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { idle = true; record("idle.start"); }, IDLE_MS);
    }
    function onActivity() {
      if (idle) { idle = false; record("idle.end"); }
      else if (Date.now() - lastReset < THROTTLE_MS) return;
      lastReset = Date.now();
      armIdle();
    }
    armIdle();
    if (doc) for (var i = 0; i < ACTIVITY.length; i++) listen(doc, ACTIVITY[i], onActivity, host);

    function unit(n) { return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000; }
    function bindContent(frame) {
      while (unbindContent.length) unbindContent.pop()();
      var inner = null;
      try { inner = frame.contentDocument; } catch (err) { inner = null; } // cross-origin
      if (!inner) return;
      var view = inner.defaultView;
      for (var j = 0; j < ACTIVITY.length; j++) listen(inner, ACTIVITY[j], onActivity, unbindContent);
      if (rc.pointer) listen(inner, "pointerdown", function (e) {
        var w = view && view.innerWidth, h = view && view.innerHeight;
        if (!w || !h || typeof e.clientX !== "number" || typeof e.clientY !== "number") return;
        record("pointer", null, { x: unit(e.clientX / w), y: unit(e.clientY / h) });
      }, unbindContent);
      Object.keys(MEDIA).forEach(function (type) {
        listen(inner, type, function (e) {
          var m = e.target || {}, d = {};
          var src = m.currentSrc || m.src;
          if (typeof src === "string" && src) d.src = src.slice(0, 200);
          if (typeof m.currentTime === "number") d.time = Math.round(m.currentTime * 10) / 10;
          record(MEDIA[type], null, d);
        }, unbindContent);
      });
    }
    function findFrame() {
      if (!doc) return;
      var frame = (rc.iframe && doc.querySelector(rc.iframe)) || doc.getElementById("sco") || doc.querySelector("iframe");
      if (!frame) return;
      listen(frame, "load", function () { bindContent(frame); }, host);
      bindContent(frame);
    }
    if (doc && doc.readyState === "loading") listen(doc, "DOMContentLoaded", findFrame, host);
    else findFrame();

    var flushTimer = FLUSH_MS > 0 ? setInterval(function () { flush(false); }, FLUSH_MS) : null;
    function stopTimers() {
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    return {
      navigate: function (location) { record("navigation", location); },
      stop: function () {
        if (stopped) return;
        stopTimers();
        while (host.length) host.pop()();
        while (unbindContent.length) unbindContent.pop()();
        stopped = true;
        // An in-flight send carries on draining once it settles.
        if (!sending) flush(true);
      }
    };
  }

  if (is2004) {
    window.API_1484_11 = {
      Initialize: initialize, Terminate: finish, GetValue: getValue, SetValue: setValue,
      Commit: doCommit, GetLastError: getLastError, GetErrorString: getErrorString, GetDiagnostic: getDiagnostic
    };
  } else {
    window.API = {
      LMSInitialize: initialize, LMSFinish: finish, LMSGetValue: getValue, LMSSetValue: setValue,
      LMSCommit: doCommit, LMSGetLastError: getLastError, LMSGetErrorString: getErrorString, LMSGetDiagnostic: getDiagnostic
    };
  }

  window.addEventListener("beforeunload", function () { if (phase === "running") commit(); });
  window.__SCORMFLOW_READY__ = true;
})();
`;
}

/** Full HTML page for `/play/:attemptId`. */
export function renderPlayerPage(opts: PlayerPageOptions): string {
  const config: BridgeConfig = {
    apiBase: opts.apiBase,
    attemptId: opts.attemptId,
    token: opts.token,
    version: opts.version,
    cmi: opts.cmi,
    ...(opts.replay ? { replay: opts.replay } : {}),
  };
  const bg = opts.theme === 'light' ? '#ffffff' : '#0b0d12';

  return `<!doctype html>
<html lang="en" data-theme="${opts.theme}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ScormFlow Player</title>
<style>
  html, body { margin: 0; height: 100%; background: ${bg}; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
<script>${renderBridgeConfig(config)}</script>
<script src="${opts.apiBase}/runtime.js"></script>
</head>
<body>
<iframe id="sco" title="SCORM content" src="${escapeAttr(opts.contentUrl)}"
  allow="autoplay; fullscreen; microphone; camera"></iframe>
</body>
</html>
`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
