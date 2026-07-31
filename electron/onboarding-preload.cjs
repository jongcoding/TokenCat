const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tokenCatOnboarding", {
  getInfo: () => ipcRenderer.invoke("onboarding:get-info"),
  close: (result) =>
    ipcRenderer.invoke("app:close-onboarding-window", result),
  begin: (provider) =>
    ipcRenderer.invoke("onboarding:begin-account-connection", provider),
});
