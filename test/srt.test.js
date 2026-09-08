"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlugin, subTrack } = require("./helpers/plugin-harness.js");

const PATH = "/movies/show.srt";

function load(srt, options = {}) {
  const p = createPlugin({
    tracks: [subTrack(1, PATH, { selected: true })],
    files: { "@sub/1": srt },
    ...options,
  });
  p.send("uiReady", {});
  return p;
}

async function loaded(srt, options) {
  const p = load(srt, options);
  await p.settle();
  return p;
}

const BASIC = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "Hello world",
  "",
  "2",
  "00:00:04,500 --> 00:00:06,250",
  "Second line",
  "",
].join("\n");

test("parses cues into rows with times in seconds", async () => {
  const p = await loaded(BASIC);
  assert.deepEqual(p.lastSent("setRows").rows, [
    { id: 0, start: 1, end: 3, text: "Hello world", dirty: false },
    { id: 1, start: 4.5, end: 6.25, text: "Second line", dirty: false },
  ]);
});

test("accepts both , and . as the millisecond separator", async () => {
  const p = await loaded("1\n00:00:01.500 --> 00:00:02,750\nDot and comma\n");
  const [row] = p.lastSent("setRows").rows;
  assert.equal(row.start, 1.5);
  assert.equal(row.end, 2.75);
});

test("strips a BOM rather than choking on the first cue", async () => {
  const p = await loaded("﻿" + BASIC);
  assert.equal(p.lastSent("setRows").rows.length, 2);
});

test("strips {...} style tags from displayed text", async () => {
  const p = await loaded("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Overlay{\\b1} text\n");
  assert.equal(p.lastSent("setRows").rows[0].text, "Overlay text");
});

test("drops cues the parser cannot use, but keeps later ids aligned to the source", async () => {
  // Cue 2 is {...}-only, so stripCurly empties it and buildRows filters it out --
  // but it must still occupy id 1, or every later cue's id would name the wrong
  // source span and an edit would splice into the wrong lines.
  const srt = [
    "1", "00:00:01,000 --> 00:00:02,000", "First", "",
    "2", "00:00:03,000 --> 00:00:04,000", "{\\an8}", "",
    "3", "00:00:05,000 --> 00:00:06,000", "Third", "",
  ].join("\n");
  const p = await loaded(srt);
  assert.deepEqual(p.lastSent("setRows").rows.map(r => [r.id, r.text]), [
    [0, "First"],
    [2, "Third"],
  ]);
});

test("drops cues whose end is not after their start", async () => {
  const srt = [
    "1", "00:00:05,000 --> 00:00:05,000", "Zero length", "",
    "2", "00:00:06,000 --> 00:00:07,000", "Fine", "",
  ].join("\n");
  const p = await loaded(srt);
  assert.deepEqual(p.lastSent("setRows").rows.map(r => r.text), ["Fine"]);
});

test("sorts rows by start time even when the file does not", async () => {
  const srt = [
    "1", "00:00:09,000 --> 00:00:10,000", "Later", "",
    "2", "00:00:01,000 --> 00:00:02,000", "Earlier", "",
  ].join("\n");
  const p = await loaded(srt);
  assert.deepEqual(p.lastSent("setRows").rows.map(r => r.text), ["Earlier", "Later"]);
});

test("handles multi-line cue text", async () => {
  const p = await loaded("1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two\n");
  assert.equal(p.lastSent("setRows").rows[0].text, "Line one\nLine two");
});

test("reports an error for a subtitle that is not .srt", async () => {
  const p = createPlugin({
    tracks: [subTrack(1, "/movies/show.ass", { selected: true })],
    files: { "@sub/1": BASIC },
  });
  p.send("uiReady", {});
  await p.settle();
  assert.match(p.lastSent("setRows").meta.error, /not \.srt/);
});

/** Saving: only edited lines are rewritten */

test("an edit rewrites only that cue's text lines, leaving the rest byte-identical", async () => {
  const srt = [
    "1", "00:00:01,000 --> 00:00:03,000", "{\\an8}Keep my tags", "",
    "42", "00:00:04,500 --> 00:00:06,250", "Fix me", "",
    "3", "00:00:07,000 --> 00:00:08,000", "Untouched", "",
  ].join("\n");
  const p = await loaded(srt);

  p.send("editRows", { edits: [{ id: 1, text: "Fixed" }] });
  await p.runTimers();

  assert.equal(p.stagedText(), [
    "1", "00:00:01,000 --> 00:00:03,000", "{\\an8}Keep my tags", "",
    "42", "00:00:04,500 --> 00:00:06,250", "Fixed", "",
    "3", "00:00:07,000 --> 00:00:08,000", "Untouched", "",
  ].join("\n"));
});

test("an edit that changes line count keeps later cues intact", async () => {
  const srt = [
    "1", "00:00:01,000 --> 00:00:03,000", "One line", "",
    "2", "00:00:04,000 --> 00:00:05,000", "Second", "",
  ].join("\n");
  const p = await loaded(srt);

  p.send("editRows", { edits: [{ id: 0, text: "Now\ntwo lines" }] });
  await p.runTimers();

  assert.equal(p.stagedText(), [
    "1", "00:00:01,000 --> 00:00:03,000", "Now", "two lines", "",
    "2", "00:00:04,000 --> 00:00:05,000", "Second", "",
  ].join("\n"));
});

test("several edits in one batch all land, including out-of-order ids", async () => {
  const srt = [
    "1", "00:00:01,000 --> 00:00:02,000", "A", "",
    "2", "00:00:03,000 --> 00:00:04,000", "B", "",
    "3", "00:00:05,000 --> 00:00:06,000", "C", "",
  ].join("\n");
  const p = await loaded(srt);

  // Reverse id order on purpose: buildSRT splices back to front, and a bug there
  // would shift the spans of the cues not yet applied.
  p.send("editRows", { edits: [{ id: 2, text: "CC\nCC" }, { id: 0, text: "AA" }] });
  await p.runTimers();

  assert.equal(p.stagedText(), [
    "1", "00:00:01,000 --> 00:00:02,000", "AA", "",
    "2", "00:00:03,000 --> 00:00:04,000", "B", "",
    "3", "00:00:05,000 --> 00:00:06,000", "CC", "CC", "",
  ].join("\n"));
});

test("editing a cue back to its original text drops the edit instead of saving", async () => {
  const p = await loaded(BASIC);
  p.send("editRows", { edits: [{ id: 0, text: "Changed" }] });
  p.send("editRows", { edits: [{ id: 0, text: "Hello world" }] });
  assert.equal(p.hasPendingTimer(), false, "no autosave should remain scheduled");
  assert.equal(p.lastSent("setRows").meta.dirty, 0);
});

test("blank edits are rejected and reported, not written", async () => {
  const p = await loaded(BASIC);
  p.send("editRows", { edits: [{ id: 0, text: "   " }] });
  await p.settle();
  assert.match(p.lastSent("notice").message, /cannot be empty/);
  assert.equal(p.lastSent("setRows").meta.dirty, 0);
});

test("the first save backs the file up, and later saves do not overwrite the backup", async () => {
  const p = await loaded(BASIC);

  p.send("editRows", { edits: [{ id: 0, text: "First edit" }] });
  await p.runTimers();
  const backups = p.execCalls.filter(c => c.includes(".bak"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /test -e .*\.bak' \|\| cp /);

  p.send("editRows", { edits: [{ id: 1, text: "Second edit" }] });
  await p.runTimers();
  assert.equal(p.execCalls.filter(c => c.includes(".bak")).length, 1, "backup runs once per file");
});

test("a save writes atomically and reloads the subtitle track", async () => {
  const p = await loaded(BASIC);
  p.send("editRows", { edits: [{ id: 0, text: "Edited" }] });
  await p.runTimers();

  const write = p.execCalls.find(c => c.includes(".sn-tmp"));
  assert.ok(write, "expected a staged-and-renamed write");
  assert.match(write, /cp -p /, "seeds the temp file so it inherits the original's mode");
  assert.match(write, /mv -f /, "renames into place rather than truncating");
  assert.deepEqual(p.mpvCommands.find(c => c[0] === "sub-reload"), ["sub-reload", ["1"]]);
});

test("a failed write reverts the batch and hands back the discarded text", async () => {
  const p = await loaded(BASIC, {
    exec: (script) => (script.includes("test -w") ? { status: 1, stderr: "read-only" } : null),
  });

  p.send("editRows", { edits: [{ id: 0, text: "Doomed edit" }] });
  await p.runTimers();

  const result = p.lastSent("saveResult");
  assert.equal(result.ok, false);
  assert.equal(result.discarded, "Doomed edit");
  // The list must fall back to what the file actually holds.
  assert.equal(p.lastSent("setRows").rows[0].text, "Hello world");
  assert.equal(p.lastSent("setRows").meta.dirty, 0);
});

test("a failed rename falls back to writing in place instead of losing the edit", async () => {
  const p = await loaded(BASIC, {
    exec: (script) => (script.includes(".sn-tmp") ? { status: 1, stderr: "read-only dir" } : null),
  });

  p.send("editRows", { edits: [{ id: 0, text: "Edited" }] });
  await p.runTimers();

  assert.equal(p.lastSent("saveResult").ok, true);
  assert.ok(p.execCalls.some(c => /^cat .* > '\/movies\/show\.srt'$/.test(c)), "wrote in place");
});

test("a run of edits batches into one write", async () => {
  const p = await loaded(BASIC);
  p.send("editRows", { edits: [{ id: 0, text: "One" }] });
  p.send("editRows", { edits: [{ id: 1, text: "Two" }] });
  await p.runTimers();

  assert.equal(p.execCalls.filter(c => c.includes(".sn-tmp")).length, 1);
  assert.equal(p.mpvCommands.filter(c => c[0] === "sub-reload").length, 1);
});

test("a save leaves the file ending in a newline", async () => {
  const p = await loaded("1\n00:00:01,000 --> 00:00:02,000\nNo trailing newline");
  p.send("editRows", { edits: [{ id: 0, text: "Edited" }] });
  await p.runTimers();
  assert.ok(p.stagedText().endsWith("\n"));
});
