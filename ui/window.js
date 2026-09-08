"use strict";

// The WebView half of the plugin. It owns no subtitle data of its own: rows arrive
// from main.js and every privileged action goes back as a message.
//
// Two things it deliberately does not decide for itself:
//   * `Nav` (ui/state.js) owns where playback is, what is selected and what
//     auto-scroll has already brought into view. Its entry points return *effects*,
//     which `apply()` below turns into DOM.
//   * `Shortcuts` (ui/shortcuts.js) owns every key binding, so the "?" panel is
//     generated from the same table the dispatcher reads.

const nav = Nav.create();

let tracks = [];
let trackId = null;

// Every row of the loaded file. `nav.rows` is this after the search filter, and is
// what positions everywhere else index into.
let rows = [];

// Row id currently looping, so the context menu can offer to stop it and the list
// can mark the row. Looping follows a plain click to another line.
let loopingId = null;

let editingId = null;

// Every occurrence of the query, in list order, and which one Replace will act on.
// Rebuilt whenever the query or the rows change.
let matches = [];
let matchIdx = -1;
let matchQuery = null;
// Set by a replace: where to put the cursor once the matches are rebuilt. Landing
// past the inserted text keeps a replacement that contains the query (world ->
// the world) from parking the cursor back on the match it just made.
let resumeAt = null;

// Each entry is one user action: a label for the notice, and the before/after text
// of every row it touched. Undo and redo walk the same list in opposite directions.
const UNDO_LIMIT = 100;
let undoStack = [];
let redoStack = [];
// The .srt the stacks belong to. Undoing into a file the text never came from would
// write the wrong lines, so loading another one drops them.
let loadedPath = null;

let noticeTimer = null;
let listMessage = "";

const $ = (id) => document.getElementById(id);

function fmt(t) {
  const s = Math.max(0, Math.floor(t));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function showNotice(message, kind = "info") {
  const el = $("notice");
  el.textContent = message;
  el.className = `notice ${kind}`;
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  if (kind !== "error") noticeTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function clearNotice() {
  $("notice").hidden = true;
  if (noticeTimer) clearTimeout(noticeTimer);
}

/** Effects */

// Carries out what a Nav transition decided. Render first: the scroll and focus
// steps below need the rebuilt rows to exist.
function apply(fx) {
  if (!fx) return;
  if (fx.render) render();
  if (fx.autoScroll !== null) $("autoScrollToggle").checked = fx.autoScroll;
  if (fx.notice) showNotice(fx.notice);
  if (fx.scrollTo !== null) scrollToIndex(fx.scrollTo);
  if (fx.seekTo !== null) iina.postMessage("seekTo", { time: fx.seekTo });
  if (fx.scrollToCurrent) iina.postMessage("scrollToCurrent", {});
}

/** Search */

function populateSelect() {
  const sel = $("track");
  sel.innerHTML = "";
  tracks.forEach(t => {
    const op = document.createElement("option");
    op.value = String(t.id);
    op.textContent = [t.id, t.lang, t.title].filter(Boolean).join(" ").trim();
    sel.appendChild(op);
  });
  if (trackId != null) sel.value = String(trackId);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();
}

function queryText() {
  return $("q").value.trim();
}

function caseSensitive() {
  return $("caseToggle").getAttribute("aria-pressed") === "true";
}

// The query is matched as a literal, so filtering, highlighting and replacing all
// come from one escaped regex and can never disagree about what counts as a match.
function buildRegex(flags) {
  const q = queryText();
  if (!q) return null;
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive() ? flags : flags + "i");
}

// Global, so it walks every occurrence. A fresh regex per call keeps `lastIndex`
// from leaking between uses.
function searchRegex() {
  return buildRegex("g");
}

// Not global, so `.test()` is stateless and one regex can be reused down the rows.
function filterRegex() {
  return buildRegex("");
}

function computeMatches() {
  const re = searchRegex();
  // Includes the flags, so toggling Match case restarts at the first match rather
  // than holding a position in a match list that has changed underneath it.
  const key = re ? String(re) : null;

  matches = [];
  if (re) {
    for (const r of nav.rows) {
      // matchAll works from a clone, so `re` keeps its own lastIndex at 0 and can
      // be reused down the rows.
      for (const m of String(r.text || "").matchAll(re)) {
        matches.push({ id: r.id, time: r.start, start: m.index, end: m.index + m[0].length });
      }
    }
  }

  if (!matches.length) matchIdx = -1;
  else if (resumeAt) {
    const i = matches.findIndex(m =>
      m.time > resumeAt.time || (m.time === resumeAt.time && m.start >= resumeAt.offset));
    matchIdx = i >= 0 ? i : 0;
  }
  else if (key !== matchQuery || matchIdx < 0 || matchIdx >= matches.length) matchIdx = 0;

  resumeAt = null;
  matchQuery = key;
  updateFindState();
}

function applyFilter(opts = {}) {
  const re = filterRegex();
  const fx = Nav.setRows(nav, re ? rows.filter(r => re.test(r.text || "")) : rows.slice(), opts);
  computeMatches();
  apply(fx);
}

/** Editing */

function focusRow(id) {
  const pos = nav.rows.findIndex(r => r.id === id);
  if (pos >= 0 && Nav.selectPos(nav, pos)) render();
}

function currentEditor() {
  return $("list").querySelector(".editor");
}

function commitEdit() {
  const ta = currentEditor();
  // A teardown blur can arrive after the editor has already been closed, so this is
  // reached with nothing to commit.
  if (!ta || ta.dataset.done || editingId == null) return;
  const id = editingId;
  if (ta.value.trim() === "") {
    showNotice("Subtitle text cannot be empty — press Escape to cancel instead.", "error");
    ta.focus();
    return;
  }
  ta.dataset.done = "1";
  editingId = null;
  nav.editing = false;

  const next = normalizeText(ta.value);
  const row = rows.find(r => r.id === id);
  if (!row || next === row.text) { render(); focusRow(id); return; }

  const changes = [{ id, before: row.text, after: next }];
  pushUndo("the edit", changes);
  applyChanges(changes, "after");
  focusRow(id);
}

function cancelEdit() {
  const ta = currentEditor();
  if (ta) ta.dataset.done = "1";
  editingId = null;
  nav.editing = false;
  render();
}

function startEdit(id) {
  editingId = id;
  nav.editing = true;
  clearNotice();
  render();
  const ta = currentEditor();
  if (ta) { ta.focus(); ta.select(); }
}

function editFocused() {
  const r = nav.rows[Nav.focusedPos(nav)];
  if (r) startEdit(r.id);
}

function buildEditor(r, carry) {
  const ta = document.createElement("textarea");
  ta.className = "editor";
  // `carry` is the in-flight text of an editor this render is replacing. Seeding from
  // r.text instead would discard whatever was typed since the row was last posted.
  const seed = carry ? carry.value : (r.text || "");
  ta.value = seed;
  ta.rows = Math.min(6, seed.split("\n").length + 1);

  ta.addEventListener("blur", commitEdit);
  ta.addEventListener("mousedown", (e) => e.stopPropagation());
  ta.addEventListener("click", (e) => e.stopPropagation());
  ta.addEventListener("contextmenu", (e) => e.stopPropagation());
  return ta;
}

/** Context menu */

function isMenuOpen() {
  return !$("ctxMenu").hidden;
}

function closeContextMenu() {
  const el = $("ctxMenu");
  el.hidden = true;
  el.innerHTML = "";
}

function openContextMenu(x, y, r) {
  const el = $("ctxMenu");
  el.innerHTML = "";

  const add = (label, hint, fn, disabled) => {
    const b = document.createElement("button");
    b.className = "ctxItem";
    b.disabled = Boolean(disabled);
    const t = document.createElement("span");
    t.textContent = label;
    b.appendChild(t);
    if (hint) {
      const k = document.createElement("kbd");
      k.textContent = hint;
      b.appendChild(k);
    }
    b.addEventListener("click", (e) => { e.stopPropagation(); closeContextMenu(); fn(); });
    el.appendChild(b);
  };
  const sep = () => {
    const d = document.createElement("div");
    d.className = "ctxSep";
    el.appendChild(d);
  };

  // Hints come from the shortcuts table, so they cannot drift from the bindings.
  add("Edit text", Shortcuts.display("editFocused"), () => startEdit(r.id));
  sep();
  add("Jump to this line", Shortcuts.display("jumpToFocused"), () =>
    iina.postMessage("seekTo", { time: r.start }));
  if (loopingId === r.id) {
    add("Stop looping", "", () => {
      loopingId = null;
      iina.postMessage("loopLine", { enabled: false });
      render();
    });
  } else {
    add("Loop this line", "", () => {
      loopingId = r.id;
      iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
      render();
    });
  }
  sep();
  const batch = nav.selected.has(r.id) && nav.selected.size > 1 ? selectedRows() : [r];
  const suffix = batch.length > 1 ? ` (${batch.length} lines)` : "";
  const join = (parts) => parts.filter(Boolean).join("\n\n");
  add(`Copy text${suffix}`, "", () => copyText(join(batch.map(x => x.text || ""))));
  add(`Copy with timestamp${suffix}`, "", () =>
    copyText(join(batch.map(x => `[${fmt(x.start)}] ${x.text || ""}`))));

  // Measured off-screen first so the menu can be flipped back inside the viewport.
  el.hidden = false;
  el.style.left = "0px";
  el.style.top = "0px";
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

/** Rendering */

// Tracked so a mousemove the pointer did not actually cause can be ignored:
// scrolling rows under a resting cursor fires one on its own, which would drop
// keyboard mode on the very keypress that scrolled the list.
let lastMouse = { x: -1, y: -1 };

function setKeyboardNav(on) {
  $("list").classList.toggle("kbdNav", on);
}

document.addEventListener("mousemove", (e) => {
  if (e.clientX === lastMouse.x && e.clientY === lastMouse.y) return;
  lastMouse = { x: e.clientX, y: e.clientY };
  setKeyboardNav(false);
});

// Marks every occurrence of the query, and the one Replace will act on. Built from
// text nodes rather than innerHTML so subtitle text carrying < or & cannot become
// markup.
function fillLine(el, text, rowId) {
  const re = searchRegex();
  if (!re) { el.textContent = text; return; }
  const active = matches[matchIdx];

  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement("mark");
    mark.textContent = m[0];
    if (active && active.id === rowId && active.start === m.index) mark.className = "active";
    el.appendChild(mark);
    last = m.index + m[0].length;
  }
  el.appendChild(document.createTextNode(text.slice(last)));
}

// Why the list is empty, when it is. A search that matches nothing used to render a
// blank pane with only the find bar's small counter to explain it.
function emptyMessage() {
  if (listMessage) return listMessage;
  if (!rows.length) return "";
  return queryText() ? `No lines match "${queryText()}".` : "";
}

function render() {
  const list = $("list");

  // An editor being rebuilt for the same row keeps its text, caret and focus; one
  // whose row is going away is marked done so its teardown blur cannot re-commit.
  const open = list.querySelector(".editor");
  let carry = null;
  if (open) {
    if (Number(open.closest(".item")?.dataset.id) === editingId) {
      carry = {
        value: open.value,
        selStart: open.selectionStart,
        selEnd: open.selectionEnd,
        focused: document.activeElement === open,
      };
    } else {
      open.dataset.done = "1";
    }
  }

  // Rebuilding the list would otherwise jump a long subtitle file back to the top
  // every time an edit is committed.
  const scrollTop = list.scrollTop;
  closeContextMenu();
  list.innerHTML = "";

  if (!nav.rows.length) {
    const message = emptyMessage();
    if (message) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerText = message;
      list.appendChild(empty);
    }
    return;
  }

  nav.rows.forEach((r, pos) => {
    const item = document.createElement("div");
    item.className = "item"
      + (nav.selected.has(r.id) ? " selected" : "")
      + (pos === nav.currentIdx ? " current" : "")
      + (r.id === editingId ? " editing" : "")
      + (r.id === loopingId ? " looping" : "");
    item.dataset.index = String(pos);
    item.dataset.id = String(r.id);

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = fmt(r.start);
    item.appendChild(time);

    if (r.id === editingId) {
      item.appendChild(buildEditor(r, carry));
    } else {
      const line = document.createElement("div");
      line.className = "line";
      fillLine(line, r.text || "", r.id);
      item.appendChild(line);
    }

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (editingId === r.id) return;
      openContextMenu(e.clientX, e.clientY, r);
    });

    item.addEventListener("click", (e) => {
      if (editingId === r.id) return;
      apply(Nav.clickRow(nav, pos, { range: e.shiftKey, toggle: e.metaKey || e.ctrlKey }));
      followLoopTo(r);
      moveFindCursorTo(r);
    });

    list.appendChild(item);
  });

  list.scrollTop = scrollTop;

  if (carry) {
    const ta = list.querySelector(".editor");
    if (ta && carry.focused) {
      ta.focus();
      ta.setSelectionRange(carry.selStart, carry.selEnd);
    }
  }
}

// Looping follows the line you jump to, since the row marker is its only indication.
function followLoopTo(r) {
  if (loopingId == null || loopingId === r.id) return;
  loopingId = r.id;
  iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
  render();
}

// Clicking a row moves the find cursor onto it, so Replace acts on the line being
// pointed at. A row already holding the cursor is left alone, so clicking around does
// not walk the cursor through a multi-match line.
function moveFindCursorTo(r) {
  if (!matches.length || matches[matchIdx]?.id === r.id) return;
  const i = matches.findIndex(m => m.id === r.id);
  if (i >= 0) { matchIdx = i; updateFindState(); render(); }
}

async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) { }
  iina.postMessage("copyFallback", { text });
}

function selectedRows() {
  return rows.filter(r => nav.selected.has(r.id)).sort((a, b) => a.start - b.start);
}

/** Undo */

// `key` picks which side of each change to apply, so one walk serves undo and redo.
// Edits go to the rows for the list and to main.js for the file in a single batch,
// which is one re-render and one autosave however many lines the action touched.
function applyChanges(changes, key) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const edits = [];
  for (const c of changes) {
    const row = byId.get(c.id);
    if (!row) continue;
    row.text = c[key];
    row.dirty = true;
    edits.push({ id: c.id, text: c[key] });
  }
  if (edits.length) iina.postMessage("editRows", { edits });
  applyFilter();
}

function pushUndo(label, changes) {
  undoStack.push({ label, changes });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  updateUndoState();
}

function clearUndo() {
  undoStack = [];
  redoStack = [];
  updateUndoState();
}

function updateUndoState() {
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
}

// Puts the first line an undo touched back on screen, so a stack entry from far up
// the file is something the user sees rather than has to go looking for.
function revealRow(id) {
  const pos = nav.rows.findIndex(r => r.id === id);
  if (pos >= 0) scrollToIndex(pos);
}

function step(from, to, key, verb) {
  const entry = from.pop();
  if (!entry) return;
  to.push(entry);
  applyChanges(entry.changes, key);
  updateUndoState();
  showNotice(`${verb} ${entry.label}.`);
  revealRow(entry.changes[0]?.id);
}

function undo() { step(undoStack, redoStack, "before", "Undid"); }
function redo() { step(redoStack, undoStack, "after", "Redid"); }

/** Find and replace */

function updateFindState() {
  const has = matches.length > 0;
  $("matchCount").textContent = !queryText() ? "" : (has ? `${matchIdx + 1} of ${matches.length}` : "No results");
  for (const id of ["prevMatch", "nextMatch", "replaceOne", "replaceAll"]) {
    $(id).disabled = !has;
  }
}

function gotoMatch(delta) {
  if (!matches.length) return;
  matchIdx = (matchIdx + delta + matches.length) % matches.length;
  updateFindState();
  render();
  scrollToMatch();
}

function scrollToMatch() {
  scrollRowIntoView(document.querySelector("mark.active")?.closest(".item"));
}

function replacement() {
  return $("replaceWith").value;
}

function replaceCurrent() {
  const m = matches[matchIdx];
  if (!m) return;
  const row = rows.find(r => r.id === m.id);
  if (!row) return;

  const repl = replacement();
  const text = row.text || "";
  const next = normalizeText(text.slice(0, m.start) + repl + text.slice(m.end));
  // Replacing a match with itself would otherwise leave the cursor where it was and
  // make the button look dead.
  if (next === text) { gotoMatch(1); return; }
  if (next === "") {
    showNotice("That replacement would leave the line empty. Edit the line instead.", "error");
    return;
  }

  const changes = [{ id: m.id, before: text, after: next }];
  pushUndo("the replacement", changes);
  resumeAt = { time: m.time, offset: m.start + repl.length };
  applyChanges(changes, "after");
  scrollToMatch();
}

function plural(n, word, many = word + "s") {
  return `${n} ${n === 1 ? word : many}`;
}

function replaceAll() {
  if (!matches.length) return;
  const repl = replacement();

  const changes = [];
  let count = 0;
  let emptied = 0;

  for (const row of nav.rows) {
    const text = row.text || "";
    let hits = 0;
    // A replacer function rather than a string, so `$&` and friends typed into the
    // Replace box stay literal instead of turning into substitution patterns.
    const next = normalizeText(text.replace(searchRegex(), () => { hits++; return repl; }));
    if (next === text) continue;
    // main.js rejects blank text, so these are dropped here rather than sent and
    // bounced back — the list must never show text the file will not have.
    if (next === "") { emptied++; continue; }
    changes.push({ id: row.id, before: text, after: next });
    count += hits;
  }

  if (!changes.length) {
    showNotice(emptied
      ? `Nothing replaced: ${plural(emptied, "line")} would have been left empty. Edit those lines instead.`
      : "Nothing to replace.", emptied ? "error" : "info");
    return;
  }

  pushUndo(plural(count, "replacement"), changes);
  applyChanges(changes, "after");
  showNotice(`Replaced ${plural(count, "match", "matches")} in ${plural(changes.length, "line")}.`
    + (emptied ? ` Left ${plural(emptied, "line")} alone, which the replacement would have emptied.` : ""));
}

/** Scrolling */

function rowElement(pos) {
  return document.querySelector(`.item[data-index="${pos}"]`);
}

function scrollToIndex(pos) {
  scrollRowIntoView(rowElement(pos));
}

// Below this many visible rows there's not enough room to read ahead, so we fall
// back to centering the target instead.
const MIN_ROWS_TO_READ_AHEAD = 7;
// Rows kept above the target when reading ahead, so it lands on the 4th row.
const ROWS_ABOVE_TARGET = 3;

// When enough rows fit on screen to read ahead, keeps the target on the fourth row
// instead of centering it, so the upcoming lines stay in view below it.
function scrollRowIntoView(el) {
  if (!el) return;
  const list = $("list");
  const rowHeight = el.getBoundingClientRect().height || 1;
  if (list.clientHeight / rowHeight > MIN_ROWS_TO_READ_AHEAD) {
    const offset = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTo({ top: Math.max(0, list.scrollTop + offset - rowHeight * ROWS_ABOVE_TARGET), behavior: "smooth" });
  } else {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// Whether the playing row is on screen. This, not "does focus happen to equal the
// current row", is what decides whether Escape means "take me there" or "toggle
// auto-scroll" — a focus that has never moved reports as being on the current row.
function isCurrentRowVisible() {
  const el = rowElement(nav.currentIdx);
  if (!el) return false;
  const row = el.getBoundingClientRect();
  const list = $("list").getBoundingClientRect();
  return row.bottom > list.top && row.top < list.bottom;
}

// Resizing moves the current row off its resting place, and crossing
// MIN_ROWS_TO_READ_AHEAD switches which resting place it should have, so put it
// back once the drag settles. Waiting for the pause keeps the row from chasing the
// pointer through every intermediate size.
const RESIZE_SETTLE_MS = 150;
let resizeScrollTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeScrollTimer);
  resizeScrollTimer = setTimeout(() => apply(Nav.resize(nav)), RESIZE_SETTLE_MS);
}).observe($("list"));

/** Help */

// Built from the shortcuts table rather than written out in the HTML, so a binding
// cannot be added without showing up here.
function renderHelp() {
  const tip = $("helpTip");
  tip.innerHTML = "";

  for (const note of Shortcuts.NOTES) {
    const p = document.createElement("p");
    p.className = "helpNote";
    p.textContent = note;
    tip.appendChild(p);
  }

  for (const section of Shortcuts.helpSections()) {
    const h = document.createElement("b");
    h.textContent = section.title;
    tip.appendChild(h);

    const dl = document.createElement("dl");
    dl.className = "helpKeys";
    for (const item of section.items) {
      const dt = document.createElement("dt");
      const k = document.createElement("kbd");
      k.textContent = item.display;
      dt.appendChild(k);
      const dd = document.createElement("dd");
      dd.textContent = item.label;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    tip.appendChild(dl);
  }
}

/** Toolbar */

function updateClearButton(inputId, buttonId) {
  $(buttonId).hidden = !$(inputId).value;
}

function wireClearButton(inputId, buttonId, onChange = () => {}) {
  $(inputId).addEventListener("input", () => {
    updateClearButton(inputId, buttonId);
    onChange();
  });
  $(buttonId).addEventListener("click", () => {
    $(inputId).value = "";
    updateClearButton(inputId, buttonId);
    onChange();
    $(inputId).focus();
  });
}

wireClearButton("q", "clearSearch", applyFilter);
wireClearButton("replaceWith", "clearReplace");

function setReplaceOpen(open) {
  $("replaceRow").hidden = !open;
  $("toggleReplace").setAttribute("aria-expanded", String(open));
  if (open) $("replaceWith").focus();
}

$("toggleReplace").addEventListener("click", () => setReplaceOpen($("replaceRow").hidden));

$("caseToggle").addEventListener("click", (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") === "true";
  e.currentTarget.setAttribute("aria-pressed", String(!on));
  applyFilter();
});

$("prevMatch").addEventListener("click", () => gotoMatch(-1));
$("nextMatch").addEventListener("click", () => gotoMatch(1));
$("replaceOne").addEventListener("click", replaceCurrent);
$("replaceAll").addEventListener("click", replaceAll);
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);

$("reload").addEventListener("click", () => {
  clearNotice();
  iina.postMessage("reload", {});
});

$("track").addEventListener("change", () => {
  trackId = Number($("track").value);
  iina.postMessage("setSelection", { trackId });
});

$("autoScrollToggle").addEventListener("change", (e) => {
  apply(Nav.setAutoScroll(nav, e.currentTarget.checked));
});

$("scrollCurrent").addEventListener("click", () => iina.postMessage("scrollToCurrent", {}));

// Scrolling by hand overrides auto-scroll for the same reason j/k does. `wheel` and
// not `scroll`, which the smooth scrolling below fires on its own.
$("list").addEventListener("wheel", () => apply(Nav.browseAway(nav)), { passive: true });

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#ctxMenu")) closeContextMenu();
});
$("list").addEventListener("scroll", closeContextMenu);
window.addEventListener("blur", closeContextMenu);
// Right-clicking outside a row should dismiss rather than show WebKit's own menu.
document.addEventListener("contextmenu", (e) => { e.preventDefault(); closeContextMenu(); });

/** Keyboard */

// Which set of bindings applies. Keys mean different things in the list, inside an
// open row editor, and inside the find fields — deciding that here, once, is what
// keeps a list binding from firing while the user is typing in a text box.
function keyContext(target) {
  if (target?.classList?.contains("editor")) return "editing";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "")) return "find";
  return "list";
}

// Action id -> what it does. Every id here comes from ui/shortcuts.js, and
// test/shortcuts.test.js checks the two sides stay in step.
const SHORTCUT_HANDLERS = {
  moveDown: () => { setKeyboardNav(true); apply(Nav.moveFocus(nav, 1)); },
  moveUp: () => { setKeyboardNav(true); apply(Nav.moveFocus(nav, -1)); },
  jumpToFocused: () => {
    setKeyboardNav(true);
    const r = nav.rows[Nav.focusedPos(nav)];
    apply(Nav.activateFocused(nav));
    if (r) followLoopTo(r);
  },
  editFocused: editFocused,
  togglePause: () => iina.postMessage("togglePause", {}),
  undo: undo,
  redo: redo,
  escape: () => {
    closeContextMenu();
    apply(Nav.escape(nav, { currentRowVisible: isCurrentRowVisible() }));
  },
  commitEdit: commitEdit,
  cancelEdit: cancelEdit,
  nextMatch: () => {
    // From the replace field, Enter is Replace; from the search field it walks matches.
    if (document.activeElement === $("replaceWith")) replaceCurrent();
    else gotoMatch(1);
  },
  prevMatch: () => gotoMatch(-1),
  closeFind: () => {
    setReplaceOpen(false);
    $("q").focus();
  },
};

document.addEventListener("keydown", (event) => {
  const context = keyContext(event.target);
  if (Shortcuts.dispatch(event, context, SHORTCUT_HANDLERS)) event.preventDefault();
});

/** Messages */

iina.onMessage("setTracks", (data) => {
  tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  trackId = data?.trackId ?? null;
  populateSelect();
});

iina.onMessage("setRows", ({ rows: r, meta }) => {
  rows = Array.isArray(r) ? r : [];

  const path = meta?.path ?? null;
  const isNewFile = path !== loadedPath;
  if (isNewFile) {
    loadedPath = path;
    clearUndo();
    // The loop belongs to the file it was set on; main.js drops it at the same point.
    loopingId = null;
  }

  const live = new Set(rows.map(x => x.id));
  if (editingId != null && !live.has(editingId)) { editingId = null; nav.editing = false; }
  if (loopingId != null && !live.has(loopingId)) {
    loopingId = null;
    iina.postMessage("loopLine", { enabled: false });
  }

  listMessage = meta?.error || "";

  // The whole row goes with the count: with nothing loaded there is no row count to
  // report and nothing to undo either.
  const count = meta?.count ?? rows.length;
  $("meta").innerText = count ? `Rows: ${count}` : "";
  document.querySelector(".statusRow").hidden = !count;

  applyFilter({ isNewFile });
});

iina.onMessage("time", ({ t }) => {
  if (typeof t !== "number" || !isFinite(t)) return;
  // Re-rendering would yank the context menu out from under the pointer as playback
  // advances; the next tick after it closes resyncs.
  if (isMenuOpen()) return;
  apply(Nav.tick(nav, t));
});

// The only sender is "Scroll to Current" — directly, or via auto-scroll switching on.
// It carries a time rather than a row index because indices here are into the
// filtered list, which a search can narrow and which main.js cannot see.
iina.onMessage("scrollToTime", ({ t }) => {
  if (typeof t !== "number" || !isFinite(t)) return;
  apply(Nav.jumpToTime(nav, t));
});

iina.onMessage("notice", (data) => {
  showNotice(String(data?.message || ""), data?.ok ? "info" : "error");
});

iina.onMessage("saveResult", (data) => {
  // Saving is meant to be invisible; only a failure is worth interrupting for, and
  // it carries the text that was rolled back so it can be typed in again.
  if (data?.ok) return;
  const discarded = String(data?.discarded || "");
  showNotice(String(data?.message || "") + (discarded ? `\n\nReverted text: ${discarded}` : ""), "error");
});

renderHelp();
$("autoScrollToggle").checked = nav.autoScroll;
iina.postMessage("uiReady", {});

window.addEventListener("beforeunload", () => {
  try { iina.postMessage("windowClosed", {}); } catch (_) { }
});
