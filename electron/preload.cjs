const { contextBridge, ipcRenderer } = require("electron");

/** @typedef {"horizontal" | "medium" | "vertical"} MinimalOrientation */
/** @typedef {"general" | "dashboard" | "accounts" | "appearance"} SettingsCategory */

const openSettingsListeners = new Set();
const onboardingAccountRequestListeners = new Set();
const updateStateListeners = new Set();
const windowTransparencyListeners = new Set();
let pendingOpenSettingsRequest = null;
let pendingOnboardingAccountRequest = null;

ipcRenderer.on(
  "app:open-settings",
  (_event, category) => {
    /** @type {SettingsCategory} */
    const normalizedCategory = [
      "general",
      "dashboard",
      "accounts",
      "appearance",
    ].includes(category)
      ? category
      : "general";
    const request = { category: normalizedCategory };

    if (openSettingsListeners.size === 0) {
      pendingOpenSettingsRequest = request;
      return;
    }
    for (const listener of openSettingsListeners) {
      listener(request.category);
    }
  },
);

ipcRenderer.on("updates:state-changed", (_event, snapshot) => {
  for (const listener of updateStateListeners) {
    listener(snapshot);
  }
});

ipcRenderer.on("window:transparency-changed", (_event, value) => {
  for (const listener of windowTransparencyListeners) {
    listener(value);
  }
});

ipcRenderer.on(
  "app:onboarding-account-requested",
  (_event, provider) => {
    const normalizedProvider =
      provider === "Codex" ? "Codex" : "Claude";
    if (onboardingAccountRequestListeners.size === 0) {
      pendingOnboardingAccountRequest = normalizedProvider;
      return;
    }
    for (const listener of onboardingAccountRequestListeners) {
      listener(normalizedProvider);
    }
  },
);

contextBridge.exposeInMainWorld("tokenCat", {
  minimize: () => ipcRenderer.send("window:minimize"),
  hide: () => ipcRenderer.send("window:hide"),
  quit: () => ipcRenderer.send("app:quit"),
  openSettings: (category) =>
    ipcRenderer.invoke("app:open-settings-window", category),
  closeSettings: () => ipcRenderer.invoke("app:close-settings-window"),
  openOnboarding: (options) =>
    ipcRenderer.invoke("app:open-onboarding-window", options),
  closeOnboarding: (result) =>
    ipcRenderer.invoke("app:close-onboarding-window", result),
  completeOnboarding: () =>
    ipcRenderer.invoke("app:complete-onboarding-if-needed"),
  togglePin: () => ipcRenderer.invoke("window:toggle-pin"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  setWindowLayout: (
    layout,
    compact,
    quotaOnly,
    widgetScale,
    accountCount,
    cardSurfaceMode,
    minimal,
    /** @type {MinimalOrientation | undefined} */ minimalOrientation,
    /** @type {"manual" | "auto-resize" | undefined} */ transitionSource,
  ) =>
    ipcRenderer.invoke(
      "window:set-layout",
      layout,
      compact,
      quotaOnly,
      widgetScale,
      accountCount,
      cardSurfaceMode,
      minimal,
      minimalOrientation,
      transitionSource,
    ),
  applyMainWindowLayout: (
    layout,
    compact,
    quotaOnly,
    widgetScale,
    cardSurfaceMode,
    minimal,
    /** @type {MinimalOrientation | undefined} */ minimalOrientation,
  ) =>
    ipcRenderer.invoke(
      "settings:apply-window-layout",
      layout,
      compact,
      quotaOnly,
      widgetScale,
      cardSurfaceMode,
      minimal,
      minimalOrientation,
    ),
  setWindowSizeLocked: (enabled) =>
    ipcRenderer.invoke("window:set-size-locked", enabled),
  saveCurrentWindowSize: () =>
    ipcRenderer.invoke("window:save-current-size"),
  resetSavedWindowSize: () =>
    ipcRenderer.invoke("window:reset-saved-size"),
  setWindowTransparency: (preferences) =>
    ipcRenderer.invoke("window:set-transparency", preferences),
  getSettings: () => ipcRenderer.invoke("app:get-settings"),
  setLanguage: (language) =>
    ipcRenderer.invoke("app:set-language", language),
  setOpenAtLogin: (enabled) =>
    ipcRenderer.invoke("app:set-open-at-login", enabled),
  getUpdateState: () => ipcRenderer.invoke("updates:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  openUpdateDownloadPage: () =>
    ipcRenderer.invoke("updates:open-download-page"),
  onUpdateStateChanged: (callback) => {
    updateStateListeners.add(callback);
    return () => updateStateListeners.delete(callback);
  },
  getIntegrationStatus: () => ipcRenderer.invoke("integrations:get-status"),
  connectIntegration: (provider) =>
    ipcRenderer.invoke("integrations:connect", provider),
  disconnectIntegration: (provider) =>
    ipcRenderer.invoke("integrations:disconnect", provider),
  refreshIntegration: (provider) =>
    ipcRenderer.invoke("integrations:refresh-provider", provider),
  refreshIntegrations: () => ipcRenderer.invoke("integrations:refresh"),
  getManagedIntegrationStatus: () =>
    ipcRenderer.invoke("managed-integrations:get-status"),
  createManagedIntegration: (input) =>
    ipcRenderer.invoke("managed-integrations:create", input),
  startManagedIntegrationLogin: (accountId) =>
    ipcRenderer.invoke("managed-integrations:start-login", accountId),
  removeManagedIntegration: (accountId) =>
    ipcRenderer.invoke("managed-integrations:remove", accountId),
  openManagedIntegration: (accountId) =>
    ipcRenderer.invoke("managed-integrations:open", accountId),
  refreshManagedIntegration: (accountId) =>
    ipcRenderer.invoke(
      "managed-integrations:refresh-account",
      accountId,
    ),
  refreshManagedIntegrations: () =>
    ipcRenderer.invoke("managed-integrations:refresh"),
  onIntegrationSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("integrations:snapshot-changed", listener);
    return () =>
      ipcRenderer.removeListener(
        "integrations:snapshot-changed",
        listener,
      );
  },
  onPinChanged: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("window:pin-changed", listener);
    return () => ipcRenderer.removeListener("window:pin-changed", listener);
  },
  onMaximizedChanged: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("window:maximized-changed", listener);
    return () =>
      ipcRenderer.removeListener("window:maximized-changed", listener);
  },
  onWindowSizeStateChanged: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("window:size-state-changed", listener);
    return () =>
      ipcRenderer.removeListener("window:size-state-changed", listener);
  },
  onWindowTransparencyChanged: (callback) => {
    windowTransparencyListeners.add(callback);
    return () => windowTransparencyListeners.delete(callback);
  },
  onOpenSettings: (callback) => {
    openSettingsListeners.add(callback);
    if (pendingOpenSettingsRequest !== null) {
      const request = pendingOpenSettingsRequest;
      pendingOpenSettingsRequest = null;
      queueMicrotask(() => {
        if (openSettingsListeners.has(callback)) {
          callback(request.category);
        }
      });
    }
    return () => openSettingsListeners.delete(callback);
  },
  onOnboardingAccountRequested: (callback) => {
    onboardingAccountRequestListeners.add(callback);
    if (pendingOnboardingAccountRequest !== null) {
      const provider = pendingOnboardingAccountRequest;
      queueMicrotask(() => {
        if (
          !onboardingAccountRequestListeners.has(callback) ||
          pendingOnboardingAccountRequest !== provider
        ) return;
        pendingOnboardingAccountRequest = null;
        callback(provider);
      });
    }
    return () => onboardingAccountRequestListeners.delete(callback);
  },
});
