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
 */

export interface PlayerPageOptions {
  apiBase: string;
  attemptId: string;
  token: string;
  version: string;
  /** Server-hydrated CMI snapshot so GetValue works before the first fetch. */
  cmi: Record<string, unknown>;
  /** Resolved SCO content URL (engine-hosted or external). */
  contentUrl: string;
  theme: 'light' | 'dark' | 'auto';
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
  }

  function get(el) {
    if (el === "cmi._version") return "1.0";
    if (el.slice(-7) === "._count") return String(count(el.slice(0, -7)));
    return data.hasOwnProperty(el) ? data[el] : "";
  }
  function set(el, val) { data[el] = String(val); dirty[el] = String(val); scheduleCommit(); }

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
  const config = {
    apiBase: opts.apiBase,
    attemptId: opts.attemptId,
    token: opts.token,
    version: opts.version,
    cmi: opts.cmi,
  };
  // JSON embedded in a script tag — escape `<` to avoid breaking out of it.
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
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
<script>window.__SCORMFLOW__ = ${configJson};</script>
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
