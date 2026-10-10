const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { windowChromeOptions, attachWindowChrome, registerWindowChrome } = require("./windowChrome.cjs");

const harness = (platform = "win32") => {
  const handlers = new Map();
  const applied = [];
  const sent = [];
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    fullscreen: false,
    isDestroyed() { return this.destroyed; },
    isFullScreen() { return this.fullscreen; },
    setTitleBarOverlay: value => applied.push(value),
    setBackgroundColor: value => applied.push(value),
    webContents: { mainFrame: {}, send: (...args) => sent.push(args) },
  });
  registerWindowChrome({ handle: (name, handler) => handlers.set(name, handler) }, () => window, platform);
  attachWindowChrome(window, platform);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { window, event, applied, sent, invoke: (name, payload, sender = event) => handlers.get("study-journal:window-chrome-" + name)(sender, payload) };
};

test("only Windows uses native window controls overlay with theme-aware startup colors", () => {
  assert.equal(windowChromeOptions("win32", false).titleBarStyle, "hidden");
  assert.equal(windowChromeOptions("win32", false).titleBarOverlay.height, 36);
  assert.equal(windowChromeOptions("win32", true).titleBarOverlay.symbolColor, "#f0ebe1");
  assert.equal(windowChromeOptions("win32", false).frame, undefined);
  assert.deepEqual(windowChromeOptions("darwin", false), {});
  assert.deepEqual(windowChromeOptions("linux", true), {});
});

test("appearance updates only accept colors and retain the native control height", () => {
  const runtime = harness();
  runtime.invoke("appearance", { color: "#fffdf8", symbolColor: "#332f29", height: 0 });
  assert.deepEqual(runtime.applied, [{ color: "#fffdf8", symbolColor: "#332f29", height: 36 }, "#fffdf8"]);
});

test("appearance rejects invalid colors before invoking native methods", () => {
  const runtime = harness();
  for (const payload of [null, [], {}, { color: "red", symbolColor: "#000000" }, { color: "#ffffff", symbolColor: 42 }, { color: "#ffffff00", symbolColor: "#000000" }]) {
    assert.throws(() => runtime.invoke("appearance", payload), /Invalid/);
  }
  assert.deepEqual(runtime.applied, []);
});

test("state and appearance reject foreign windows, subframes and destroyed senders", () => {
  const runtime = harness();
  for (const sender of [{ sender: {}, senderFrame: {} }, { ...runtime.event, senderFrame: {} }]) {
    assert.throws(() => runtime.invoke("state", undefined, sender), /restricted/);
    assert.throws(() => runtime.invoke("appearance", { color: "#ffffff", symbolColor: "#000000" }, sender), /restricted/);
  }
  runtime.window.destroyed = true;
  assert.throws(() => runtime.invoke("state"), /restricted/);
  assert.deepEqual(runtime.applied, []);
});

test("fullscreen events report state without replacing close or minimize semantics", () => {
  const runtime = harness();
  assert.deepEqual(runtime.invoke("state"), { enabled: true, fullscreen: false });
  runtime.window.emit("enter-full-screen");
  runtime.window.fullscreen = true;
  runtime.window.emit("leave-full-screen");
  assert.deepEqual(runtime.sent.map(entry => entry[1].fullscreen), [true, false]);
  assert.equal(runtime.window.listenerCount("close"), 0);
  assert.equal(runtime.window.listenerCount("minimize"), 0);
});

test("unsupported platforms retain their existing window appearance", () => {
  const runtime = harness("darwin");
  assert.deepEqual(runtime.invoke("state"), { enabled: false, fullscreen: false });
  runtime.invoke("appearance", { color: "#ffffff", symbolColor: "#000000" });
  assert.deepEqual(runtime.applied, []);
});
