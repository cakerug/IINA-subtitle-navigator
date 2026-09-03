# Subtitle Navigator — architecture notes

Recon notes taken before adding subtitle editing.

## Two contexts, one message bus

| Context | File | Globals |
| --- | --- | --- |
| Plugin main | `main.js` | `iina.{core, standaloneWindow, event, mpv, file, utils, console, menu}` |
| WebView UI | `ui/window.js` (+ `window.html`, `window.css`) | `iina.{postMessage, onMessage}` only |

All traffic goes over `standaloneWindow.postMessage` / `onMessage` (main → UI) and
`iina.postMessage` / `standaloneWindow.onMessage` (UI → main). The UI has no
filesystem or mpv access; every privileged action is a message.

## Subtitle pipeline

1. `buildTrackListSuffixOnly()` — `mpv.getNative("track-list")`, keeps `type === "sub"`
   entries whose `external-filename` has a file suffix. Internal/embedded tracks are
   invisible to the plugin.
2. `readSubtitleTextById(id, path)` — `file.read("@sub/<id>")`, falling back to
   `utils.exec("/bin/bash", ["-lc", "cat <path>"])`. The pseudo-path is preferred
   because `exec` stdout truncates on some builds.
3. `parseSRT(text)` — hand-rolled line scanner.
4. `rows` — what the UI renders. Times are **seconds as numbers**, not SRT strings.

Playback correlation uses `closestRowIndexByTime()`, which subtracts
`mpv.getNumber("sub-delay")` before searching, so every seek adds the delay back.

## Constraints that shape the edit feature

### `file.write` cannot overwrite the subtitle file

IINA's `JavascriptAPIFile.swift` rejects overwriting any existing file that is not
under `@tmp/` or `@data/` — the `file-system` permission does not lift this. So an
in-place save has to stage through `@tmp/` and copy out via `utils.exec`. The
existing `copyFallback` handler already uses exactly that pattern for `pbcopy`.

### `parseSRT` is lossy, so a full re-serialize would delete data

The parser drops any cue whose text is empty after `stripCurly()`, whose timestamps
fail to parse, or whose `end <= start`. It also strips `{...}` style tags and sorts
by start time. `rows` is therefore a filtered, rewritten projection of the file — not
a faithful model of it.

Rebuilding the whole `.srt` from `rows` (renumbering, reformatting timestamps) would
silently discard every dropped cue. Instead the editor records each cue's **line span
in the source** and replaces only the text lines of cues the user actually edited.
Untouched cues keep their original bytes: indices, timestamp format, style tags,
ordering, and unparsed junk all survive.

The one deliberate lossy edge: an edited cue is written back from the `stripCurly()`ed
text, so editing a cue that had `{...}` tags drops them from that cue only.

### Line endings

`parseSRT` normalizes `\r` away before splitting. Saving re-joins with `\n`, so a
CRLF file becomes LF on first save. Acceptable; mpv reads both.

### `sub-reload` may renumber tracks

mpv's `sub-reload` unloads and re-adds the track, so the track id can change.
`refresh()` re-resolves the track by `external-filename` before falling back to the
first available track.

### Running a dev build beside the release

IINA keys plugins on `identifier`, so a build that keeps the released identifier
replaces it rather than sitting next to it. `scripts/build-plugin.sh --dev`
rewrites the identifier, the display name, and the menu shortcut in a staging copy
before packing — the repo source is never modified.

`PLUGIN_LABEL` and `MENU_SHORTCUT` in `main.js` exist for that rewrite: they keep
the strings on single, stable lines so the script can target them exactly, and it
aborts if a target is missing rather than shipping a half-patched plugin.

## Message inventory

UI → main: `uiReady`, `windowClosed`, `setSelection`, `seekTo`, `seekNearest`,
`seekCurrentLine`, `scrollToCurrent`, `loopLine`, `reload`, `copyFallback`
— plus, added for editing: `editRow`, `revertRow`, `save`.

The row context menu is drawn in the WebView rather than by AppKit: the UI has no
menu API, and `contextmenu` is suppressed document-wide so WebKit's own menu
(Reload, Save Page As…) never appears.

Main → UI: `setTracks`, `setRows`, `time`, `scrollToIndex`, `liveSubtitle`
— plus, added for editing: `saveResult`.
