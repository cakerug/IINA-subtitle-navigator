"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Shortcuts = require("../ui/shortcuts.js");

const WINDOW_JS = fs.readFileSync(path.join(__dirname, "..", "ui", "window.js"), "utf8");

/** A KeyboardEvent's shape, as far as the matchers care. */
function key(k, mods = {}) {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

function fired(event, context) {
  const calls = [];
  const handlers = Object.fromEntries(
    Shortcuts.ALL.filter(s => s.action).map(s => [s.action, () => calls.push(s.action)]),
  );
  const handled = Shortcuts.dispatch(event, context, handlers);
  return { handled, calls };
}

/** The table is the source of truth for the help panel */

test("every shortcut carries what the help panel needs to show it", () => {
  for (const s of Shortcuts.ALL) {
    assert.ok(s.display, `${s.action || "(native)"} has no display string`);
    assert.ok(s.label, `${s.action || "(native)"} has no label`);
    assert.ok(s.context in Shortcuts.CONTEXTS, `${s.action} has an unknown context`);
  }
});

test("the help panel lists every shortcut in the table", () => {
  const shown = Shortcuts.helpSections().flatMap(sec => sec.items.map(i => i.label));
  assert.equal(shown.length, Shortcuts.ALL.length);
  for (const s of Shortcuts.ALL) assert.ok(shown.includes(s.label), `${s.label} is missing from the help`);
});

test("no two shortcuts in the same context claim the same key combination", () => {
  const probes = [
    key("Enter"), key("Enter", { shiftKey: true }), key("Enter", { metaKey: true }),
    key("Escape"), key(" "), key("j"), key("k"), key("ArrowUp"), key("ArrowDown"),
    key("z", { metaKey: true }), key("z", { metaKey: true, shiftKey: true }),
  ];
  for (const context of Object.keys(Shortcuts.CONTEXTS)) {
    for (const e of probes) {
      const hits = Shortcuts.ALL.filter(s => s.context === context && s.action && s.match(e));
      // More than one is only a bug when they would run different things; the
      // dispatcher takes the first, so a shadowed second entry is dead.
      assert.ok(hits.length <= 1, `${context}: ${JSON.stringify(e)} matches ${hits.map(h => h.action)}`);
    }
  }
});

/** window.js must not grow its own key handling behind the table's back */

test("window.js dispatches keys through the table rather than comparing them itself", () => {
  // The whole point of the table is that a new shortcut cannot be added without
  // appearing under "?". An ad-hoc `e.key === ...` in window.js would route around it.
  const adHoc = WINDOW_JS.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\be\.key\b|\bevent\.key\b/.test(line))
    .filter(([, line]) => !line.trim().startsWith("//"));
  assert.deepEqual(adHoc, [], "add the shortcut to ui/shortcuts.js instead");
});

test("window.js provides a handler for every dispatchable action", () => {
  const declared = new Set(
    [...WINDOW_JS.matchAll(/^\s{2}([A-Za-z]+):/gm)].map(m => m[1]),
  );
  for (const s of Shortcuts.ALL) {
    if (!s.action) continue;
    assert.ok(declared.has(s.action), `no handler named "${s.action}" in ui/window.js`);
  }
});

/** Dispatch */

test("Enter in the list jumps, and ⌘Enter edits", () => {
  assert.deepEqual(fired(key("Enter"), "list").calls, ["jumpToFocused"]);
  assert.deepEqual(fired(key("Enter", { metaKey: true }), "list").calls, ["editFocused"]);
  assert.deepEqual(fired(key("Enter", { ctrlKey: true }), "list").calls, ["editFocused"]);
});

test("⌘Z undoes and ⇧⌘Z redoes", () => {
  assert.deepEqual(fired(key("z", { metaKey: true }), "list").calls, ["undo"]);
  assert.deepEqual(fired(key("Z", { metaKey: true, shiftKey: true }), "list").calls, ["redo"]);
});

test("j/k and the arrows move through the list", () => {
  assert.deepEqual(fired(key("j"), "list").calls, ["moveDown"]);
  assert.deepEqual(fired(key("ArrowDown"), "list").calls, ["moveDown"]);
  assert.deepEqual(fired(key("k"), "list").calls, ["moveUp"]);
  assert.deepEqual(fired(key("ArrowUp"), "list").calls, ["moveUp"]);
});

test("a modifier keeps j/k from stealing a system shortcut", () => {
  assert.equal(fired(key("j", { metaKey: true }), "list").handled, false);
  assert.equal(fired(key("ArrowDown", { altKey: true }), "list").handled, false);
});

test("Space plays or pauses from the list", () => {
  assert.deepEqual(fired(key(" "), "list").calls, ["togglePause"]);
});

test("list shortcuts do not fire inside a text field", () => {
  // Regression: Escape used to be handled before the field check, so pressing it in
  // the search box toggled auto-scroll as well as clearing the field's own state.
  for (const k of [key(" "), key("j"), key("Escape"), key("ArrowDown")]) {
    assert.equal(fired(k, "find").calls.includes("togglePause"), false);
    assert.equal(fired(k, "find").calls.includes("escape"), false);
    assert.equal(fired(k, "find").calls.includes("moveDown"), false);
  }
});

test("Escape means cancel while editing and close while searching", () => {
  assert.deepEqual(fired(key("Escape"), "editing").calls, ["cancelEdit"]);
  assert.deepEqual(fired(key("Escape"), "find").calls, ["closeFind"]);
  assert.deepEqual(fired(key("Escape"), "list").calls, ["escape"]);
});

test("Enter commits an edit but Shift+Enter is left to the textarea", () => {
  assert.deepEqual(fired(key("Enter"), "editing").calls, ["commitEdit"]);
  assert.equal(fired(key("Enter", { shiftKey: true }), "editing").handled, false);
});

test("Enter and Shift+Enter walk the matches in the search field", () => {
  assert.deepEqual(fired(key("Enter"), "find").calls, ["nextMatch"]);
  assert.deepEqual(fired(key("Enter", { shiftKey: true }), "find").calls, ["prevMatch"]);
});

test("an unbound key is reported as unhandled, so the browser keeps it", () => {
  assert.equal(fired(key("q"), "list").handled, false);
  assert.equal(fired(key("Tab"), "list").handled, false);
});

test("a missing handler is skipped rather than thrown on", () => {
  assert.equal(Shortcuts.dispatch(key("j"), "list", {}), false);
});

/** Hints reused by the context menu */

test("the context menu can read a shortcut's display string from the table", () => {
  assert.equal(Shortcuts.display("editFocused"), "⌘⏎");
  assert.equal(Shortcuts.display("jumpToFocused"), "⏎");
  assert.equal(Shortcuts.display("nope"), "");
});
