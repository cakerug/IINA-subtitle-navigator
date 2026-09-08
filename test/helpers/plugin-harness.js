"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAIN_PATH = path.join(__dirname, "..", "..", "main.js");

// main.js is an IINA plugin script, not a module: it has no exports and it wires
// itself up to the `iina` global the moment it loads. So the harness runs it in a
// vm context against a fake `iina` and drives it the way IINA does -- by delivering
// messages and mpv events. That keeps the tests honest about the real seams
// (messages in, messages out, files written) instead of reaching past them.
function createPlugin(options = {}) {
  const posted = [];
  const osd = [];
  const errors = [];
  const execCalls = [];
  const files = new Map(Object.entries(options.files || {}));
  // Handlers main.js registers, so the harness can deliver into them.
  const messageHandlers = new Map();
  const eventHandlers = new Map();

  let tracks = options.tracks || [];
  const mpvProps = Object.assign({ "time-pos": 0, "sub-delay": 0, pause: false }, options.mpv);
  const mpvCommands = [];

  // Fake timers, so a test can fire the autosave debounce without waiting 2s.
  let nextTimerId = 1;
  const timers = new Map();
  let now = options.now || 1_000_000;

  // Default: every shell command succeeds. `options.exec` may return a partial
  // result (or null to fall through) for the commands a test wants to fail, and may
  // return a promise to hold a command open.
  const execImpl = options.exec || (() => null);

  // Values built inside the vm carry the vm's own Array/Object intrinsics, so
  // assert.deepEqual would reject them as cross-realm. Clone them into this realm
  // on the way out.
  const out = (v) => (v === undefined ? v : structuredClone(v));

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math,
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms, repeating: true });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  };
  // Date.now() is what `selfReloadAt` and `backedUp` timing key off, so it has to be
  // steerable; the rest of Date is left alone.
  sandbox.Date = class extends Date {
    static now() { return now; }
  };

  sandbox.iina = {
    console: {
      log() {},
      warn() {},
      error(msg) { errors.push(String(msg)); },
    },
    core: {
      osd(text) { osd.push(String(text)); },
      seekTo(t) { mpvCommands.push(["seekTo", t]); mpvProps["time-pos"] = t; },
      pause() { mpvProps.pause = true; },
      resume() { mpvProps.pause = false; },
    },
    menu: {
      item(title, action, opts) { return { title, action, opts }; },
      addItem() {},
    },
    standaloneWindow: {
      setProperty() {},
      loadFile() {},
      setFrame() {},
      open() {},
      postMessage(name, data) { posted.push({ name, data: out(data) }); },
      onMessage(name, fn) { messageHandlers.set(name, fn); },
    },
    event: {
      on(name, fn) {
        if (!eventHandlers.has(name)) eventHandlers.set(name, []);
        eventHandlers.get(name).push(fn);
      },
    },
    mpv: {
      getNative(name) { return name === "track-list" ? tracks : null; },
      getNumber(name) { return mpvProps[name]; },
      getFlag(name) { return Boolean(mpvProps[name]); },
      command(name, args) { mpvCommands.push([name, out(args)]); },
    },
    file: {
      read(p) {
        if (!files.has(p)) throw new Error(`no such file: ${p}`);
        return files.get(p);
      },
      write(p, text) { files.set(p, text); },
    },
    utils: {
      resolvePath(p) { return p.replace(/^@tmp\//, "/tmp/iina-test/"); },
      async exec(cmd, args) {
        const script = args[args.length - 1];
        execCalls.push(script);
        // Awaited, so a test can hold a command open and keep a save in flight.
        const override = await execImpl(script, { files });
        if (override) return Object.assign({ status: 0, stdout: "", stderr: "" }, override);
        // `cat <path>` is main.js's fallback subtitle reader, so serve it from the
        // virtual files rather than making every fallback look like an empty file.
        const cat = script.match(/^cat '(.+)'$/);
        const stdout = cat && files.has(cat[1]) ? files.get(cat[1]) : "";
        return { status: 0, stdout, stderr: "" };
      },
    },
  };

  const context = vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(MAIN_PATH, "utf8"), { filename: "main.js" }).runInContext(context);

  const api = {
    posted,
    osd,
    errors,
    execCalls,
    files,
    mpvCommands,
    mpvProps,

    setTracks(next) { tracks = next; },
    setTime(t) { mpvProps["time-pos"] = t; },
    advanceClock(ms) { now += ms; },

    /** Deliver a UI -> main message, the way standaloneWindow does. */
    send(name, data) {
      const fn = messageHandlers.get(name);
      if (!fn) throw new Error(`main.js registered no handler for "${name}"`);
      return fn(data);
    },

    /** Deliver an mpv event, the way iina.event does. */
    emit(name, data) {
      const fns = eventHandlers.get(name) || [];
      return Promise.all(fns.map(fn => fn(data)));
    },

    /** Run every pending non-repeating timer, e.g. the autosave debounce. */
    async runTimers() {
      const pending = [...timers.entries()].filter(([, t]) => !t.repeating);
      for (const [id, t] of pending) {
        timers.delete(id);
        await t.fn();
      }
      await api.settle();
    },

    /** Run the playback ticker once. */
    async tick() {
      for (const t of timers.values()) if (t.repeating) await t.fn();
    },

    hasPendingTimer() {
      return [...timers.values()].some(t => !t.repeating);
    },

    /** Let queued promise jobs drain, since main.js's handlers are fire-and-forget. */
    async settle() {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      await new Promise(r => setImmediate(r));
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },

    /** Every message of one name, in order. */
    sent(name) {
      return posted.filter(m => m.name === name).map(m => m.data);
    },

    lastSent(name) {
      const all = api.sent(name);
      return all[all.length - 1];
    },

    /** The text the last save staged for writing -- i.e. the serialized .srt. */
    stagedText() {
      return files.get("@tmp/subtitle-navigator-save.srt");
    },
  };

  return api;
}

/** A track-list entry shaped the way mpv reports one. */
function subTrack(id, filename, extra = {}) {
  return { id, type: "sub", "external-filename": filename, title: "", lang: "", selected: false, ...extra };
}

module.exports = { createPlugin, subTrack };
