let tracks = [];
let trackId = null;

let rows = [];
let filtered = [];
// Row ids, not list positions, so selection survives re-renders and search changes.
let selected = new Set();
let lastClickedPos = null;
// Row id currently looping, so the context menu can offer to stop it and the
// list can mark the row. Looping follows a plain click to another line.
let loopingId = null;

let currentTime = 0;
let currentIdx = -1;

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

function fmt(t) {
  const s = Math.max(0, Math.floor(t));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function showNotice(message, kind = "info") {
  const el = document.getElementById("notice");
  el.textContent = message;
  el.className = `notice ${kind}`;
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  if (kind !== "error") noticeTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function clearNotice() {
  const el = document.getElementById("notice");
  el.hidden = true;
  if (noticeTimer) clearTimeout(noticeTimer);
}

function populateSelect() {
  const sel = document.getElementById("track");
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
  return document.getElementById("q").value.trim();
}

function caseSensitive() {
  return document.getElementById("caseToggle").getAttribute("aria-pressed") === "true";
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
    for (const r of filtered) {
      for (const m of String(r.text || "").matchAll(searchRegex())) {
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

function applyFilter() {
  const re = filterRegex();
  filtered = re ? rows.filter(r => re.test(r.text || "")) : rows.slice();
  lastClickedPos = null;
  computeMatches();
  render();
}

function findCurrentIndex() {
  let lo = 0, hi = filtered.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = filtered[mid];
    if (currentTime < r.start) hi = mid - 1;
    else if (currentTime > r.end) { best = mid; lo = mid + 1; }
    else return mid;
  }
  return best;
}

function commitEdit(ta, id) {
  if (ta.dataset.done) return false;
  const value = ta.value;
  if (value.trim() === "") {
    showNotice("Subtitle text cannot be empty — press Escape to cancel instead.", "error");
    ta.focus();
    return false;
  }
  ta.dataset.done = "1";
  editingId = null;

  const next = normalizeText(value);
  const row = rows.find(r => r.id === id);
  if (!row || next === row.text) { render(); return true; }

  const changes = [{ id, before: row.text, after: next }];
  pushUndo("the edit", changes);
  applyChanges(changes, "after");
  return true;
}

function cancelEdit(ta) {
  ta.dataset.done = "1";
  editingId = null;
  render();
}

function isMenuOpen() {
  return !document.getElementById("ctxMenu").hidden;
}

function closeContextMenu() {
  const el = document.getElementById("ctxMenu");
  el.hidden = true;
  el.innerHTML = "";
}

function openContextMenu(x, y, r) {
  const el = document.getElementById("ctxMenu");
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

  add("Edit text", "⌘⏎", () => startEdit(r.id));
  sep();
  add("Jump to this line", "", () => iina.postMessage("seekTo", { time: r.start }));
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
  const batch = selected.has(r.id) && selected.size > 1 ? selectedRows() : [r];
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
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function startEdit(id) {
  editingId = id;
  clearNotice();
  render();
  const ta = document.querySelector(".editor");
  if (ta) { ta.focus(); ta.select(); }
}

function buildEditor(r, carry) {
  const ta = document.createElement("textarea");
  ta.className = "editor";
  // `carry` is the in-flight text of an editor this render is replacing. Seeding from
  // r.text instead would discard whatever was typed since the row was last posted.
  const seed = carry ? carry.value : (r.text || "");
  ta.value = seed;
  ta.rows = Math.min(6, seed.split("\n").length + 1);

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(ta, r.id); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(ta); }
    e.stopPropagation();
  });
  ta.addEventListener("blur", () => commitEdit(ta, r.id));
  ta.addEventListener("mousedown", (e) => e.stopPropagation());
  ta.addEventListener("click", (e) => e.stopPropagation());
  ta.addEventListener("contextmenu", (e) => e.stopPropagation());
  return ta;
}

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

function render() {
  const list = document.getElementById("list");

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
  currentIdx = findCurrentIndex();

  if (!filtered.length && listMessage) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerText = listMessage;
    list.appendChild(empty);
    return;
  }

  filtered.forEach((r, pos) => {
    const item = document.createElement("div");
    const isSel = selected.has(r.id);
    const isCur = (pos === currentIdx);
    const isEditing = (r.id === editingId);

    item.className = "item"
      + (isSel ? " selected" : "")
      + (isCur ? " current" : "")
      + (isEditing ? " editing" : "")
      + (r.id === loopingId ? " looping" : "");
    item.dataset.index = String(pos);
    item.dataset.id = String(r.id);

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = fmt(r.start);
    item.appendChild(time);

    if (isEditing) {
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
      const isRange = e.shiftKey && lastClickedPos != null;
      const isToggle = e.metaKey || e.ctrlKey;

      if (isRange) {
        const a = Math.min(lastClickedPos, pos);
        const b = Math.max(lastClickedPos, pos);
        selected.clear();
        for (let k = a; k <= b; k++) if (filtered[k]) selected.add(filtered[k].id);
      } else if (isToggle) {
        if (selected.has(r.id)) selected.delete(r.id); else selected.add(r.id);
        lastClickedPos = pos;
      } else {
        selected.clear();
        selected.add(r.id);
        lastClickedPos = pos;
        iina.postMessage("seekTo", { time: r.start });
      }

      if (loopingId != null) {
        loopingId = r.id;
        iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
      }

      // Clicking a row moves the find cursor onto it, so Replace acts on the line
      // being pointed at. A row already holding the cursor is left alone, so
      // clicking around does not walk the cursor through a multi-match line.
      if (matches.length && matches[matchIdx]?.id !== r.id) {
        const i = matches.findIndex(m => m.id === r.id);
        if (i >= 0) { matchIdx = i; updateFindState(); }
      }

      render();
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
  return rows.filter(r => selected.has(r.id)).sort((a, b) => a.start - b.start);
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
  document.getElementById("undo").disabled = !undoStack.length;
  document.getElementById("redo").disabled = !redoStack.length;
}

// Puts the first line an undo touched back on screen, so a stack entry from far up
// the file is something the user sees rather than has to go looking for.
function revealRow(id) {
  const pos = filtered.findIndex(r => r.id === id);
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

function updateFindState() {
  const has = matches.length > 0;
  document.getElementById("matchCount").textContent =
    !searchRegex() ? "" : (has ? `${matchIdx + 1} of ${matches.length}` : "No results");
  for (const id of ["prevMatch", "nextMatch", "replaceOne", "replaceAll"]) {
    document.getElementById(id).disabled = !has;
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
  const el = document.querySelector("mark.active");
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function replacement() {
  return document.getElementById("replaceWith").value;
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

  for (const row of filtered) {
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

function scrollToIndex(idx) {
  const el = document.querySelector(`.item[data-index="${idx}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Toolbar actions */
document.getElementById("q").addEventListener("input", applyFilter);

function setReplaceOpen(open) {
  document.getElementById("replaceRow").hidden = !open;
  document.getElementById("toggleReplace").setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("replaceWith").focus();
}

document.getElementById("toggleReplace").addEventListener("click", () => {
  setReplaceOpen(document.getElementById("replaceRow").hidden);
});

document.getElementById("caseToggle").addEventListener("click", (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") === "true";
  e.currentTarget.setAttribute("aria-pressed", String(!on));
  applyFilter();
});

document.getElementById("prevMatch").addEventListener("click", () => gotoMatch(-1));
document.getElementById("nextMatch").addEventListener("click", () => gotoMatch(1));
document.getElementById("replaceOne").addEventListener("click", replaceCurrent);
document.getElementById("replaceAll").addEventListener("click", replaceAll);
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("redo").addEventListener("click", redo);

function isPlainEnter(e) {
  return e.key === "Enter" && !e.metaKey && !e.ctrlKey;
}

document.getElementById("q").addEventListener("keydown", (e) => {
  if (isPlainEnter(e)) { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
});

document.getElementById("replaceWith").addEventListener("keydown", (e) => {
  if (isPlainEnter(e)) { e.preventDefault(); replaceCurrent(); }
  else if (e.key === "Escape") { e.preventDefault(); setReplaceOpen(false); document.getElementById("q").focus(); }
});

document.getElementById("reload").addEventListener("click", () => {
  clearNotice();
  iina.postMessage("reload", {});
});

document.getElementById("track").addEventListener("change", () => {
  trackId = Number(document.getElementById("track").value);
  iina.postMessage("setSelection", { trackId });
});

// 手动切换自动滚动开关时的逻辑
document.getElementById("autoScrollToggle").addEventListener("change", () => {
  const on = document.getElementById("autoScrollToggle").checked;
  if (on && currentIdx >= 0) {
    scrollToIndex(currentIdx);
  }
});

document.getElementById("scrollCurrent").addEventListener("click", () => iina.postMessage("scrollToCurrent", {}));

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#ctxMenu")) closeContextMenu();
});
document.getElementById("list").addEventListener("scroll", closeContextMenu);
window.addEventListener("blur", closeContextMenu);
// Right-clicking outside a row should dismiss rather than show WebKit's own menu.
document.addEventListener("contextmenu", (e) => { e.preventDefault(); closeContextMenu(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
  // Inside a text field ⌘Z belongs to the field's own undo, not the edit history.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z"
      && !/^(INPUT|TEXTAREA)$/.test(e.target?.tagName || "")) {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
  // Edit the line that is playing right now, without reaching for the mouse.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && currentIdx >= 0) {
    e.preventDefault();
    const r = filtered[currentIdx];
    if (r) startEdit(r.id);
  }
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
  if (path !== loadedPath) { loadedPath = path; clearUndo(); }

  const liveIds = new Set(rows.map(x => x.id));
  for (const id of [...selected]) if (!liveIds.has(id)) selected.delete(id);
  if (editingId != null && !liveIds.has(editingId)) editingId = null;
  if (loopingId != null && !liveIds.has(loopingId)) {
    loopingId = null;
    iina.postMessage("loopLine", { enabled: false });
  }

  listMessage = meta?.error || "";

  const count = meta?.count ?? rows.length;
  const el = document.getElementById("meta");
  el.innerText = count ? `Rows: ${count}` : "";
  el.hidden = !count;

  applyFilter();
});

iina.onMessage("time", ({ t }) => {
  if (typeof t === "number" && isFinite(t)) {
    currentTime = t;
    // Re-rendering would tear down an open editor mid-typing, or yank the context
    // menu out from under the pointer as playback advances.
    if (editingId != null || isMenuOpen()) return;
    const idx = findCurrentIndex();

    if (idx !== currentIdx) {
      render();
      const autoScroll = document.getElementById("autoScrollToggle")?.checked;
      if (autoScroll && idx !== -1) {
        scrollToIndex(idx);
      }
    }
  }
});

iina.onMessage("scrollToIndex", ({ idx }) => {
  if (typeof idx === "number") scrollToIndex(idx);
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

iina.postMessage("uiReady", {});

window.addEventListener('beforeunload', () => {
  try { iina.postMessage('windowClosed', {}); } catch (_) { }
});
