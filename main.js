const { core, standaloneWindow, event, mpv, file, utils, console: log, menu } = iina;

const PLUGIN_LABEL = "Subtitle Navigator";
const MENU_SHORTCUT = "cmd+shift+s";

let uiReady = false;

let allSubTracks = [];
let trackId = null;

let cues = [];
let rows = [];

// Raw source lines of the loaded .srt, kept so edits can be spliced into the
// original text instead of re-serialized from the lossy parse. See docs/ARCHITECTURE.md.
let srcLines = [];
let srcPath = "";

// cue id -> replacement text. Keyed to `editsKey` so switching files drops them.
let edits = new Map();
let editsKey = "";
let backedUp = false;

const AUTOSAVE_DELAY_MS = 2000;
let autosaveTimer = null;
// Saves run one at a time, chained rather than flagged, so awaiting saveSubtitle()
// waits for its own turn to finish and not just for the queue to be joined.
let saveChain = Promise.resolve();
// Our own sub-reload makes mpv re-announce the track list; re-reading the file in
// response would undo the in-memory resync and re-render over an open editor.
let selfReloadAt = 0;

let lastStateKey = "";
let timeTicker = null;
// Playback-time bounds of the line being looped. Belongs to whichever .srt is
// loaded, so anything that swaps the file out has to drop it -- row ids are cue
// indices, so a stale loop would otherwise keep seeking to the old file's times
// under a marker sitting on an unrelated row of the new one.
let loop = { enabled: false, start: 0, end: 0 };

function clearLoop() {
  loop = { enabled: false, start: 0, end: 0 };
}

let windowLoaded = false;

function ensureWindowLoaded() {
  if (windowLoaded) return;
  standaloneWindow.setProperty({ title: PLUGIN_LABEL, resizable: true });
  standaloneWindow.loadFile("ui/window.html");
  standaloneWindow.setFrame(900, 720);
  windowLoaded = true;
}

function openWindow() {
  ensureWindowLoaded();
  try { standaloneWindow.open(); } catch (e) { log.error(e?.stack || e); }
}

// Plugin menu item: reopen window after user closes it.
try {
  menu.addItem(menu.item(`Show ${PLUGIN_LABEL}`, () => openWindow(), { keyBinding: MENU_SHORTCUT }));
} catch (e) { /* menu may be unavailable in some contexts */ }

// Open once on plugin load.
openWindow();
function fmtErr(e) {
  try { return (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e); }
  catch { return String(e); }
}

function shQuote(path) {
  return `'${String(path).replace(/'/g, `'\\''`)}'`;
}

function post(name, data) {
  if (uiReady) standaloneWindow.postMessage(name, data);
}

function stripCurly(text) {
  return String(text || "").replace(/\{[^}]*\}/g, "").trim();
}

async function execStdout(cmd, args) {
  const res = await utils.exec(cmd, args);
  if (typeof res === "string") return res;
  if (res && typeof res.stdout === "string") return res.stdout;
  if (res && typeof res.output === "string") return res.output;
  return "";
}

function hasSuffix(path) {
  return typeof path === "string" && /\.[A-Za-z0-9]+$/.test(path);
}

function getTrackListRaw() {
  const tracks = mpv.getNative("track-list") || [];
  return tracks
    .filter(t => t.type === "sub")
    .map(t => ({
      id: t.id,
      title: t.title || "",
      lang: t.lang || "",
      externalFilename: t["external-filename"] || "",
      selected: (t.selected === true || t.selected === "yes")
    }));
}

async function buildTrackListSuffixOnly() {
  const raw = getTrackListRaw();
  const out = [];
  for (const t of raw) {
    const p = t.externalFilename;
    if (p && hasSuffix(p)) out.push({ ...t, path: p });
  }
  return out;
}

async function readSubtitleTextById(id, fallbackPath) {
  // Prefer IINA's pseudo folder reader to avoid utils.exec stdout truncation.
  // @sub/:id points to the subtitle file of the current playing media.
  try {
    const txt = file.read(`@sub/${id}`);
    if (txt && typeof txt === "string") return String(txt).replace(/^\uFEFF/, "");
  } catch (_) {}
  // Fallback: read via shell (may truncate on some builds)
  if (fallbackPath) return await readTextFromPath(fallbackPath);
  throw new Error("Failed to read subtitle");
}

async function readTextFromPath(path) {

  const out = await execStdout("/bin/bash", ["-lc", `cat ${shQuote(path)}`]);
  if (!out) throw new Error(`Failed to read subtitle: ${path}`);
  return String(out).replace(/^\uFEFF/, "");
}

function parseTimeToSeconds(ts) {
  const s = String(ts).trim();
  const m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})([.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const se = Number(m[3]);
  const ms = m[5] ? Number(m[5].padEnd(3, "0")) : 0;
  if (![h, mi, se, ms].every(Number.isFinite)) return NaN;
  return h * 3600 + mi * 60 + se + ms / 1000;
}

// Returns every cue with a parseable timeline, tagged with the line span its text
// occupies in `lines`. Unusable cues are kept (not dropped) so the spans of later
// cues stay aligned with the source; `buildRows` does the display filtering.
function parseSRT(content) {
  const lines = String(content).replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  function isIndexLine(x) { return /^\s*\d+\s*$/.test(x); }

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    if (isIndexLine(lines[i])) i++;

    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    const timeLine = lines[i];
    const tm = timeLine.match(/^\s*([0-9]+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*([0-9]+:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/);
    if (!tm) { i++; continue; }

    const start = parseTimeToSeconds(tm[1]);
    const end = parseTimeToSeconds(tm[2]);
    i++;

    const textStart = i;
    while (i < lines.length && lines[i].trim() !== "") i++;
    const textEnd = i;

    const text = stripCurly(lines.slice(textStart, textEnd).join("\n"));
    out.push({ start, end, text, textStart, textEnd });
  }

  return { lines, cues: out };
}

function buildRows() {
  return cues
    .map((c, id) => ({
      id,
      start: c.start,
      end: c.end,
      text: edits.has(id) ? edits.get(id) : c.text,
      dirty: edits.has(id)
    }))
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.text)
    .sort((a, b) => a.start - b.start);
}

function postRows(meta) {
  rows = buildRows();
  post("setRows", { rows, meta: { count: rows.length, dirty: edits.size, path: srcPath, ...(meta || {}) } });
}

function getSubDelay() {
  try {
    const d = mpv.getNumber("sub-delay");
    return Number.isFinite(d) ? d : 0;
  } catch (_) { return 0; }
}

async function refresh(force = false) {
  allSubTracks = await buildTrackListSuffixOnly();

  if (trackId === null) {
    const selected = allSubTracks.find(t => t.selected);
    trackId = selected ? selected.id : (allSubTracks[0]?.id ?? null);
  }
  if (trackId !== null && !allSubTracks.find(t => t.id === trackId)) {
    // sub-reload renumbers tracks, so re-resolve by path before giving up on it.
    const sameFile = srcPath ? allSubTracks.find(t => t.path === srcPath) : null;
    trackId = sameFile ? sameFile.id : (allSubTracks[0]?.id ?? null);
  }

  post("setTracks", { tracks: allSubTracks, trackId });

  // `!trackId` rather than a null check would treat a track id of 0 as no track.
  if (trackId === null) {
    cues = []; rows = []; srcLines = []; srcPath = "";
    clearLoop();
    post("setRows", { rows: [], meta: { error: "No subtitle selected" } });
    return;
  }

  const path = allSubTracks.find(t => t.id === trackId)?.path || "";
  const stateKey = path;
  if (!force && stateKey === lastStateKey && cues.length) {
    postRows();
    return;
  }
  lastStateKey = stateKey;

  if (editsKey !== path) {
    edits.clear();
    editsKey = path;
    backedUp = false;
    clearLoop();
  }

  try {
    if (!path.toLowerCase().endsWith(".srt")) throw new Error(`Selected subtitle is not .srt: ${path}`);
    const text = await readSubtitleTextById(trackId, path);
    const parsed = parseSRT(text);
    cues = parsed.cues;
    srcLines = parsed.lines;
    srcPath = path;
    postRows({ path });
  } catch (e) {
    cues = []; rows = []; srcLines = [];
    post("setRows", { rows: [], meta: { error: fmtErr(e) } });
  }
}

/** Editing */

function isBlank(text) {
  return String(text ?? "").trim() === "";
}

// Splices edited text into the original source lines. Cues are applied back to
// front so earlier splices don't shift the spans of ones not yet applied.
function buildSRT(batch) {
  const out = srcLines.slice();
  const ids = [...batch.keys()].sort((a, b) => cues[b].textStart - cues[a].textStart);
  for (const id of ids) {
    const c = cues[id];
    if (!c) continue;
    const replacement = String(batch.get(id)).replace(/\r/g, "").split("\n");
    out.splice(c.textStart, c.textEnd - c.textStart, ...replacement);
  }
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

async function backupOnce(path) {
  if (backedUp) return;
  // Keeps the first pristine copy even across sessions, rather than letting a later
  // save overwrite the backup with already-edited text. Guarded with `test -e` rather
  // than `cp -n` because BSD cp exits 1 when it skips an existing destination.
  const bak = path + ".bak";
  const res = await utils.exec("/bin/bash", ["-lc", `test -e ${shQuote(bak)} || cp ${shQuote(path)} ${shQuote(bak)}`]);
  if (res && Number.isFinite(res.status) && res.status !== 0) {
    throw new Error(`Backup failed: ${res.stderr || `exit ${res.status}`}`);
  }
  backedUp = true;
}

function cancelAutosave() {
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
}

// Anything that swaps the loaded file out has to write a pending edit first,
// otherwise an edit made inside the debounce window disappears silently.
// Two passes because an edit can arrive after a running save has snapshotted its
// batch: `edits` can be empty right now and non-empty once that save finishes.
async function flushPending() {
  cancelAutosave();
  await saveSubtitle({ auto: true });
  if (edits.size) await saveSubtitle({ auto: true });
}

// Batches a run of edits into one write and one subtitle reload, instead of paying
// both on every committed line.
function scheduleAutosave() {
  cancelAutosave();
  if (!edits.size) return;
  autosaveTimer = setTimeout(() => { autosaveTimer = null; saveSubtitle({ auto: true }); }, AUTOSAVE_DELAY_MS);
}

async function writeSubtitleFile(path, text) {
  // file.write refuses to overwrite anything outside @tmp/@data, so stage the new
  // text there and move it into place with the shell.
  const staged = "@tmp/subtitle-navigator-save.srt";
  file.write(staged, text);
  const stagedReal = utils.resolvePath(staged);

  // Copy the original first so the replacement inherits its mode, then rename over
  // it. A plain `cat > path` would truncate the only copy before writing a byte,
  // and autosave takes that risk on every batch rather than once a session.
  const swap = path + ".sn-tmp";
  const cmd = [
    `cp -p ${shQuote(path)} ${shQuote(swap)}`,
    `cat ${shQuote(stagedReal)} > ${shQuote(swap)}`,
    `mv -f ${shQuote(swap)} ${shQuote(path)}`,
  ].join(" && ");
  const res = await utils.exec("/bin/bash", ["-lc", `${cmd} || { rm -f ${shQuote(swap)}; exit 1; }`]);
  // A result we cannot read is treated as a failure: falling through to the in-place
  // write costs one extra `cat` if it actually succeeded, whereas assuming success
  // would report a save that may never have happened.
  if (res && res.status === 0) return;

  // The rename needs a writable *directory*; the subtitle may sit in a read-only one
  // beside a writable file (a mounted share, say). Fall back to writing in place,
  // which is what this did before and still works there.
  const direct = await utils.exec("/bin/bash", ["-lc", `cat ${shQuote(stagedReal)} > ${shQuote(path)}`]);
  if (direct && Number.isFinite(direct.status) && direct.status !== 0) {
    throw new Error(`Write failed: ${direct.stderr || res.stderr || `exit ${direct.status}`}`);
  }
  log.log(`Atomic replace unavailable for ${path}; wrote in place instead.`);
}

function saveSubtitle(opts = {}) {
  cancelAutosave();
  // A save with nothing left to write is a no-op, so a redundant queue entry costs
  // nothing and the caller still gets a promise that outlives the write ahead of it.
  saveChain = saveChain.then(() => runSave(opts), () => runSave(opts));
  return saveChain;
}

async function runSave(opts = {}) {
  const auto = Boolean(opts.auto);

  if (!edits.size) {
    if (!auto) post("saveResult", { ok: true, saved: 0, message: "No changes to save" });
    return;
  }
  const path = srcPath;
  if (!path) {
    post("saveResult", { ok: false, message: "No subtitle file loaded" });
    return;
  }

  // Snapshot what this write covers. An edit committed while the write is in flight
  // is not in the text going out, so it must not be cleared along with the batch.
  const batch = new Map(edits);
  const count = batch.size;
  try {
    const check = await utils.exec("/bin/bash", ["-lc", `test -w ${shQuote(path)}`]);
    if (check && Number.isFinite(check.status) && check.status !== 0) {
      throw new Error(`File is not writable (moved, deleted, or read-only): ${path}`);
    }

    await backupOnce(path);

    const text = buildSRT(batch);
    await writeSubtitleFile(path, text);

    // Re-parse what we just wrote rather than reading it back. Line-count changes
    // shift every later cue's span, so the spans have to be rebuilt either way, and
    // this skips a disk read plus the re-render that came with it.
    const parsed = parseSRT(text);
    cues = parsed.cues;
    srcLines = parsed.lines;
    clearBatch(batch);

    selfReloadAt = Date.now();
    try { mpv.command("sub-reload", [String(trackId)]); } catch (e) { log.error(fmtErr(e)); }

    postRows();
    core.osd(`Saved ${count} subtitle edit${count === 1 ? "" : "s"}`);
    post("saveResult", { ok: true, saved: count, message: `Saved ${count} edit${count === 1 ? "" : "s"}`, auto });
  } catch (e) {
    const msg = fmtErr(e);
    log.error(msg);
    // Nothing reached the file, so drop the batch rather than leave the list showing
    // text the .srt does not have. The discarded lines go into the error so a
    // correction that mattered can be typed back in.
    const lost = [...batch.values()].join(" / ");
    clearBatch(batch);
    postRows();
    core.osd("Subtitle save failed - edit reverted");
    post("saveResult", { ok: false, message: `Save failed, edit reverted: ${msg}`, discarded: lost, auto });
  } finally {
    // Whatever arrived mid-write is still pending, so give it its own batch.
    if (edits.size) scheduleAutosave();
  }
}

// Drops only the entries this write covered, leaving any edit made while it was in
// flight -- and any edit that has since replaced one of them -- pending.
function clearBatch(batch) {
  for (const [id, value] of batch) if (edits.get(id) === value) edits.delete(id);
}

function stopTicker() {
  if (timeTicker) { clearInterval(timeTicker); timeTicker = null; }
}

function startTicker() {
  if (timeTicker) return;
  timeTicker = setInterval(() => {
    try {
      const t = mpv.getNumber("time-pos");
      if (Number.isFinite(t)) {
        // The UI matches this against times read from the subtitle file, so shift it
        // out of playback time. Loop bounds below are already in playback time.
        post("time", { t: t - getSubDelay() });
        if (loop.enabled && t > loop.end + 0.02) core.seekTo(loop.start);
      }
    } catch (_) {}
  }, 250);
}

standaloneWindow.onMessage("windowClosed", () => {
  uiReady = false;
  windowLoaded = false;
  // The window is the only control for looping, so leaving it running would strand
  // playback on a line with no way to stop it.
  clearLoop();
  stopTicker();
  flushPending();
});

standaloneWindow.onMessage("uiReady", () => {
  uiReady = true;
  startTicker();
  // Not forced: keeps unsaved edits when the window is reopened on the same file.
  refresh(false);
});

standaloneWindow.onMessage("setSelection", async (data) => {
  await flushPending();
  const id = Number(data?.trackId);
  if (Number.isFinite(id)) trackId = id;
  lastStateKey = "";
  refresh(true);
});

standaloneWindow.onMessage("seekTo", (data) => {
  const t = Number(data?.time);
  if (Number.isFinite(t)) core.seekTo(t + getSubDelay());
});

// Read straight from mpv rather than letting the UI reuse its last ticked time,
// which can be a tick behind on the jump that follows opening a file.
standaloneWindow.onMessage("scrollToCurrent", () => {
  const t = mpv.getNumber("time-pos");
  if (!Number.isFinite(t)) return;
  post("scrollToTime", { t: t - getSubDelay() });
});

standaloneWindow.onMessage("togglePause", () => {
  // Read through mpv rather than core.status so the OSD matches the state we set,
  // even if IINA's cached status lags behind.
  const paused = mpv.getFlag("pause");
  if (paused) { core.resume(); core.osd("Play"); }
  else { core.pause(); core.osd("Pause"); }
});

standaloneWindow.onMessage("loopLine", (data) => {
  const enabled = Boolean(data?.enabled);
  const start = Number(data?.start);
  const end = Number(data?.end);
  if (enabled && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const d = getSubDelay();
    loop = { enabled: true, start: start + d, end: end + d };
    core.osd("Loop: ON");
  } else {
    clearLoop();
    core.osd("Loop: OFF");
  }
});

// Takes a list rather than a single row so Replace All and undo cost one re-render
// and one autosave, not one of each per line they touch.
standaloneWindow.onMessage("editRows", (data) => {
  const incoming = Array.isArray(data?.edits) ? data.edits : [];
  let rejected = 0;

  for (const e of incoming) {
    const id = Number(e?.id);
    const text = String(e?.text ?? "");
    if (!Number.isInteger(id) || !cues[id]) continue;
    if (isBlank(text)) { rejected++; continue; }
    const next = text.replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();
    if (next === cues[id].text) edits.delete(id);
    else edits.set(id, next);
  }

  if (rejected) post("notice", { ok: false, message: "Subtitle text cannot be empty" });
  postRows();
  scheduleAutosave();
});

standaloneWindow.onMessage("reload", async () => {
  await flushPending();
  lastStateKey = "";
  refresh(true);
});

standaloneWindow.onMessage("copyFallback", async (data) => {
  const text = String(data?.text ?? "");
  if (!text) return;
  try {
    const tmp = "@tmp/subtitle-navigator-clipboard.txt";
    file.write(tmp, text);
    const real = utils.resolvePath(tmp);
    await utils.exec("/bin/bash", ["-lc", `/usr/bin/pbcopy < "${real.replace(/"/g, '\\"')}"`]);
    core.osd("Copied");
  } catch (e) {
    core.osd("Copy failed");
    log.error(fmtErr(e));
  }
});

function onTrackEvent() {
  // Ignore the echo of our own save; the in-memory copy is already what is on disk.
  if (Date.now() - selfReloadAt < 2000) { refresh(false); return; }
  lastStateKey = "";
  refresh(true);
}

event.on("mpv.file-loaded", async () => { await flushPending(); lastStateKey = ""; refresh(true); });
event.on("mpv.track-list.changed", onTrackEvent);
event.on("mpv.sid.changed", onTrackEvent);
event.on("mpv.sub-file.changed", onTrackEvent);
