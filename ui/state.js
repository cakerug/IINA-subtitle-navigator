"use strict";

// Navigation state for the subtitle list: where playback is, what is selected, what
// auto-scroll has already brought into view, and whether the selection is riding the
// current line.
//
// It holds no DOM. Every entry point takes the current state plus whatever the DOM
// layer had to measure, and returns the *effects* to carry out -- so the rules can be
// tested without a browser, and window.js is left doing nothing but wiring.
//
// Loaded as a plain script in the WebView (defining the `Nav` global) and required
// directly by the tests.
const Nav = (() => {

  /** Effects the DOM layer knows how to perform. Absent field == nothing to do. */
  function effects(fields) {
    return Object.assign({
      render: false,        // rebuild the list
      scrollTo: null,       // bring this position into view
      seekTo: null,         // ask main.js to move playback to this time
      scrollToCurrent: false, // ask main.js for the authoritative playback time
      autoScroll: null,     // set the auto-scroll checkbox to this
      notice: null,         // show this message
    }, fields);
  }

  function create() {
    return {
      // Rows currently displayed, i.e. after the search filter. Positions everywhere
      // in this module index into this array, never into the unfiltered list.
      rows: [],
      time: 0,
      // Position of the row playback is on, or -1 when it is before the first row.
      currentIdx: -1,
      // Position auto-scroll last brought into view. Tracked apart from currentIdx
      // because resolving currentIdx from the clock does not scroll anything: on load
      // currentIdx can already name the playing row with the list still at the top.
      lastScrolledIdx: -1,
      // Where j/k and the arrows act. Null until the user actually picks a row --
      // distinct from "happens to equal currentIdx", which is what makes it possible
      // to tell a deliberate park on the current line from never having moved.
      focusPos: null,
      // Row ids, not positions, so a selection survives re-renders and search changes.
      selected: new Set(),
      // Keeps the selection riding the current line as playback advances. Armed by
      // anything that jumps playback to a line; broken by browsing without seeking.
      followCurrent: false,
      autoScroll: true,
      editing: false,
    };
  }

  /**
   * Position of the row containing `t`, else the last row that has already ended,
   * else -1 when `t` is before the first row. Rows are sorted by start.
   */
  function findRowAtTime(rows, t) {
    let lo = 0, hi = rows.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = rows[mid];
      if (t < r.start) hi = mid - 1;
      else if (t > r.end) { best = mid; lo = mid + 1; }
      else return mid;
    }
    return best;
  }

  /**
   * Where a keyboard move starts from. Falls back to the playing row so the first
   * press moves from wherever playback is, not from the top of the list.
   */
  function focusedPos(state) {
    if (state.focusPos != null && state.rows[state.focusPos]) return state.focusPos;
    return state.currentIdx >= 0 ? state.currentIdx : (state.rows.length ? 0 : -1);
  }

  function selectPos(state, pos) {
    const r = state.rows[pos];
    if (!r) return false;
    state.selected = new Set([r.id]);
    state.focusPos = pos;
    return true;
  }

  /** Rows replaced, e.g. by a new file, an edit, or a change to the search filter. */
  function setRows(state, rows, { isNewFile = false } = {}) {
    state.rows = rows;
    // A filter change can invalidate a stale position, and ids are the only thing
    // that survives it.
    const anchor = state.focusPos != null ? state.rows[state.focusPos] : null;
    state.focusPos = anchor ? state.focusPos : null;
    state.currentIdx = findRowAtTime(rows, state.time);

    if (isNewFile) {
      state.lastScrolledIdx = -1;
      state.followCurrent = false;
      state.focusPos = null;
      state.selected = new Set();
    } else {
      const live = new Set(rows.map(r => r.id));
      for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);
    }

    // A fresh file may start mid-playback (IINA resuming a video), so jump to where
    // the video already is instead of leaving the list parked at the top.
    return effects({
      render: true,
      scrollToCurrent: isNewFile && rows.length > 0 && state.autoScroll,
    });
  }

  /** A playback tick, in subtitle-file time. */
  function tick(state, t) {
    state.time = t;
    // Re-rendering would tear down an open editor mid-typing, or yank the context
    // menu out from under the pointer as playback advances.
    if (state.editing) return effects({});

    const idx = findRowAtTime(state.rows, t);
    const moved = idx !== state.currentIdx;
    state.currentIdx = idx;

    let render = false;
    if (moved) {
      if (state.followCurrent && idx !== -1) {
        selectPos(state, idx);
      } else if (state.followCurrent) {
        // Playback sits before the first line, so there is no row to ride. Left
        // alone, the outline would stay behind claiming to be the followed row.
        state.selected = new Set();
        state.focusPos = null;
      }
      render = true;
    }

    // Deliberately not gated on `moved`: a row can become current without the index
    // changing here, because resolving it elsewhere already moved currentIdx onto it.
    // Comparing against what was actually scrolled to catches those too.
    let scrollTo = null;
    if (state.autoScroll && idx !== -1 && idx !== state.lastScrolledIdx) {
      state.lastScrolledIdx = idx;
      scrollTo = idx;
    }
    return effects({ render, scrollTo });
  }

  /**
   * The authoritative playback time, in answer to a Scroll to Current request. Arms
   * follow mode, so the selection keeps riding the current line until a manual
   * navigation breaks it.
   */
  function jumpToTime(state, t) {
    state.time = t;
    const idx = findRowAtTime(state.rows, t);
    state.currentIdx = idx;
    if (idx === -1) return effects({ render: true });
    state.followCurrent = true;
    selectPos(state, idx);
    state.lastScrolledIdx = idx;
    return effects({ render: true, scrollTo: idx });
  }

  /**
   * The user moved through the list themselves, by key or by wheel. Auto-scroll has
   * to give way: left on, the next playback tick would pull the list back out from
   * under whatever they just moved to.
   */
  function browseAway(state) {
    state.followCurrent = false;
    if (!state.autoScroll) return effects({});
    state.autoScroll = false;
    return effects({ autoScroll: false, notice: "Auto-scroll off" });
  }

  /** j/k or the arrow keys. */
  function moveFocus(state, delta) {
    if (!state.rows.length) return effects({});
    const fx = browseAway(state);

    const from = Math.max(focusedPos(state), 0);
    const pos = Math.max(0, Math.min(state.rows.length - 1, from + delta));
    selectPos(state, pos);
    return effects({ ...fx, render: true, scrollTo: pos });
  }

  /** A click on a row. `mods` is { range, toggle } from the mouse event. */
  function clickRow(state, pos, mods = {}) {
    const r = state.rows[pos];
    if (!r) return effects({});

    if (mods.range && state.focusPos != null) {
      state.followCurrent = false;
      const a = Math.min(state.focusPos, pos);
      const b = Math.max(state.focusPos, pos);
      state.selected = new Set();
      for (let k = a; k <= b; k++) if (state.rows[k]) state.selected.add(state.rows[k].id);
      return effects({ render: true });
    }

    if (mods.toggle) {
      state.followCurrent = false;
      if (state.selected.has(r.id)) state.selected.delete(r.id);
      else state.selected.add(r.id);
      state.focusPos = pos;
      return effects({ render: true });
    }

    // A plain click jumps playback here, so following picks back up from this line.
    state.followCurrent = true;
    selectPos(state, pos);
    return effects({ render: true, seekTo: r.start });
  }

  /** Enter on the focused row: jump playback there, same arming as a plain click. */
  function activateFocused(state) {
    const pos = focusedPos(state);
    const r = state.rows[pos];
    if (!r) return effects({});
    state.followCurrent = true;
    selectPos(state, pos);
    return effects({ render: true, seekTo: r.start });
  }

  /**
   * Escape outside editing. Whether the current line is already in view is the thing
   * that decides the meaning, so the DOM layer measures it and passes it in: off
   * screen, Escape goes back to the current line; already there, it is a shortcut for
   * the auto-scroll toggle. Asking whether focus merely *equals* currentIdx would
   * read a never-moved focus as a deliberate park on the current line, and toggle on
   * the very first press.
   */
  function escape(state, { currentRowVisible = false } = {}) {
    if (state.currentIdx === -1 || !currentRowVisible) {
      return effects({ scrollToCurrent: true });
    }
    const on = !state.autoScroll;
    state.autoScroll = on;
    if (on) state.followCurrent = true;
    else state.followCurrent = false;
    return effects({
      autoScroll: on,
      scrollToCurrent: on,
      notice: on ? "Auto-scroll on" : "Auto-scroll off",
    });
  }

  /** The auto-scroll checkbox was clicked directly. */
  function setAutoScroll(state, on) {
    state.autoScroll = on;
    if (on) return effects({ scrollToCurrent: state.currentIdx >= 0 });
    state.followCurrent = false;
    return effects({});
  }

  /**
   * The pane was resized. Auto-scroll only fires when playback crosses into the next
   * line, so a resize would otherwise leave the current row wherever it landed -- and
   * possibly positioned by the wrong rule, since the read-ahead vs. centered choice
   * depends on pane height.
   */
  function resize(state) {
    if (state.editing) return effects({});
    if (!state.autoScroll || state.currentIdx === -1) return effects({});
    return effects({ scrollTo: state.currentIdx });
  }

  return {
    create,
    effects,
    findRowAtTime,
    focusedPos,
    selectPos,
    setRows,
    tick,
    browseAway,
    jumpToTime,
    moveFocus,
    clickRow,
    activateFocused,
    escape,
    setAutoScroll,
    resize,
  };
})();

// Present in Node, absent in the WebView, where the `Nav` binding above is the export.
if (typeof module !== "undefined" && module.exports) module.exports = Nav;
