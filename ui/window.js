let tracks = [];
let trackId = null;

let rows = [];
let filtered = [];
// Row ids, not list positions, so selection survives re-renders and search changes.
let selected = new Set();
let lastClickedPos = null;

let currentTime = 0;
let currentIdx = -1;

let liveStart = null;

let editingId = null;

let noticeTimer = null;

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

function applyFilter() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  filtered = q ? rows.filter(r => (r.text || "").toLowerCase().includes(q)) : rows.slice();
  lastClickedPos = null;
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

  const next = value.replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();
  const row = rows.find(r => r.id === id);
  if (row) { row.text = next; row.dirty = true; }
  iina.postMessage("editRow", { id, text: next });
  render();
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
  add("Loop this line", "", () => {
    document.getElementById("loopToggle").checked = true;
    iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
  });
  sep();
  add("Copy text", "", () => copyText(r.text || ""));
  add("Copy with timestamp", "", () => copyText(`[${fmt(r.start)}] ${r.text || ""}`));

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

  filtered.forEach((r, pos) => {
    const item = document.createElement("div");
    const isSel = selected.has(r.id);
    const isCur = (pos === currentIdx);
    const isEditing = (r.id === editingId);

    item.className = "item"
      + (isSel ? " selected" : "")
      + (isCur ? " current" : "")
      + (isEditing ? " editing" : "");
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
      line.innerText = r.text || "";
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

      const loopOn = document.getElementById("loopToggle").checked;
      if (loopOn) iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
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

function scrollToIndex(idx) {
  const el = document.querySelector(`.item[data-index="${idx}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Toolbar actions */
document.getElementById("q").addEventListener("input", applyFilter);

document.getElementById("reload").addEventListener("click", () => {
  clearNotice();
  iina.postMessage("reload", {});
});

document.getElementById("track").addEventListener("change", () => {
  trackId = Number(document.getElementById("track").value);
  iina.postMessage("setSelection", { trackId });
});

document.getElementById("copySel").addEventListener("click", async () => {
  const parts = selectedRows().map(r => r.text || "").filter(Boolean);
  await copyText(parts.join("\n\n"));
});

document.getElementById("loopToggle").addEventListener("change", () => {
  const on = document.getElementById("loopToggle").checked;
  if (!on) iina.postMessage("loopLine", { enabled: false });
  else if (currentIdx >= 0) {
    const r = filtered[currentIdx];
    if (r) iina.postMessage("loopLine", { enabled: true, start: r.start, end: r.end });
  }
});

// 手动切换自动滚动开关时的逻辑
document.getElementById("autoScrollToggle").addEventListener("change", () => {
  const on = document.getElementById("autoScrollToggle").checked;
  if (on && currentIdx >= 0) {
    scrollToIndex(currentIdx);
  }
});

document.getElementById("scrollCurrent").addEventListener("click", () => iina.postMessage("scrollToCurrent", {}));

document.getElementById("live").addEventListener("click", () => {
  if (typeof liveStart === "number") iina.postMessage("seekTo", { time: liveStart });
});

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#ctxMenu")) closeContextMenu();
});
document.getElementById("list").addEventListener("scroll", closeContextMenu);
window.addEventListener("blur", closeContextMenu);
// Right-clicking outside a row should dismiss rather than show WebKit's own menu.
document.addEventListener("contextmenu", (e) => { e.preventDefault(); closeContextMenu(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
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

  const liveIds = new Set(rows.map(x => x.id));
  for (const id of [...selected]) if (!liveIds.has(id)) selected.delete(id);
  if (editingId != null && !liveIds.has(editingId)) editingId = null;

  const el = document.getElementById("meta");
  if (meta?.error) el.innerText = `Error: ${meta.error}`;
  else el.innerText = `Rows: ${meta?.count ?? rows.length}`;

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

iina.onMessage("liveSubtitle", (data) => {
  document.getElementById("liveText").innerText = data?.text || "";
  liveStart = (typeof data?.start === "number") ? data.start : null;
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
