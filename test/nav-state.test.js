"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Nav = require("../ui/state.js");

/** Rows the way main.js posts them: sorted by start, ids are cue indices. */
function rows(...spans) {
  return spans.map(([start, end], i) => ({ id: i, start, end, text: `line ${i}` }));
}

const THREE = rows([10, 12], [20, 22], [30, 32]);

function loaded(overrides = {}) {
  const s = Nav.create();
  Nav.setRows(s, THREE, { isNewFile: true });
  return Object.assign(s, overrides);
}

/** findRowAtTime */

test("a time inside a row resolves to that row", () => {
  assert.equal(Nav.findRowAtTime(THREE, 21), 1);
});

test("a time in the gap between rows resolves to the row that just ended", () => {
  assert.equal(Nav.findRowAtTime(THREE, 15), 0);
});

test("a time before the first row resolves to nothing", () => {
  assert.equal(Nav.findRowAtTime(THREE, 3), -1);
});

test("a time past the last row stays on the last row", () => {
  assert.equal(Nav.findRowAtTime(THREE, 999), 2);
});

test("row boundaries are inclusive on both sides", () => {
  assert.equal(Nav.findRowAtTime(THREE, 10), 0);
  assert.equal(Nav.findRowAtTime(THREE, 12), 0);
});

test("an empty list resolves to nothing", () => {
  assert.equal(Nav.findRowAtTime([], 5), -1);
});

/** Auto-scroll on load -- regression for "the list stayed parked until the next row" */

test("loading a file asks for the current time so the list can jump to it", () => {
  const s = Nav.create();
  const fx = Nav.setRows(s, THREE, { isNewFile: true });
  assert.equal(fx.scrollToCurrent, true);
});

test("loading a file with auto-scroll off does not jump", () => {
  const s = Nav.create();
  s.autoScroll = false;
  assert.equal(Nav.setRows(s, THREE, { isNewFile: true }).scrollToCurrent, false);
});

test("re-posted rows for the same file do not re-jump", () => {
  const s = loaded();
  assert.equal(Nav.setRows(s, THREE, { isNewFile: false }).scrollToCurrent, false);
});

test("a tick scrolls to the playing row even when the index did not change", () => {
  // The bug: resolving rows already put currentIdx on the playing row, so the tick
  // saw no change and never scrolled. The list stayed at the top until playback
  // crossed into the next row.
  const s = loaded();
  Nav.setRows(s, THREE, { isNewFile: false });
  s.time = 21;
  s.currentIdx = 1;          // resolved by a render, but nothing has scrolled
  s.lastScrolledIdx = -1;

  const fx = Nav.tick(s, 21);
  assert.equal(fx.scrollTo, 1, "the row must be brought into view");
});

test("a tick does not re-scroll to a row already scrolled to", () => {
  const s = loaded();
  Nav.tick(s, 21);
  assert.equal(Nav.tick(s, 21.5).scrollTo, null);
});

test("a tick does not scroll when playback is before the first row", () => {
  const s = loaded();
  assert.equal(Nav.tick(s, 2).scrollTo, null);
});

test("a tick does not scroll while auto-scroll is off", () => {
  const s = loaded({ autoScroll: false });
  assert.equal(Nav.tick(s, 21).scrollTo, null);
});

test("a tick neither renders nor scrolls while an editor is open", () => {
  const s = loaded({ editing: true });
  const fx = Nav.tick(s, 21);
  assert.equal(fx.render, false);
  assert.equal(fx.scrollTo, null);
});

/** Follow mode */

test("following moves the selection onto the current row as playback advances", () => {
  const s = loaded();
  Nav.jumpToTime(s, 11);
  assert.deepEqual([...s.selected], [0]);

  Nav.tick(s, 21);
  assert.deepEqual([...s.selected], [1], "the selection rides the current line");
});

test("following clears the selection when playback drops before the first row", () => {
  const s = loaded();
  Nav.jumpToTime(s, 21);
  Nav.tick(s, 2);
  assert.deepEqual([...s.selected], [], "no row to ride, so nothing stays outlined");
});

test("browsing with j/k breaks follow mode, so playback stops dragging the selection", () => {
  const s = loaded();
  Nav.jumpToTime(s, 11);
  Nav.moveFocus(s, 1);
  assert.equal(s.followCurrent, false);

  Nav.tick(s, 21);
  assert.deepEqual([...s.selected], [1], "stays where the user put it");
  assert.equal(s.focusPos, 1);
});

test("browsing with j/k turns auto-scroll off, once, with a notice", () => {
  const s = loaded();
  const first = Nav.moveFocus(s, 1);
  assert.equal(first.autoScroll, false);
  assert.equal(first.notice, "Auto-scroll off");

  const second = Nav.moveFocus(s, 1);
  assert.equal(second.autoScroll, null, "already off, so nothing to announce");
  assert.equal(second.notice, null);
});

test("j/k starts from the playing row when nothing has been picked yet", () => {
  const s = loaded();
  Nav.tick(s, 21);
  Nav.moveFocus(s, 1);
  assert.equal(s.focusPos, 2);
});

test("j/k stops at the ends of the list", () => {
  const s = loaded();
  s.focusPos = 0;
  Nav.moveFocus(s, -1);
  assert.equal(s.focusPos, 0);
  s.focusPos = 2;
  Nav.moveFocus(s, 1);
  assert.equal(s.focusPos, 2);
});

test("a plain click seeks and re-arms following", () => {
  const s = loaded();
  Nav.moveFocus(s, 1);
  const fx = Nav.clickRow(s, 2);
  assert.equal(fx.seekTo, 30);
  assert.equal(s.followCurrent, true);
});

test("a multi-select click breaks following without seeking", () => {
  const s = loaded();
  Nav.jumpToTime(s, 11);
  const fx = Nav.clickRow(s, 2, { toggle: true });
  assert.equal(fx.seekTo, null);
  assert.equal(s.followCurrent, false);
  assert.deepEqual([...s.selected].sort(), [0, 2]);
});

test("a shift-click selects the range from the last picked row", () => {
  const s = loaded();
  Nav.clickRow(s, 0);
  Nav.clickRow(s, 2, { range: true });
  assert.deepEqual([...s.selected].sort(), [0, 1, 2]);
  assert.equal(s.followCurrent, false);
});

test("Enter on the focused row seeks and re-arms following", () => {
  const s = loaded();
  Nav.moveFocus(s, 1);
  const fx = Nav.activateFocused(s);
  assert.equal(fx.seekTo, 20);
  assert.equal(s.followCurrent, true);
});

/** Escape -- regression for "the first press toggled auto-scroll instead of scrolling" */

test("Escape scrolls to the current line when it is off screen", () => {
  const s = loaded();
  Nav.tick(s, 21);
  const fx = Nav.escape(s, { currentRowVisible: false });
  assert.equal(fx.scrollToCurrent, true);
  assert.equal(fx.autoScroll, null, "the setting must not be flipped just to get there");
  assert.equal(s.autoScroll, true);
});

test("Escape does not toggle auto-scroll merely because focus has never moved", () => {
  // The bug: focusedPos() falls back to currentIdx, so on a fresh window
  // "focus === current" was true before the user had touched anything, and the very
  // first Escape turned auto-scroll off instead of scrolling.
  const s = loaded({ autoScroll: false });
  Nav.tick(s, 21);
  assert.equal(s.focusPos, null, "nothing has been picked");
  assert.equal(Nav.escape(s, { currentRowVisible: false }).scrollToCurrent, true);
  assert.equal(s.autoScroll, false, "still off");
});

test("Escape with the current line already in view toggles auto-scroll", () => {
  const s = loaded();
  Nav.tick(s, 21);
  const off = Nav.escape(s, { currentRowVisible: true });
  assert.equal(off.autoScroll, false);
  assert.equal(off.notice, "Auto-scroll off");

  const on = Nav.escape(s, { currentRowVisible: true });
  assert.equal(on.autoScroll, true);
  assert.equal(on.scrollToCurrent, true);
  assert.equal(s.followCurrent, true);
});

test("Escape with no current row asks for the time rather than toggling", () => {
  const s = loaded();
  Nav.tick(s, 2);
  const fx = Nav.escape(s, { currentRowVisible: true });
  assert.equal(fx.scrollToCurrent, true);
  assert.equal(fx.autoScroll, null);
});

test("two Escapes get back to the current line and then toggle, as the help says", () => {
  const s = loaded();
  Nav.tick(s, 21);
  Nav.moveFocus(s, -1);                                 // browse away; auto-scroll off
  assert.equal(Nav.escape(s, { currentRowVisible: false }).scrollToCurrent, true);
  Nav.jumpToTime(s, 21);                                // the round trip lands here
  assert.equal(Nav.escape(s, { currentRowVisible: true }).autoScroll, true);
});

/** The auto-scroll checkbox */

test("switching auto-scroll on jumps to the current line", () => {
  const s = loaded({ autoScroll: false });
  Nav.tick(s, 21);
  assert.equal(Nav.setAutoScroll(s, true).scrollToCurrent, true);
});

test("switching auto-scroll on before the first line does not jump", () => {
  const s = loaded({ autoScroll: false });
  Nav.tick(s, 2);
  assert.equal(Nav.setAutoScroll(s, false).scrollToCurrent, false);
});

test("switching auto-scroll off stops the selection following playback", () => {
  const s = loaded();
  Nav.jumpToTime(s, 11);
  Nav.setAutoScroll(s, false);
  assert.equal(s.followCurrent, false);
});

/** Resize */

test("a resize puts the current row back where it belongs", () => {
  const s = loaded();
  Nav.tick(s, 21);
  assert.equal(Nav.resize(s).scrollTo, 1);
});

test("a resize leaves an open editor alone", () => {
  const s = loaded({ editing: true });
  s.currentIdx = 1;
  assert.equal(Nav.resize(s).scrollTo, null);
});

test("a resize does nothing while auto-scroll is off", () => {
  const s = loaded({ autoScroll: false });
  s.currentIdx = 1;
  assert.equal(Nav.resize(s).scrollTo, null);
});

/** Rows changing underneath the state */

test("a new file drops the selection, the focus and the follow arming", () => {
  const s = loaded();
  Nav.jumpToTime(s, 11);
  Nav.setRows(s, rows([1, 2]), { isNewFile: true });
  assert.deepEqual([...s.selected], []);
  assert.equal(s.focusPos, null);
  assert.equal(s.followCurrent, false);
  assert.equal(s.lastScrolledIdx, -1);
});

test("an edit to the same file keeps the selection on rows that still exist", () => {
  const s = loaded();
  s.selected = new Set([0, 2]);
  Nav.setRows(s, rows([10, 12], [20, 22]), { isNewFile: false });
  assert.deepEqual([...s.selected], [0], "row id 2 is gone");
});

test("narrowing the search drops a focus position that no longer exists", () => {
  const s = loaded();
  Nav.clickRow(s, 2);
  Nav.setRows(s, THREE.slice(0, 1), { isNewFile: false });
  assert.equal(s.focusPos, null);
});

/** Scrolling the list by hand */

test("wheel-scrolling the list turns auto-scroll off, like j/k does", () => {
  const s = loaded();
  Nav.jumpToTime(s, 11);
  const fx = Nav.browseAway(s);
  assert.equal(fx.autoScroll, false);
  assert.equal(fx.notice, "Auto-scroll off");
  assert.equal(s.followCurrent, false);
});

test("wheel-scrolling with auto-scroll already off says nothing", () => {
  const s = loaded({ autoScroll: false });
  assert.equal(Nav.browseAway(s).notice, null);
});

test("after scrolling away by hand, a tick no longer pulls the list back", () => {
  const s = loaded();
  Nav.browseAway(s);
  assert.equal(Nav.tick(s, 21).scrollTo, null);
});
