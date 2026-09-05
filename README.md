# Subtitle Navigator for IINA

A standalone window for browsing, searching and **editing** subtitles in **IINA** on macOS.

---

## ⚠️ About this fork — please read

This is a fork of [CoderChen01/IINA-subtitle-navigator](https://github.com/CoderChen01/IINA-subtitle-navigator),
which was built as a **language-learning** tool.

**This fork is not aimed at language learning.** I use it to read and repair subtitle
files. I have not removed any of the original's learning features — line looping,
copy-to-notes, the sub-delay compensation — but I don't use them, and I haven't
tested them. Treat those as inherited rather than supported.

Like the original, this is provided **as-is** with no promise of maintenance.

### What's different from the original

- **Subtitle editing.** Edit any line in place and it is written back to the `.srt`.
  Saving happens on its own, edits are undoable, and find & replace works across the
  whole file.
- **A restructured interface.** Row actions moved onto a right-click context menu,
  buttons that duplicated what IINA already does were dropped, and what remains is
  grouped by what it acts on — the file, the search, the list, playback.

---

## ✨ Features

### Core
- **Standalone window**, not a sidebar panel
- **Select subtitle track** (external `.srt`)
- **Robust SRT parsing**
  - Supports `,` and `.` millisecond formats
  - Handles irregular spacing and BOM
  - Removes style tags like `{...}`
- **Filters non-dialog overlays** — top-of-screen annotations such as `{\an7}`, `{\an8}`, `{\an9}`

### Navigation
- **Clickable subtitle list** — click a line to jump there
- **Scroll to current subtitle**, and an optional auto-scroll that follows playback
- **Loop a line** from the right-click menu, until you stop it there
- **Search subtitles**, with an `Aa` match-case toggle and match highlighting
- **Replace** one match at a time, or **All** at once
- **Multi-select**, then right-click the selection to copy every line at once

### Editing
- **Right-click a line for a context menu**: edit, jump, loop, copy
- While editing, `Enter` commits, `Shift+Enter` adds a newline, `Escape` cancels
- `Cmd+Enter` edits the line playing right now
- **Undo and redo** with `⌘Z` / `⇧⌘Z`, or the toolbar buttons. One step is one
  action, so a Replace All across a hundred lines undoes in a single press
- **Saving is invisible.** There is no dirty marker and no Save step: an edit is
  written to the `.srt` shortly after you stop typing, and the subtitle track
  reloads so the fix shows up in playback
- A run of edits batches into **one** write and **one** reload
- **If a save fails, the line reverts** to what the file actually contains, and the
  discarded text is shown so you can type it back in — the list never claims an
  edit the `.srt` does not have
- **A backup is made before the first write**: `yourfile.srt` → `yourfile.srt.bak`,
  and it keeps the pristine original even across sessions
- Writes are **atomic** — the file is replaced by rename, never truncated in place

Only the lines you actually edit are rewritten. Everything else in the file —
cue numbering, timestamp formatting, style tags, and any cues the parser skips —
is preserved exactly as it was.

> Editing a line that contained `{...}` style tags drops those tags from that line,
> because the editor works on the cleaned text the list displays.

### Timing
- Automatically compensates **mpv `sub-delay`**
- Built for **long videos (hours+)**

---

## 📦 Installation

### Requirements
- macOS
- **IINA ≥ 1.4**
- mpv ≥ 0.38
- External subtitles (`.srt`)

### Install
1. Download the latest `.iinaplgz` from **Releases**
2. Open IINA → **Plugins** → **Install Plugin…**
3. Enable the plugin

The window opens automatically once the plugin is enabled.

This fork uses its own plugin identifier, so it installs alongside the original
rather than replacing it.

### Build from source

```bash
./scripts/build.sh    # -> dist/SubtitleNavigator-<version>.iinaplgz
```

The release workflow runs this same script, so a local build matches a released one.

### Develop

```bash
./scripts/dev.sh             # IINA loads this working copy directly
./scripts/dev.sh --unlink    # stop loading it
```

Reload the plugin in IINA to pick up edits. No rebuild or reinstall.

---

## 🚀 Usage

### Reopen the window
If you close it:

- **Menu**: `IINA → Plugins → Show Subtitle Navigator`
- **Shortcut**: `Cmd + Shift + S`

### Typical workflow
1. Load a video with external `.srt` subtitles
2. Open Subtitle Navigator
3. Search for the line you want
4. Right-click → **Edit text** to fix it, or use **Replace** to fix it everywhere
5. It saves itself — `⌘Z` if you change your mind

---

## ⚠️ Limitations
- Only `.srt` supported
- Embedded subtitles not parsed as text
- Single subtitle track by design
- Editing changes subtitle **text** only — timestamps are not editable
- Saving normalizes CRLF line endings to LF
- Edits are written without confirmation. `⌘Z` undoes them within the session; the
  `.srt.bak` backup is the escape hatch of last resort, and it holds the original
  file rather than the previous save
- The undo history is per session and per file: closing the window or switching
  subtitle track clears it
- The language-learning features inherited from the original are untested here

---

## 📄 License

MIT License

---

## 🙏 Acknowledgements
- **[CoderChen01/IINA-subtitle-navigator](https://github.com/CoderChen01/IINA-subtitle-navigator)**
  by Junjie Chen — the original plugin this is forked from. The subtitle list,
  SRT parsing, looping and timing work are theirs.
- IINA team
- mpv project
