const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { safeRepositoryName, assertRepositoryPath } = require("./backupRepositoryPaths.cjs");
test("real desktop IPC keeps account manifests, chunks and deletes isolated and rejects rebound sessions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "backup-ipc-test-"));
  const parent = path.join(workspace, "parent"); const data = path.join(workspace, "data");
  const handlers = new Map();
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const helpers = source.slice(source.indexOf('const DESKTOP_BACKUP_REPOSITORY_NAME'), source.indexOf('const requestDesktopBackupFlush'));
  const ipc = source.slice(source.indexOf('ipcMain.handle("study-journal:desktop-backup-status"'), source.indexOf('ipcMain.on("study-journal:backup-flush-complete"'));
  const context = vm.createContext({ fs, path, existsSync, randomUUID, process, Buffer, safeRepositoryName, assertRepositoryPath, app: { getPath: () => data }, desktopBackupWriteSessions: new Map(), ipcMain: { handle: (name, action) => handlers.set(name, action) } });
  vm.runInContext(helpers + "\n" + ipc, context);
  const call = (name, ...args) => handlers.get("study-journal:desktop-backup-" + name)(null, ...args);
  try {
    await fs.mkdir(parent); await fs.mkdir(data);
    await fs.writeFile(path.join(data, "desktop-auto-backup.json"), JSON.stringify({ folderPath: parent, updatedAt: "first" }));
    await vm.runInContext("writeDesktopBackupBinding(" + JSON.stringify(parent) + ")", context);
    const initialBinding = JSON.parse(await fs.readFile(path.join(data, "desktop-auto-backup.json"), "utf8"));
    await vm.runInContext("writeDesktopBackupBinding(" + JSON.stringify(parent) + ")", context);
    const reboundBinding = JSON.parse(await fs.readFile(path.join(data, "desktop-auto-backup.json"), "utf8"));
    assert.notEqual(initialBinding.generation, reboundBinding.generation);
    for (const owner of ["A", "B", "guest"]) {
      const name = "study-journal-backup-" + owner;
      await call("ensure", name);
      for (let index = 0; index < 6; index += 1) {
        const write = await call("begin-write", name, "snapshots/" + index + ".json");
        await call("append-write", write.sessionId, Buffer.from(owner + index).toString("base64"));
        await call("finish-write", write.sessionId);
      }
      const write = await call("begin-write", name, "manifest.json");
      await call("append-write", write.sessionId, Buffer.from(owner).toString("base64"));
      await call("finish-write", write.sessionId);
    }
    await call("delete", "study-journal-backup-B", "snapshots/0.json");
    assert.equal((await call("list", "study-journal-backup-A", "snapshots")).length, 6);
    assert.equal((await call("list", "study-journal-backup-B", "snapshots")).length, 5);
    assert.equal((await call("read-text", "study-journal-backup-A", "manifest.json")).text, "A");
    assert.equal(Buffer.from((await call("read-chunk", "study-journal-backup-guest", "manifest.json", 0, 100)).data, "base64").toString(), "guest");
    await assert.rejects(call("delete", "../other", "manifest.json"));
    const write = await call("begin-write", "study-journal-backup-A", "manifest.json");
    await call("append-write", write.sessionId, Buffer.from("not committed").toString("base64"));
    await fs.writeFile(path.join(data, "desktop-auto-backup.json"), JSON.stringify({ folderPath: parent, updatedAt: "rebound" }));
    await assert.rejects(call("finish-write", write.sessionId), /绑定已变化/);
    assert.equal((await call("read-text", "study-journal-backup-A", "manifest.json")).text, "A");
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
