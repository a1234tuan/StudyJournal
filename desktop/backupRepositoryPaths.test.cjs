const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { safeRepositoryName, assertRepositoryPath } = require("./backupRepositoryPaths.cjs");
test("validates destination names and rejects path aliases", () => {
  for (const value of ["..", "../other", "a/b", "a\\b", "D:other", "CON", "backup.", "", undefined]) assert.throws(() => safeRepositoryName(value));
  assert.equal(safeRepositoryName("study-journal-backup-A"), "study-journal-backup-A");
});
test("isolates six snapshots and cleanup for account and guest roots on a real filesystem", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-path-test-"));
  try {
    for (const owner of ["A", "B", "guest"]) {
      const root = path.join(parent, safeRepositoryName("study-journal-backup-" + owner));
      await assertRepositoryPath(parent, root); await fs.mkdir(path.join(root, "snapshots"), { recursive: true });
      for (let index = 0; index < 6; index += 1) await fs.writeFile(path.join(root, "snapshots", index + ".json"), owner);
      await fs.writeFile(path.join(root, "manifest.json"), owner);
    }
    const root = path.join(parent, "study-journal-backup-B");
    const stale = path.join(root, "snapshots", "0.json");
    await assertRepositoryPath(root, stale); await fs.rm(stale);
    assert.equal(await fs.readFile(path.join(parent, "study-journal-backup-A", "snapshots", "0.json"), "utf8"), "A");
    assert.equal(await fs.readFile(path.join(parent, "study-journal-backup-guest", "manifest.json"), "utf8"), "guest");
    await assert.rejects(assertRepositoryPath(root, path.join(parent, "study-journal-backup-A", "manifest.json")));
    const link = path.join(root, "foreign");
    await fs.symlink(path.join(parent, "study-journal-backup-A"), link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(assertRepositoryPath(root, path.join(link, "manifest.json")));
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
