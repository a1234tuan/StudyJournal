const { test } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");
const { openVoiceAsrSocket, sendVoiceAsrFrame } = require("./voiceAsrSocket.cjs");

test("host sends text control frames and binary PCM to a real local server", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  let socket;
  try {
    const received = new Promise((resolve) => server.once("connection", (peer, request) => {
      assert.equal(request.headers.authorization, "Bearer deterministic-test");
      const frames = [];
      peer.on("message", (data, binary) => {
        frames.push({ text: data.toString(), binary });
        if (frames.length === 3) resolve(frames);
      });
    }));
    socket = openVoiceAsrSocket("ws://127.0.0.1:" + server.address().port, { Authorization: "Bearer deterministic-test" });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    sendVoiceAsrFrame(socket, JSON.stringify({ action: "run-task" }));
    sendVoiceAsrFrame(socket, new Uint8Array([1, 2, 3]));
    sendVoiceAsrFrame(socket, JSON.stringify({ action: "finish-task" }));
    const frames = await received;
    assert.deepEqual(frames.map((frame) => frame.binary), [false, true, false]);
    assert.equal(JSON.parse(frames[0].text).action, "run-task");
    assert.equal(JSON.parse(frames[2].text).action, "finish-task");
    assert.throws(() => sendVoiceAsrFrame(socket, {}));
  } finally {
    socket?.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("host rejects sends after close", () => {
  assert.throws(() => sendVoiceAsrFrame({ readyState: 3 }, "finish-task"));
});
