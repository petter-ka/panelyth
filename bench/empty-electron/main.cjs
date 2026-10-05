// Empty Electron baseline: one sandboxed window with a trivial page, no preload.
const { app, BrowserWindow } = require("electron")
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  win.loadURL("data:text/html,<title>empty</title><p>empty</p>")
})
app.on("window-all-closed", () => app.quit())
