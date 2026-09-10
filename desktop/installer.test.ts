import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const installerScript = readFileSync(join(process.cwd(), "desktop", "installer.nsh"), "utf8");
const desktopMain = readFileSync(join(process.cwd(), "desktop", "main.cjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  build: { files: string[] };
};

describe("Windows desktop upgrade", () => {
  it("closes a running app before replacing the installed files", () => {
    expect(installerScript).toContain("Function closeStudyJournalForUpdate");
    expect(installerScript).toContain("Function un.closeStudyJournalForUpdate");
    expect(installerScript).toContain("!macro isStudyJournalRunning");
    expect(installerScript).toContain("!macro customInit");
    expect(installerScript).toContain("!macro customCheckAppRunning");
    expect(installerScript).toContain("tasklist /FI");
    expect(installerScript).toContain('"$INSTDIR\\${APP_PRODUCT_FILENAME}.exe" --quit-for-update');
    expect(installerScript).toContain('taskkill /f /t /im "${APP_PRODUCT_FILENAME}.exe"');
    expect(installerScript).toContain("无法关闭学习日志");
  });

  it("recovers from old uninstallers that cannot move deep install paths", () => {
    expect(installerScript).toContain("!macro customUnInstallCheck");
    expect(installerScript).toContain("!macro customUnInstallCheckCurrentUser");
    expect(installerScript).toContain('RMDir /r "$INSTDIR"');
    expect(packageJson.build.files).toContain("!node_modules/**");
    expect(desktopMain).toContain("try { _oauth = require(\"./oauth-config.cjs\"); }");
    expect(desktopMain).toContain("Desktop Google 登录尚未配置");
    expect(packageJson.build.files).toContain("!desktop/**/*.test.*");
  });

  it("handles the updater shutdown command through the single-instance lock", () => {
    expect(desktopMain).toContain('const UPDATE_QUIT_ARGUMENT = "--quit-for-update"');
    expect(desktopMain).toContain("commandLine.includes(UPDATE_QUIT_ARGUMENT)");
    expect(desktopMain).toContain("closeMainWindowAfterBackup()");
  });
});
