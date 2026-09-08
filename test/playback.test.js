"use strict";

// The plugin sends the UI times, never row indices: indices in the UI are into the
// filtered list, which a search can narrow and which main cannot see. Times go out
// in subtitle-file time, so the UI never has to know about sub-delay.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlugin, subTrack } = require("./helpers/plugin-harness.js");

const SRT = [
  "1", "00:00:10,000 --> 00:00:12,000", "First", "",
  "2", "00:00:20,000 --> 00:00:22,000", "Second", "",
].join("\n");

async function loaded(mpvProps = {}) {
  const p = createPlugin({
    tracks: [subTrack(1, "/movies/a.srt", { selected: true })],
    files: { "@sub/1": SRT },
    mpv: mpvProps,
  });
  p.send("uiReady", {});
  await p.settle();
  return p;
}

test("the ticker sends playback time with sub-delay taken out", async () => {
  const p = await loaded({ "sub-delay": 1.5, "time-pos": 11.5 });
  await p.tick();
  assert.equal(p.lastSent("time").t, 10, "11.5s of playback is 10s of subtitle time");
});

test("the ticker sends no row index at all", async () => {
  const p = await loaded({ "time-pos": 11 });
  await p.tick();
  assert.deepEqual(Object.keys(p.lastSent("time")), ["t"]);
});

test("seekTo adds sub-delay back on the way out", async () => {
  const p = await loaded({ "sub-delay": 1.5 });
  p.send("seekTo", { time: 10 });
  assert.deepEqual(p.mpvCommands.at(-1), ["seekTo", 11.5]);
});

test("Scroll to Current reads mpv directly rather than reusing the last tick", async () => {
  const p = await loaded({ "sub-delay": 2, "time-pos": 0 });
  await p.tick();
  // Playback jumps between the tick and the request; the answer must reflect the jump.
  p.setTime(22);
  p.send("scrollToCurrent", {});
  assert.equal(p.lastSent("scrollToTime").t, 20);
});

test("Scroll to Current stays silent when mpv has no time yet", async () => {
  const p = await loaded({ "time-pos": NaN });
  p.send("scrollToCurrent", {});
  assert.equal(p.lastSent("scrollToTime"), undefined);
});

test("Space toggles pause by reading mpv, and the OSD matches what it set", async () => {
  const p = await loaded({ pause: false });
  p.send("togglePause", {});
  assert.equal(p.mpvProps.pause, true);
  assert.equal(p.osd.at(-1), "Pause");

  p.send("togglePause", {});
  assert.equal(p.mpvProps.pause, false);
  assert.equal(p.osd.at(-1), "Play");
});

test("closing the window stops the ticker, and reopening starts it again", async () => {
  const p = await loaded({ "time-pos": 11 });
  await p.tick();
  const before = p.sent("time").length;
  assert.ok(before > 0);

  await p.send("windowClosed", {});
  await p.tick();
  assert.equal(p.sent("time").length, before, "no ticker should be left running");

  p.send("uiReady", {});
  await p.settle();
  await p.tick();
  assert.ok(p.sent("time").length > before);
});

test("a sub-reload the plugin caused does not trigger a re-read of the file", async () => {
  const p = await loaded();
  p.send("editRows", { edits: [{ id: 0, text: "Edited" }] });
  await p.runTimers();

  const reads = p.execCalls.filter(c => c.startsWith("cat '/movies")).length;
  await p.emit("mpv.track-list.changed");
  await p.settle();
  assert.equal(p.execCalls.filter(c => c.startsWith("cat '/movies")).length, reads);
  assert.equal(p.lastSent("setRows").rows[0].text, "Edited", "the in-memory resync survives");
});

test("a track-list change from outside the plugin does re-read the file", async () => {
  const p = await loaded();
  p.advanceClock(5000);
  p.files.set("@sub/1", SRT.replace("First", "Changed on disk"));

  await p.emit("mpv.track-list.changed");
  await p.settle();
  assert.equal(p.lastSent("setRows").rows[0].text, "Changed on disk");
});

test("sub-reload renumbering the track is resolved back by path, not dropped", async () => {
  const p = await loaded();
  // mpv unloads and re-adds the track, so the same file comes back under a new id
  // and the old @sub/1 pseudo path stops resolving.
  p.setTracks([subTrack(7, "/movies/a.srt", { selected: true })]);
  p.files.delete("@sub/1");
  p.files.set("@sub/7", SRT);
  p.advanceClock(5000);

  await p.emit("mpv.track-list.changed");
  await p.settle();

  assert.equal(p.lastSent("setTracks").trackId, 7);
  assert.equal(p.lastSent("setRows").meta.path, "/movies/a.srt");
});
