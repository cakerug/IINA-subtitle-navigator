"use strict";

// The one place a keyboard shortcut is defined.
//
// Every entry carries both how it is *matched* and how it is *shown*, so the help
// panel, the context-menu hints and the keydown dispatcher all read the same rows.
// Adding a shortcut anywhere else would mean it never appears under "?" -- which is
// exactly the drift this table exists to stop, and what test/shortcuts.test.js
// checks for.
//
// Loaded as a plain script in the WebView (defining the `Shortcuts` global) and
// required directly by the tests.
const Shortcuts = (() => {

  // Where a shortcut applies. The dispatcher is told which one is active, so a key
  // can mean different things in the list and inside a text field.
  const CONTEXTS = {
    list: "In the subtitle list",
    editing: "While editing a line",
    find: "In the search and replace fields",
  };

  const cmd = (e) => e.metaKey || e.ctrlKey;
  const plain = (e) => !e.metaKey && !e.ctrlKey && !e.altKey;

  /**
   * `action` is the id window.js maps to a function; a null action is a native
   * behaviour that is documented but not dispatched. Order matters: the first
   * entry whose context and matcher both hit wins, so more specific modifier
   * combinations come first.
   */
  const ALL = [
    // -- list --------------------------------------------------------------
    {
      action: "editFocused", context: "list", display: "⌘⏎",
      label: "Edit the focused line (falls back to the playing line)",
      match: (e) => e.key === "Enter" && cmd(e) && !e.altKey,
    },
    {
      action: "jumpToFocused", context: "list", display: "⏎",
      label: "Jump playback to the focused line",
      match: (e) => e.key === "Enter" && plain(e),
    },
    {
      action: "redo", context: "list", display: "⇧⌘Z",
      label: "Redo",
      match: (e) => cmd(e) && e.shiftKey && e.key.toLowerCase() === "z",
    },
    {
      action: "undo", context: "list", display: "⌘Z",
      label: "Undo",
      match: (e) => cmd(e) && !e.shiftKey && e.key.toLowerCase() === "z",
    },
    {
      action: "moveDown", context: "list", display: "J / ↓",
      label: "Move down the list",
      match: (e) => plain(e) && (e.key === "j" || e.key === "ArrowDown"),
    },
    {
      action: "moveUp", context: "list", display: "K / ↑",
      label: "Move up the list",
      match: (e) => plain(e) && (e.key === "k" || e.key === "ArrowUp"),
    },
    {
      // Space on a focused button is that button's own activation key, so it is left
      // alone there rather than stolen for playback.
      action: "togglePause", context: "list", display: "Space",
      label: "Play or pause",
      match: (e) => plain(e) && e.key === " " && e.target?.tagName !== "BUTTON",
    },
    {
      action: "escape", context: "list", display: "Esc",
      label: "Scroll to the playing line; press again to toggle auto-scroll",
      match: (e) => e.key === "Escape",
    },

    // -- editing a line ----------------------------------------------------
    {
      action: "commitEdit", context: "editing", display: "⏎",
      label: "Commit the edit",
      match: (e) => e.key === "Enter" && !e.shiftKey,
    },
    {
      action: null, context: "editing", display: "⇧⏎",
      label: "Add a line break",
      match: (e) => e.key === "Enter" && e.shiftKey,
    },
    {
      action: "cancelEdit", context: "editing", display: "Esc",
      label: "Cancel the edit",
      match: (e) => e.key === "Escape",
    },

    // -- search and replace ------------------------------------------------
    {
      action: "prevMatch", context: "find", display: "⇧⏎",
      label: "Previous match",
      match: (e) => e.key === "Enter" && !cmd(e) && e.shiftKey,
    },
    {
      action: "nextMatch", context: "find", display: "⏎",
      label: "Next match (or Replace, from the replace field)",
      match: (e) => e.key === "Enter" && !cmd(e) && !e.shiftKey,
    },
    {
      action: "closeFind", context: "find", display: "Esc",
      label: "Close the replace row",
      match: (e) => e.key === "Escape",
    },
    {
      action: null, context: "find", display: "⌘Z",
      label: "Undoes your typing, not your edits — the field keeps its own history",
      match: () => false,
    },
  ];

  /** Extra help lines that are not keyboard shortcuts. */
  const NOTES = [
    "Right-click a line for edit, jump, loop and copy actions.",
    "Shift-click or ⌘-click to select several lines, then right-click to copy them.",
  ];

  /**
   * Runs the first entry in `context` that matches, via `handlers[action]`.
   * Returns true when something ran, so the caller can preventDefault.
   */
  function dispatch(event, context, handlers) {
    for (const s of ALL) {
      if (s.context !== context || !s.action) continue;
      if (!s.match(event)) continue;
      const fn = handlers[s.action];
      if (!fn) continue;
      fn(event);
      return true;
    }
    return false;
  }

  /** The display string for one action, for a context-menu hint. */
  function display(action) {
    return ALL.find(s => s.action === action)?.display || "";
  }

  /** The help panel's content: every entry, grouped by context, plus the notes. */
  function helpSections() {
    return Object.entries(CONTEXTS).map(([context, title]) => ({
      title,
      items: ALL.filter(s => s.context === context).map(s => ({ display: s.display, label: s.label })),
    }));
  }

  return { ALL, CONTEXTS, NOTES, dispatch, display, helpSections };
})();

// Present in Node, absent in the WebView, where the `Shortcuts` binding is the export.
if (typeof module !== "undefined" && module.exports) module.exports = Shortcuts;
