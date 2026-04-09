const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotaApi", {
  getDefaults: () => ipcRenderer.invoke("quota:get-defaults"),
  getProfileStatus: (payload) => ipcRenderer.invoke("quota:profile-status", payload),
  openLogin: (payload) => ipcRenderer.invoke("quota:open-login", payload),
  fetchRateLimits: (payload) => ipcRenderer.invoke("quota:fetch", payload)
});

contextBridge.exposeInMainWorld("windowApi", {
  syncSize: (payload) => ipcRenderer.invoke("window:sync-size", payload),
  getPosition: () => ipcRenderer.invoke("window:get-position"),
  setPosition: (payload) => ipcRenderer.invoke("window:set-position", payload),
  setAlwaysOnTop: (payload) => ipcRenderer.invoke("window:set-always-on-top", payload),
  showWidgetContextMenu: () => ipcRenderer.invoke("window:show-widget-context-menu"),
  getLaunchOnStartup: () => ipcRenderer.invoke("window:get-launch-on-startup"),
  setLaunchOnStartup: (payload) => ipcRenderer.invoke("window:set-launch-on-startup", payload)
});
