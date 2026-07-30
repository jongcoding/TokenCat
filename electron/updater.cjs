const UPDATE_DOWNLOAD_URL =
  "https://github.com/jongcoding/TokenCat/releases/latest";
const UPDATE_START_DELAY_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const UPDATE_STATE_KEYS = Object.freeze([
  "status",
  "distribution",
  "supported",
  "currentVersion",
  "availableVersion",
  "progressPercent",
  "transferred",
  "total",
  "checkedAt",
  "downloadedAt",
  "errorCode",
]);

function sanitizeVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function sanitizeProgressNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(maximum, Math.round(numeric));
}

function sanitizeErrorCode(error, fallback = "UPDATE_FAILED") {
  const code =
    typeof error?.code === "string" ? error.code.toUpperCase() : "";
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  const combined = `${code} ${message}`.toUpperCase();

  if (
    combined.includes("ERR_INTERNET_DISCONNECTED") ||
    combined.includes("ENETUNREACH") ||
    combined.includes("ENOTFOUND") ||
    combined.includes("ECONNRESET") ||
    combined.includes("ECONNREFUSED") ||
    combined.includes("ETIMEDOUT") ||
    combined.includes("NETWORK")
  ) {
    return "UPDATE_NETWORK_ERROR";
  }
  if (
    combined.includes("APP-UPDATE.YML") ||
    combined.includes("DEV-APP-UPDATE.YML") ||
    combined.includes("ERR_UPDATER_INVALID_RELEASE_FEED")
  ) {
    return "UPDATE_CONFIG_MISSING";
  }
  if (
    combined.includes("LATEST.YML") ||
    combined.includes("LATEST VERSION") ||
    combined.includes("ERR_UPDATER_LATEST_VERSION_NOT_FOUND")
  ) {
    return "UPDATE_METADATA_UNAVAILABLE";
  }
  if (
    combined.includes("SIGNATURE") ||
    combined.includes("PUBLISHER NAME")
  ) {
    return "UPDATE_SIGNATURE_INVALID";
  }
  if (
    combined.includes("CHECKSUM") ||
    combined.includes("SHA512") ||
    combined.includes("HASH MISMATCH")
  ) {
    return "UPDATE_CHECKSUM_MISMATCH";
  }
  if (combined.includes("CANCEL")) {
    return "UPDATE_CANCELLED";
  }
  return fallback;
}

function detectDistribution(app, platform, env) {
  if (!app?.isPackaged) return "development";
  if (env?.PORTABLE_EXECUTABLE_FILE) return "portable";
  return platform === "win32" ? "nsis" : "development";
}

function defaultAutoUpdaterFactory() {
  // Keep this lazy so development and portable builds never initialize an
  // updater that cannot safely install their package type.
  const electronUpdater = require("electron-updater");
  return electronUpdater.autoUpdater;
}

class UpdateService {
  constructor(options = {}) {
    this.app = options.app;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    this.autoUpdater = options.autoUpdater ?? null;
    this.autoUpdaterFactory =
      options.autoUpdaterFactory ?? defaultAutoUpdaterFactory;
    this.onStateChanged =
      typeof options.onStateChanged === "function"
        ? options.onStateChanged
        : () => {};
    this.beforeInstall =
      typeof options.beforeInstall === "function"
        ? options.beforeInstall
        : () => {};
    this.afterInstallFailure =
      typeof options.afterInstallFailure === "function"
        ? options.afterInstallFailure
        : () => {};
    this.openExternal =
      typeof options.openExternal === "function"
        ? options.openExternal
        : null;
    this.startDelayMs =
      options.startDelayMs ?? UPDATE_START_DELAY_MS;
    this.checkIntervalMs =
      options.checkIntervalMs ?? UPDATE_CHECK_INTERVAL_MS;

    const distribution = detectDistribution(
      this.app,
      this.platform,
      this.env,
    );
    const supported =
      Boolean(this.app?.isPackaged) &&
      this.platform === "win32" &&
      distribution === "nsis";
    this.state = Object.freeze({
      status: supported ? "idle" : "disabled",
      distribution,
      supported,
      currentVersion:
        sanitizeVersion(this.app?.getVersion?.()) ?? "0.0.0",
      availableVersion: null,
      progressPercent: null,
      transferred: null,
      total: null,
      checkedAt: null,
      downloadedAt: null,
      errorCode: null,
    });

    this.started = false;
    this.installing = false;
    this.checkPromise = null;
    this.startupTimer = null;
    this.intervalTimer = null;
    this.updaterListeners = [];
    this.handledDownloadPromises = new WeakSet();
  }

  getState() {
    const snapshot = {};
    for (const key of UPDATE_STATE_KEYS) snapshot[key] = this.state[key];
    return snapshot;
  }

  _timestamp() {
    try {
      return new Date(this.now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  _setState(patch) {
    this.state = Object.freeze({ ...this.state, ...patch });
    const snapshot = this.getState();
    try {
      this.onStateChanged(snapshot);
    } catch {
      // UI delivery must never interrupt update state management.
    }
    return snapshot;
  }

  _listen(eventName, listener) {
    this.autoUpdater.on(eventName, listener);
    this.updaterListeners.push([eventName, listener]);
  }

  _bindUpdaterEvents() {
    this._listen("checking-for-update", () => {
      if (this.state.status === "ready") return;
      this._setState({
        status: "checking",
        errorCode: null,
        progressPercent: null,
        transferred: null,
        total: null,
      });
    });
    this._listen("update-available", (info) => {
      if (this.state.status === "ready") return;
      this._setState({
        status: "available",
        availableVersion:
          sanitizeVersion(info?.version) ?? this.state.availableVersion,
        checkedAt: this._timestamp(),
        errorCode: null,
      });
    });
    this._listen("update-not-available", () => {
      if (this.state.status === "ready") return;
      this._setState({
        status: "up-to-date",
        availableVersion: null,
        progressPercent: null,
        transferred: null,
        total: null,
        checkedAt: this._timestamp(),
        downloadedAt: null,
        errorCode: null,
      });
    });
    this._listen("download-progress", (progress) => {
      if (this.state.status === "ready") return;
      this._setState({
        status: "downloading",
        progressPercent: sanitizeProgressNumber(progress?.percent, 100),
        transferred: sanitizeProgressNumber(progress?.transferred),
        total: sanitizeProgressNumber(progress?.total),
        errorCode: null,
      });
    });
    this._listen("update-downloaded", (info) => {
      this._setState({
        status: "ready",
        availableVersion:
          sanitizeVersion(info?.version) ?? this.state.availableVersion,
        progressPercent: 100,
        transferred:
          this.state.total ?? this.state.transferred,
        downloadedAt: this._timestamp(),
        errorCode: null,
      });
    });
    this._listen("update-cancelled", () => {
      if (this.state.status === "ready") return;
      this._setState({
        status: "error",
        errorCode: "UPDATE_CANCELLED",
        checkedAt: this._timestamp(),
      });
    });
    this._listen("error", (error) => {
      this._recordError(error);
    });
  }

  _recordError(error, fallback, allowReady = false) {
    if (this.state.status === "ready" && !allowReady) {
      return this.getState();
    }
    const errorCode = sanitizeErrorCode(error, fallback);
    if (
      this.state.status === "error" &&
      this.state.errorCode &&
      errorCode === "UPDATE_FAILED"
    ) {
      return this.getState();
    }
    return this._setState({
      status: "error",
      errorCode,
      checkedAt: this._timestamp(),
      progressPercent: null,
      transferred: null,
      total: null,
    });
  }

  _observeDownloadPromise(result) {
    const downloadPromise = result?.downloadPromise;
    if (
      (typeof downloadPromise !== "object" &&
        typeof downloadPromise !== "function") ||
      downloadPromise === null ||
      typeof downloadPromise.catch !== "function" ||
      this.handledDownloadPromises.has(downloadPromise)
    ) {
      return;
    }
    this.handledDownloadPromises.add(downloadPromise);
    try {
      void downloadPromise.catch((error) => {
        this._recordError(error, "UPDATE_DOWNLOAD_FAILED");
      });
    } catch (error) {
      this._recordError(error, "UPDATE_DOWNLOAD_FAILED");
    }
  }

  _unrefTimer(timer) {
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  _clearStartupTimer() {
    if (this.startupTimer === null) return;
    this.timers.clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  start() {
    if (this.started || !this.state.supported) return this.getState();
    this.started = true;

    try {
      if (!this.autoUpdater) {
        this.autoUpdater = this.autoUpdaterFactory();
      }
      if (
        !this.autoUpdater ||
        typeof this.autoUpdater.checkForUpdates !== "function"
      ) {
        throw new Error("UPDATE_ENGINE_UNAVAILABLE");
      }
      this.autoUpdater.logger = null;
      this.autoUpdater.autoDownload = true;
      this.autoUpdater.autoInstallOnAppQuit = true;
      this.autoUpdater.allowPrerelease = false;
      this.autoUpdater.allowDowngrade = false;
      if ("disableWebInstaller" in this.autoUpdater) {
        this.autoUpdater.disableWebInstaller = true;
      }
      this._bindUpdaterEvents();
    } catch (error) {
      this._recordError(error, "UPDATE_ENGINE_UNAVAILABLE");
      return this.getState();
    }

    this.startupTimer = this.timers.setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates();
    }, this.startDelayMs);
    this._unrefTimer(this.startupTimer);

    this.intervalTimer = this.timers.setInterval(() => {
      void this.checkForUpdates();
    }, this.checkIntervalMs);
    this._unrefTimer(this.intervalTimer);
    return this.getState();
  }

  checkForUpdates() {
    if (!this.state.supported) {
      return Promise.resolve(this.getState());
    }
    if (!this.started) this.start();
    if (!this.autoUpdater) {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) return this.checkPromise;
    if (
      this.state.status === "ready" ||
      this.state.status === "available" ||
      this.state.status === "downloading"
    ) {
      return Promise.resolve(this.getState());
    }

    this._clearStartupTimer();
    this._setState({
      status: "checking",
      errorCode: null,
      progressPercent: null,
      transferred: null,
      total: null,
    });

    const checkPromise = Promise.resolve()
      .then(() => this.autoUpdater.checkForUpdates())
      .then((result) => {
        this._observeDownloadPromise(result);
        if (this.state.status === "checking") {
          const availableVersion = sanitizeVersion(
            result?.updateInfo?.version,
          );
          this._setState({
            status:
              result?.isUpdateAvailable === true
                ? "available"
                : "up-to-date",
            availableVersion:
              result?.isUpdateAvailable === true
                ? availableVersion
                : null,
            checkedAt: this._timestamp(),
            errorCode: null,
          });
        }
        return this.getState();
      })
      .catch((error) => {
        this._recordError(error, "UPDATE_CHECK_FAILED");
        return this.getState();
      })
      .finally(() => {
        if (this.checkPromise === checkPromise) {
          this.checkPromise = null;
        }
      });
    this.checkPromise = checkPromise;
    return checkPromise;
  }

  installUpdate() {
    if (
      !this.state.supported ||
      this.state.status !== "ready" ||
      !this.autoUpdater ||
      typeof this.autoUpdater.quitAndInstall !== "function" ||
      this.installing
    ) {
      return false;
    }
    this.installing = true;
    try {
      this.beforeInstall();
      this.autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      this.installing = false;
      try {
        this.afterInstallFailure();
      } catch {
        // Recovery hooks must not hide the original installation failure.
      }
      this._recordError(error, "UPDATE_INSTALL_FAILED", true);
      return false;
    }
  }

  async openUpdateDownloadPage() {
    if (!this.openExternal) return false;
    try {
      await this.openExternal(UPDATE_DOWNLOAD_URL);
      return true;
    } catch {
      return false;
    }
  }

  shutdown() {
    this._clearStartupTimer();
    if (this.intervalTimer !== null) {
      this.timers.clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.autoUpdater) {
      for (const [eventName, listener] of this.updaterListeners) {
        if (typeof this.autoUpdater.removeListener === "function") {
          this.autoUpdater.removeListener(eventName, listener);
        }
      }
    }
    this.updaterListeners = [];
  }
}

function registerUpdateIpc(ipcMain, service, isTrustedSender) {
  const trusted =
    typeof isTrustedSender === "function" ? isTrustedSender : () => false;
  const authorize = (event) => {
    try {
      return Boolean(trusted(event));
    } catch {
      return false;
    }
  };

  ipcMain.handle("updates:get-state", (event) =>
    authorize(event) ? service.getState() : null,
  );
  ipcMain.handle("updates:check", (event) =>
    authorize(event) ? service.checkForUpdates() : null,
  );
  ipcMain.handle("updates:install", (event) =>
    authorize(event) ? service.installUpdate() : false,
  );
  ipcMain.handle("updates:open-download-page", (event) =>
    authorize(event) ? service.openUpdateDownloadPage() : false,
  );

  return () => {
    for (const channel of [
      "updates:get-state",
      "updates:check",
      "updates:install",
      "updates:open-download-page",
    ]) {
      ipcMain.removeHandler?.(channel);
    }
  };
}

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_DOWNLOAD_URL,
  UPDATE_START_DELAY_MS,
  UPDATE_STATE_KEYS,
  UpdateService,
  detectDistribution,
  registerUpdateIpc,
  sanitizeErrorCode,
  sanitizeVersion,
};
