const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_DOWNLOAD_URL,
  UPDATE_START_DELAY_MS,
  UPDATE_STATE_KEYS,
  UpdateService,
  registerUpdateIpc,
  sanitizeErrorCode,
} = require("../electron/updater.cjs");

function fakeApp({ packaged = true, version = "0.27.0" } = {}) {
  return {
    isPackaged: packaged,
    getVersion: () => version,
  };
}

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = true;
  updater.allowDowngrade = true;
  updater.disableWebInstaller = false;
  updater.logger = console;
  updater.checkForUpdates = async () => ({
    isUpdateAvailable: false,
    updateInfo: { version: "0.27.0" },
  });
  updater.quitAndInstall = () => {};
  return updater;
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const makeHandle = (kind, callback, delay) => ({
    kind,
    callback,
    delay,
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
  });
  return {
    timeouts,
    intervals,
    clearedTimeouts,
    clearedIntervals,
    api: {
      setTimeout(callback, delay) {
        const handle = makeHandle("timeout", callback, delay);
        timeouts.push(handle);
        return handle;
      },
      clearTimeout(handle) {
        clearedTimeouts.push(handle);
      },
      setInterval(callback, delay) {
        const handle = makeHandle("interval", callback, delay);
        intervals.push(handle);
        return handle;
      },
      clearInterval(handle) {
        clearedIntervals.push(handle);
      },
    },
  };
}

test("updater remains disabled outside a packaged Windows NSIS build", () => {
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls += 1;
    return fakeUpdater();
  };
  const development = new UpdateService({
    app: fakeApp({ packaged: false }),
    platform: "win32",
    env: {},
    autoUpdaterFactory: factory,
  });
  const portable = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: { PORTABLE_EXECUTABLE_FILE: "C:\\TokenCat.exe" },
    autoUpdaterFactory: factory,
  });
  const otherPlatform = new UpdateService({
    app: fakeApp(),
    platform: "linux",
    env: {},
    autoUpdaterFactory: factory,
  });

  assert.deepEqual(
    [
      development.start().distribution,
      portable.start().distribution,
      otherPlatform.start().distribution,
    ],
    ["development", "portable", "development"],
  );
  assert.equal(development.getState().supported, false);
  assert.equal(portable.getState().supported, false);
  assert.equal(otherPlatform.getState().supported, false);
  assert.equal(development.getState().status, "disabled");
  assert.equal(portable.getState().status, "disabled");
  assert.equal(factoryCalls, 0);
});

test("start configures the updater and schedules unrefed 15-second and 6-hour checks", () => {
  const updater = fakeUpdater();
  const timers = fakeTimers();
  const service = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: {},
    autoUpdater: updater,
    timers: timers.api,
  });

  service.start();
  service.start();

  assert.equal(updater.logger, null);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0].delay, UPDATE_START_DELAY_MS);
  assert.equal(timers.timeouts[0].unrefCalled, true);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].delay, UPDATE_CHECK_INTERVAL_MS);
  assert.equal(timers.intervals[0].unrefCalled, true);
  assert.equal(updater.listenerCount("update-downloaded"), 1);

  service.shutdown();

  assert.equal(timers.clearedTimeouts.length, 1);
  assert.equal(timers.clearedIntervals.length, 1);
  assert.equal(updater.listenerCount("update-downloaded"), 0);
});

test("update events expose only sanitized state fields", () => {
  const updater = fakeUpdater();
  const snapshots = [];
  const fixedTime = Date.parse("2026-07-30T10:00:00.000Z");
  const service = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: {},
    autoUpdater: updater,
    now: () => fixedTime,
    onStateChanged: (snapshot) => snapshots.push(snapshot),
  });
  service.start();

  updater.emit("checking-for-update");
  updater.emit("update-available", {
    version: "0.28.0",
    releaseNotes: "must not reach the renderer",
    path: "C:\\Users\\secret\\update.exe",
  });
  updater.emit("download-progress", {
    percent: 34.6,
    transferred: 346,
    total: 1_000,
    bytesPerSecond: 999_999,
  });
  updater.emit("update-downloaded", {
    version: "0.28.0",
    downloadedFile: "C:\\Users\\secret\\update.exe",
    releaseNotes: "<script>secret</script>",
  });

  const state = service.getState();
  assert.deepEqual(Object.keys(state), UPDATE_STATE_KEYS);
  assert.equal(state.status, "ready");
  assert.equal(state.availableVersion, "0.28.0");
  assert.equal(state.progressPercent, 100);
  assert.equal(state.transferred, 1_000);
  assert.equal(state.total, 1_000);
  assert.equal(state.checkedAt, "2026-07-30T10:00:00.000Z");
  assert.equal(state.downloadedAt, "2026-07-30T10:00:00.000Z");
  assert.equal("releaseNotes" in state, false);
  assert.equal("path" in state, false);
  assert.equal("bytesPerSecond" in state, false);
  assert.ok(snapshots.every((snapshot) =>
    Object.keys(snapshot).every((key) => UPDATE_STATE_KEYS.includes(key)),
  ));

  updater.emit("error", new Error("C:\\private\\token.txt"));
  assert.equal(service.getState().status, "ready");
  service.shutdown();
});

test("checks are deduplicated and errors never expose raw messages", async () => {
  const updater = fakeUpdater();
  const timers = fakeTimers();
  let checkCount = 0;
  let resolveCheck;
  updater.checkForUpdates = () => {
    checkCount += 1;
    return new Promise((resolve) => {
      resolveCheck = resolve;
    });
  };
  const service = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: {},
    autoUpdater: updater,
    timers: timers.api,
  });
  service.start();

  const first = service.checkForUpdates();
  const second = service.checkForUpdates();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(checkCount, 1);
  assert.equal(timers.clearedTimeouts.length, 1);

  resolveCheck({
    isUpdateAvailable: false,
    updateInfo: {
      version: "0.27.0",
      releaseNotes: "discard",
      files: [{ url: "https://example.invalid/private.exe" }],
    },
  });
  const result = await first;
  assert.equal(result.status, "up-to-date");
  assert.equal(result.availableVersion, null);
  assert.deepEqual(Object.keys(result), UPDATE_STATE_KEYS);

  updater.checkForUpdates = async () => {
    const error = new Error(
      "connect ECONNRESET C:\\Users\\person\\token-secret.txt",
    );
    error.code = "ECONNRESET";
    throw error;
  };
  const failed = await service.checkForUpdates();
  assert.equal(failed.status, "error");
  assert.equal(failed.errorCode, "UPDATE_NETWORK_ERROR");
  assert.equal(
    JSON.stringify(failed).includes("token-secret"),
    false,
  );
  service.shutdown();
});

test("automatic download rejection is observed without changing check result semantics", async () => {
  const updater = fakeUpdater();
  let rejectDownload;
  const downloadPromise = new Promise((_resolve, reject) => {
    rejectDownload = reject;
  });
  updater.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: {
      version: "0.28.0",
      releaseNotes: "discard",
    },
    downloadPromise,
  });
  const service = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: {},
    autoUpdater: updater,
  });
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    service.start();
    const checkState = await service.checkForUpdates();
    assert.equal(checkState.status, "available");
    assert.equal(checkState.availableVersion, "0.28.0");

    rejectDownload(
      new Error("download failed at C:\\Users\\private\\token.txt"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(service.getState().status, "error");
    assert.equal(
      service.getState().errorCode,
      "UPDATE_DOWNLOAD_FAILED",
    );
    assert.equal(
      JSON.stringify(service.getState()).includes("token.txt"),
      false,
    );

    // electron-updater can emit its generic error event for the same
    // rejection. It must not erase the more useful download classification.
    updater.emit("error", new Error("the same generic failure"));
    assert.equal(
      service.getState().errorCode,
      "UPDATE_DOWNLOAD_FAILED",
    );
  } finally {
    process.removeListener(
      "unhandledRejection",
      onUnhandledRejection,
    );
    service.shutdown();
  }
});

test("error classification returns stable codes without preserving input", () => {
  assert.equal(
    sanitizeErrorCode(new Error("sha512 checksum mismatch")),
    "UPDATE_CHECKSUM_MISMATCH",
  );
  assert.equal(
    sanitizeErrorCode(new Error("publisher signature mismatch")),
    "UPDATE_SIGNATURE_INVALID",
  );
  assert.equal(
    sanitizeErrorCode(new Error("missing app-update.yml")),
    "UPDATE_CONFIG_MISSING",
  );
  assert.equal(
    sanitizeErrorCode(
      new Error("C:\\Users\\private\\access-token.txt"),
      "UPDATE_CHECK_FAILED",
    ),
    "UPDATE_CHECK_FAILED",
  );
});

test("install prepares application shutdown before quitAndInstall", () => {
  const updater = fakeUpdater();
  const order = [];
  updater.quitAndInstall = (...args) => {
    order.push(["quitAndInstall", ...args]);
  };
  const service = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: {},
    autoUpdater: updater,
    beforeInstall: () => order.push(["beforeInstall"]),
  });
  service.start();

  assert.equal(service.installUpdate(), false);
  updater.emit("update-downloaded", { version: "0.28.0" });
  assert.equal(service.installUpdate(), true);
  assert.equal(service.installUpdate(), false);
  assert.deepEqual(order, [
    ["beforeInstall"],
    ["quitAndInstall", false, true],
  ]);
  service.shutdown();
});

test("failed installation restores application state and reports a stable error", () => {
  const updater = fakeUpdater();
  const order = [];
  updater.quitAndInstall = () => {
    order.push("quitAndInstall");
    throw new Error("installer failed at C:\\Users\\private\\update.exe");
  };
  const service = new UpdateService({
    app: fakeApp(),
    platform: "win32",
    env: {},
    autoUpdater: updater,
    beforeInstall: () => order.push("beforeInstall"),
    afterInstallFailure: () => order.push("afterInstallFailure"),
  });
  service.start();
  updater.emit("update-downloaded", { version: "0.28.0" });

  assert.equal(service.installUpdate(), false);
  assert.deepEqual(order, [
    "beforeInstall",
    "quitAndInstall",
    "afterInstallFailure",
  ]);
  assert.equal(service.getState().status, "error");
  assert.equal(
    service.getState().errorCode,
    "UPDATE_INSTALL_FAILED",
  );
  assert.equal(
    JSON.stringify(service.getState()).includes("private"),
    false,
  );
  service.shutdown();
});

test("download page always uses the fixed public GitHub Releases URL", async () => {
  const opened = [];
  const service = new UpdateService({
    app: fakeApp({ packaged: false }),
    platform: "win32",
    env: {},
    openExternal: async (url) => opened.push(url),
  });

  assert.equal(
    await service.openUpdateDownloadPage("https://evil.invalid"),
    true,
  );
  assert.deepEqual(opened, [UPDATE_DOWNLOAD_URL]);
});

test("update IPC rejects unknown renderer senders", async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      removed.push(channel);
      handlers.delete(channel);
    },
  };
  const calls = [];
  const service = {
    getState() {
      calls.push("get");
      return { status: "idle" };
    },
    checkForUpdates() {
      calls.push("check");
      return Promise.resolve({ status: "up-to-date" });
    },
    installUpdate() {
      calls.push("install");
      return true;
    },
    openUpdateDownloadPage() {
      calls.push("open");
      return Promise.resolve(true);
    },
  };
  const unregister = registerUpdateIpc(
    ipcMain,
    service,
    (event) => event.sender === "trusted",
  );

  assert.equal(
    await handlers.get("updates:get-state")({ sender: "unknown" }),
    null,
  );
  assert.equal(
    await handlers.get("updates:check")({ sender: "unknown" }),
    null,
  );
  assert.equal(
    await handlers.get("updates:install")({ sender: "unknown" }),
    false,
  );
  assert.equal(
    await handlers.get("updates:open-download-page")({
      sender: "unknown",
    }),
    false,
  );
  assert.deepEqual(calls, []);

  assert.deepEqual(
    await handlers.get("updates:get-state")({ sender: "trusted" }),
    { status: "idle" },
  );
  assert.deepEqual(
    await handlers.get("updates:check")({ sender: "trusted" }),
    { status: "up-to-date" },
  );
  assert.equal(
    await handlers.get("updates:install")({ sender: "trusted" }),
    true,
  );
  assert.equal(
    await handlers.get("updates:open-download-page")({
      sender: "trusted",
    }),
    true,
  );
  assert.deepEqual(calls, ["get", "check", "install", "open"]);

  unregister();
  assert.equal(handlers.size, 0);
  assert.equal(removed.length, 4);
});
