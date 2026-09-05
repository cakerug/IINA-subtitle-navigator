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

### Saving is invisible, and a failure rolls back

There is no dirty state in the UI. An edit updates the list immediately and arms a
~2s timer, reset by each further edit, so a correction pass costs one write and one
`sub-reload` instead of one per line. There is no manual save at all; a save
arriving while one is in flight is queued rather than run concurrently. Anything
that swaps
the loaded file out — track switch, Reload, a new video, closing the window —
flushes a pending edit first, so the debounce window cannot swallow one.

Because nothing signals "unsaved", the list must never show text the file does not
have. A failed write therefore discards the whole batch and re-posts the rows,
dropping the list back to the last saved text, and hands the discarded strings to
the UI so a correction that mattered can be typed in again. That trades a rare lost
edit for never lying about what is on disk.

After a successful write the plugin re-parses the text it just produced instead of
reading the file back. Line-count changes shift every later cue's span, so spans
must be rebuilt either way, and this avoids both a disk read and the re-render that
came with it.

`sub-reload` makes mpv re-announce its track list, which would otherwise trigger a
full re-read of the file we just wrote. `selfReloadAt` suppresses that echo for two
seconds.

### Writes are atomic, with an in-place fallback

The staged text is copied over a `.sn-tmp` sibling (seeded with `cp -p` so it
inherits the original's mode) and then renamed into place, so a failure mid-write
cannot leave a truncated subtitle file. Renaming needs a writable *directory*,
which a read-only share may not give even when the file itself is writable, so a
failed rename falls back to writing in place.

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

### Search, highlighting and replace

Filtering, highlighting and replace all derive their match from one escaped literal
regex (`buildRegex()`), so they can never disagree about what counts as a match. The
`Aa` toggle drops the `i` flag for all three at once. The filter takes the non-global
form, whose `.test()` is stateless and so can be reused down the rows; highlight and
replace take the global form, freshly built per call so `lastIndex` cannot leak.
Marked lines are assembled from text nodes and `<mark>` elements rather than
`innerHTML`, so subtitle text containing `<` or `&` cannot become markup.

`matches` is a flat list of every occurrence in list order, rebuilt by
`computeMatches()` on any change to the query, the case flag or the rows; `matchIdx` names the one
`mark.active` colours and Replace acts on. There is deliberately no Replace All: the
only undo is the `.bak` copy of the whole file, so each replacement is one the user
has just seen highlighted. A replacement that would empty a cue is refused rather
than sent, since `editRow` rejects blank text — the list must never show text the
file will not have.

Three cursors move independently: `currentIdx` is where the video is (the blue row),
`selected` is what was clicked, and `matchIdx` is the find cursor. Clicking a row
moves the find cursor onto it, so Replace acts on the line being pointed at.
Playback deliberately does not: the find cursor is an editing position, and letting
it drift with the video would make Replace a moving target on a feature whose only
undo is the `.bak` file. Following playback is what Auto-scroll and Scroll to
Current are for.

After a replacement `resumeAt` records the position just past the inserted text, and
`computeMatches()` lands `matchIdx` on the first match at or after it. Without that,
replacing `world` with `the world` would leave the cursor sitting on the match it had
just created.

Nothing about replace reaches `main.js`: a replacement is an ordinary `editRow`, so
it inherits the same debounced write, rollback and re-render as a hand edit.

## Message inventory

UI → main: `uiReady`, `windowClosed`, `setSelection`, `seekTo`,
`scrollToCurrent`, `loopLine`, `reload`, `copyFallback`
— plus, added for editing: `editRow`.

The row context menu is drawn in the WebView rather than by AppKit: the UI has no
menu API, and `contextmenu` is suppressed document-wide so WebKit's own menu
(Reload, Save Page As…) never appears.

The menu is the only control for looping and for copying, so its entries are built
per row against current state rather than from a fixed list: the loop entry reads
"Stop looping" on the row `loopingId` names, and the copy entries take the whole
selection when the right-clicked row is part of a multi-row one. With no toolbar
control left, the row's own `.looping` marker is the only indication looping is on.

Main → UI: `setTracks`, `setRows`, `time`, `scrollToIndex`
— plus, added for editing: `saveResult` (failures only), `notice`.

`render()` carries an open editor's text, caret and focus across a rebuild. Without
that, any `setRows` arriving mid-typing (which autosave makes routine) would reseed
the textarea from the row text and discard what had been typed.
