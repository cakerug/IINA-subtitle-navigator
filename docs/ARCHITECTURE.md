# Subtitle Navigator — architecture notes

How the plugin is put together, and why the awkward parts are the shape they are.
Most of it is IINA and mpv constraints; the rest is invariants the save path depends
on. `npm test` enforces the ones that are enforceable.

## Two contexts, one message bus

| Context | File | Globals |
| --- | --- | --- |
| Plugin main | `main.js` | `iina.{core, standaloneWindow, event, mpv, file, utils, console, menu}` |
| WebView UI | `ui/window.js` (+ `window.html`, `window.css`) | `iina.{postMessage, onMessage}` only |
| UI rules | `ui/state.js`, `ui/shortcuts.js` | none — no DOM, no `iina` |

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

Playback correlation lives entirely in the UI's `Nav.findRowAtTime()`, which matches
a time against `filtered` by containment (`start <= t <= end`), falling back to the
last row that already ended when the time lands in a gap. Main sends only times,
never row indices: indices in the UI are into `filtered`, which a search can narrow
and which main cannot see. Main subtracts `mpv.getNumber("sub-delay")` from every
time it sends, so the UI works in subtitle-file time throughout, and `seekTo` adds
the delay back on the way out.

## Why the UI is split three ways

`ui/window.js` used to hold the navigation rules, the key bindings and the DOM in one
file, which meant none of it could be exercised without a browser. Two modules were
lifted out. Both are plain scripts that define one global for the WebView and export
it via a `typeof module` guard for Node, so there is no bundler and no ES-module
loading over `file://` to worry about.

### `ui/state.js` — `Nav`

Owns where playback is (`currentIdx`), what is selected, what auto-scroll has already
brought into view (`lastScrolledIdx`), whether the selection is riding the current
line (`followCurrent`), and where the keyboard is (`focusPos`). It holds no DOM.

Every entry point takes the state plus whatever the DOM layer had to *measure*, and
returns an **effects** object — `{ render, scrollTo, seekTo, scrollToCurrent,
autoScroll, notice }` — which `apply()` in `window.js` turns into DOM. So the rules
are ordinary functions over ordinary values, and `window.js` is left doing nothing but
wiring.

Three cases this shape exists to make testable, each a bug that had shipped:

- **`lastScrolledIdx` is tracked apart from `currentIdx`.** Resolving `currentIdx`
  from the clock does not scroll anything, so on load `currentIdx` could already name
  the playing row with the list still parked at the top — and a tick gated on the
  index *changing* would never scroll. Auto-scroll therefore compares against the row
  it actually scrolled to, not against the previous index.
- **`focusPos` is `null` until the user picks a row**, rather than falling back to
  `currentIdx` in storage. `Nav.focusedPos()` still falls back for *movement*, but
  "never moved" and "deliberately parked on the current line" stay distinguishable.
- **Escape asks whether the current row is on screen**, which the DOM layer measures
  and passes in. Asking instead whether focus *equalled* `currentIdx` read a
  never-moved focus as being already on the current line, so the very first Escape
  toggled auto-scroll instead of scrolling.

### `ui/shortcuts.js` — `Shortcuts`

One table of every key binding. Each entry carries both how it is matched
(`match(event)`) and how it is displayed (`display`, `label`), plus the `context` it
applies in — `list`, `editing` or `find`.

The context is what fixes a second shipped bug: `Escape` was handled before the
"is focus in a text field" check, so pressing it in the search or replace box also
toggled auto-scroll. There is now a single `keydown` listener that resolves the
context once and dispatches through the table.

The table also *generates* the `?` panel (`renderHelp()`) and the context menu's key
hints (`Shortcuts.display(action)`). Adding a binding anywhere else would mean it
never appears under `?`, so `test/shortcuts.test.js` fails the build on any bare
`e.key` comparison left in `window.js`, and on any action id without a handler.

## Testing

`npm test` is `node --test` over `test/`, with no dependencies.

`test/helpers/plugin-harness.js` runs the real `main.js` in a `vm` context against a
fake `iina` global, and drives it the way IINA does — by delivering messages and mpv
events, and reading back what it posts, what it asks the shell to do, and what it
stages for writing. `main.js` is a plugin script with no exports and self-registering
handlers, so testing it through those seams is both the only option and the honest
one: the assertions are about the real message contract, not about internals.

The fake shell is deliberately not a shell. Commands are recorded and answered as
successes; a test that wants a failure matches the command shape and returns a
non-zero status, and one that wants a save held open returns a promise. What gets
asserted is the text staged in `@tmp/`, which is exactly the `.srt` that would land.

`ui/state.js` and `ui/shortcuts.js` are required directly, since they are DOM-free by
construction.

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
`sub-reload` instead of one per line. There is no manual save at all.

Saves are **chained** rather than flagged: `saveSubtitle()` appends to `saveChain`, so
awaiting it waits for its own turn to finish and not merely for the queue to be
joined. `flushPending()` depends on that — anything that swaps the loaded file out
(track switch, Reload, a new video, closing the window) has to know the write is done
before `refresh()` clears `edits` for the new path.

Each write snapshots the edits it covers into a `batch`, and afterwards clears only
those entries. An edit committed while the write was in flight is not in the text
going out, so clearing `edits` wholesale would drop it silently and re-render the row
back to the old text. Whatever remains after a batch gets a batch of its own.
`flushPending()` makes two passes for the same reason: `edits` can be empty at the
moment it is called and non-empty once the running save finishes.

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

### A loop belongs to the file it was set on

Row ids are cue *indices*, so id 42 exists in almost any subtitle file. Left alone, a
running line loop would survive into the next video and keep seeking to the old file's
timestamps, under a marker sitting on an unrelated row. `clearLoop()` therefore runs
wherever the loaded file changes, on both sides: `refresh()` drops the bounds when the
path changes, and `setRows` drops `loopingId` when the path changes.

Closing the window also clears it and stops the 250ms ticker. The window is the loop's
only control, so leaving it running would strand playback on a line with no way out.

### `sub-reload` may renumber tracks

mpv's `sub-reload` unloads and re-adds the track, so the track id can change.
`refresh()` re-resolves the track by `external-filename` before falling back to the
first available track.

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
`mark.active` colours and Replace acts on. Replace All walks `filtered` instead —
which, since the query is also the filter, is every row that contains it. It passes
a replacer *function* to `String.replace`, so `$&` and friends typed into the Replace
box stay literal rather than becoming substitution patterns. A replacement that would
empty a cue is dropped rather than sent, since `main.js` rejects blank text — the list
must never show text the file will not have — and the notice says how many lines were
left alone.

Three cursors move independently: `nav.currentIdx` is where the video is (the blue
row), `nav.selected` is what was clicked, and `matchIdx` is the find cursor. Clicking
a row moves the find cursor onto it, so Replace acts on the line being pointed at.
Playback deliberately does not: the find cursor is an editing position, and letting
it drift with the video would make Replace a moving target. Following playback is
what Auto-scroll and Scroll to Current are for.

After a replacement `resumeAt` records the position just past the inserted text, and
`computeMatches()` lands `matchIdx` on the first match at or after it. Without that,
replacing `world` with `the world` would leave the cursor sitting on the match it had
just created.

Nothing about replace reaches `main.js`: a replacement is an ordinary `editRows`, so
it inherits the same debounced write, rollback and re-render as a hand edit.

### Undo

`undoStack` and `redoStack` live in the WebView. An entry is one user action — a hand
edit, a single replacement, a Replace All — holding a label for the notice and the
`before`/`after` text of every row it touched. `applyChanges(changes, key)` picks a
side and applies it, so undo and redo are one walk in opposite directions.

Changes go out as a single `editRows` message rather than one per line: a Replace All
across a few hundred cues would otherwise cost that many re-renders and autosave
reschedules. Row ids are cue indices and a save only rewrites cue *text*, so the cue
count — and therefore every id — survives the round trip and the stacks stay valid
across saves. Loading a different `.srt` does invalidate them, so `setRows` compares
`meta.path` against the path the stacks were built on and drops them when it changes.

Undo is a session-level history of actions; the `.srt.bak` backup is still the
separate, coarser escape hatch that holds the file as it was before the first write.

`⌘Z` is bound in the `list` context only, so the search box, the replace box and an
open editor keep their own native undo.

## Message inventory

UI → main: `uiReady`, `windowClosed`, `setSelection`, `seekTo`,
`scrollToCurrent`, `loopLine`, `reload`, `copyFallback`
— plus, added for editing: `editRows`.

The row context menu is drawn in the WebView rather than by AppKit: the UI has no
menu API, and `contextmenu` is suppressed document-wide so WebKit's own menu
(Reload, Save Page As…) never appears.

The menu is the only control for looping and for copying, so its entries are built
per row against current state rather than from a fixed list: the loop entry reads
"Stop looping" on the row `loopingId` names, and the copy entries take the whole
selection when the right-clicked row is part of a multi-row one. With no toolbar
control left, the row's own `.looping` marker is the only indication looping is on.

Main → UI: `setTracks`, `setRows`, `time`, `scrollToTime`
— plus, added for editing: `saveResult` (failures only), `notice`.

`render()` carries an open editor's text, caret and focus across a rebuild. Without
that, any `setRows` arriving mid-typing (which autosave makes routine) would reseed
the textarea from the row text and discard what had been typed.
