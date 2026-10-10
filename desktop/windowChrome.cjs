const TITLE_BAR_HEIGHT = 36;

const windowChromeOptions = (platform, dark) => platform === "win32" ? {
  titleBarStyle: "hidden",
  titleBarOverlay: {
    color: dark ? "#28251f" : "#fffdf8",
    symbolColor: dark ? "#f0ebe1" : "#332f29",
    height: TITLE_BAR_HEIGHT,
  },
  backgroundColor: dark ? "#1e1c19" : "#f4f1ea",
} : {};

const windowChromeState = (window, platform) => ({
  enabled: platform === "win32",
  fullscreen: window.isFullScreen(),
});

const attachWindowChrome = (window, platform) => {
  for (const event of ["enter-full-screen", "leave-full-screen"]) {
    window.on(event, () => {
      if (!window.isDestroyed()) window.webContents.send("study-journal:window-chrome-state", { enabled: platform === "win32", fullscreen: event === "enter-full-screen" });
    });
  }
};

const registerWindowChrome = (ipcMain, getWindow, platform) => {
  const trustedWindow = (event) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("Window appearance is restricted to the main frame.");
    }
    return window;
  };
  ipcMain.handle("study-journal:window-chrome-state", event => windowChromeState(trustedWindow(event), platform));
  ipcMain.handle("study-journal:window-chrome-appearance", (event, appearance) => {
    const window = trustedWindow(event);
    if (!appearance || typeof appearance !== "object" || ![appearance.color, appearance.symbolColor].every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) {
      throw new Error("Invalid window appearance.");
    }
    if (platform !== "win32") return;
    window.setTitleBarOverlay({ color: appearance.color, symbolColor: appearance.symbolColor, height: TITLE_BAR_HEIGHT });
    window.setBackgroundColor(appearance.color);
  });
};

module.exports = { windowChromeOptions, attachWindowChrome, registerWindowChrome };
