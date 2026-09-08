"use strict";

// Regressions for the ways an edit could go missing between the list and the file.
// Every one of these is a case where the UI would keep showing text the .srt does
// not have -- the invariant the whole save design exists to hold.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlugin, subTrack } = require("./helpers/plugin-harness.js");

const A = "/movies/a.srt";
const B = "/movies/b.srt";

const SRT_A = [
  "1", "00:00:01,000 --> 00:00:02,000", "Alpha", "",
  "2", "00:00:03,000 --> 00:00:04,000", "Beta", "",
].join("\n");

const SRT_B = [
  "1", "00:00:10,000 --> 00:00:11,000", "Gamma", "",
  "2", "00:00:12,000 --> 00:00:13,000", "Delta", "",
].join("\n");

/** A shell command a test can hold open, to keep a save in flight. */
function deferred() {
  let release;
  const promise = new Promise(r => { release = r; });
  return { promise, release: () => release(null) };
}

async function twoFiles(execImpl) {
  const p = createPlugin({
    tracks: [
      subTrack(1, A, { selected: true }),
      subTrack(2, B),
    ],
    files: { "@sub/1": SRT_A, "@sub/2": SRT_B },
    exec: execImpl,
  });
  p.send("uiReady", {});
  await p.settle();
  return p;
}

test("an edit typed while a save is in flight is not swallowed by that save", async () => {
  const gate = deferred();
  let held = false;
  const p = await twoFiles((script) => {
    if (script.includes(".sn-tmp") && !held) { held = true; return gate.promise; }
    return null;
  });

  p.send("editRows", { edits: [{ id: 0, text: "Alpha edited" }] });
  const saving = p.runTimers();
  await p.settle();

  // The write is parked. This edit lands after buildSRT() has already snapshotted
  // the text, so it is not part of the batch being written.
  p.send("editRows", { edits: [{ id: 1, text: "Beta edited" }] });
  gate.release();
  await saving;

  assert.equal(
    p.lastSent("setRows").rows[1].text,
    "Beta edited",
    "the second edit must survive the save that was already running",
  );
  assert.ok(p.hasPendingTimer(), "and it must still be scheduled to reach the file");

  await p.runTimers();
  assert.match(p.stagedText(), /Beta edited/);
});

test("switching tracks while a save is in flight still writes the pending edit", async () => {
  const gate = deferred();
  let held = false;
  const p = await twoFiles((script) => {
    if (script.includes(".sn-tmp") && !held) { held = true; return gate.promise; }
    return null;
  });

  p.send("editRows", { edits: [{ id: 0, text: "Alpha edited" }] });
  const saving = p.runTimers();
  await p.settle();

  // Arrives during the parked write, so it is not in the batch on its way out.
  p.send("editRows", { edits: [{ id: 1, text: "Beta edited" }] });

  const switching = p.send("setSelection", { trackId: 2 });
  gate.release();
  await Promise.all([saving, switching]);
  await p.settle();

  const written = [...p.files.keys()].filter(k => k.startsWith("@tmp/"));
  assert.ok(written.length, "something should have been staged");
  const all = p.execCalls.join("\n");
  assert.ok(all.includes(A), "the pending edit must be flushed to the file it belongs to");
  assert.match(p.stagedText(), /Beta edited/, "the edit made mid-save must reach disk");
});

test("switching tracks flushes a debounced edit before loading the other file", async () => {
  const p = await twoFiles();
  p.send("editRows", { edits: [{ id: 0, text: "Alpha edited" }] });
  assert.ok(p.hasPendingTimer(), "the edit is only in the debounce window");

  await p.send("setSelection", { trackId: 2 });
  await p.settle();

  assert.match(p.stagedText(), /Alpha edited/, "the debounce window must not swallow it");
  assert.equal(p.lastSent("setRows").meta.path, B);
});

test("a new video clears a running line loop instead of seeking to the old file's times", async () => {
  const p = await twoFiles();

  p.send("loopLine", { enabled: true, start: 1, end: 2 });
  assert.deepEqual(p.osd.slice(-1), ["Loop: ON"]);

  p.setTracks([subTrack(1, B, { selected: true })]);
  p.setTime(500);
  await p.emit("mpv.file-loaded");
  await p.settle();

  const seeksBefore = p.mpvCommands.filter(c => c[0] === "seekTo").length;
  await p.tick();
  assert.equal(
    p.mpvCommands.filter(c => c[0] === "seekTo").length,
    seeksBefore,
    "the stale loop must not drag the new video back to the old file's timestamps",
  );
});

test("switching subtitle track clears a running line loop", async () => {
  const p = await twoFiles();
  p.send("loopLine", { enabled: true, start: 1, end: 2 });

  await p.send("setSelection", { trackId: 2 });
  await p.settle();

  p.setTime(500);
  const seeksBefore = p.mpvCommands.filter(c => c[0] === "seekTo").length;
  await p.tick();
  assert.equal(p.mpvCommands.filter(c => c[0] === "seekTo").length, seeksBefore);
});

test("a loop still runs while the file it belongs to is loaded", async () => {
  const p = await twoFiles();
  p.send("loopLine", { enabled: true, start: 1, end: 2 });

  p.setTime(5);
  await p.tick();

  assert.ok(
    p.mpvCommands.some(c => c[0] === "seekTo" && c[1] === 1),
    "past the loop end, playback should jump back to the loop start",
  );
});

test("closing the window flushes a debounced edit", async () => {
  const p = await twoFiles();
  p.send("editRows", { edits: [{ id: 0, text: "Alpha edited" }] });
  await p.send("windowClosed", {});
  await p.settle();
  assert.match(p.stagedText(), /Alpha edited/);
});

test("Reload flushes a debounced edit before re-reading the file", async () => {
  const p = await twoFiles();
  p.send("editRows", { edits: [{ id: 0, text: "Alpha edited" }] });
  await p.send("reload", {});
  await p.settle();
  assert.match(p.stagedText(), /Alpha edited/);
});
