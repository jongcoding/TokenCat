const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerIntegrationIpc } = require("./integrations.cjs");
const {
  registerUpdateIpc,
  UpdateService,
} = require("./updater.cjs");

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let integrationService = null;
let updateService = null;
let unregisterUpdateIpc = null;
let isQuitting = false;
let appLanguage = "ko";
let windowMode = {
  schemaVersion: 5,
  layout: "vertical",
  compact: false,
  minimal: false,
  minimalOrientation: "horizontal",
  quotaOnly: false,
  widgetScale: 100,
  accountCount: 3,
  cardSurfaceMode: "separate",
  sizeLocked: false,
  savedSizes: {},
  minimalSizes: {},
};
let manualResizePending = false;
let manualResizeTimer = null;
let programmaticResizeDepth = 0;

const MIN_WINDOW_WIDTH = 360;
const MIN_WINDOW_HEIGHT = 300;
const MINIMAL_WINDOW_HEIGHT = 52;
const DEFAULT_MINIMAL_WINDOW_HEIGHT = 56;
const DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH = 240;
const MEDIUM_MINIMAL_ACCOUNT_HEIGHT = 52;
const DEFAULT_VERTICAL_MINIMAL_WINDOW_WIDTH = 96;
const VERTICAL_MINIMAL_ACCOUNT_HEIGHT = 124;
const MINIMAL_CONTENT_CHROME_HEIGHT = 46;
const MINIMAL_HORIZONTAL_ACCOUNT_WIDTH = 202;
const MINIMAL_HORIZONTAL_CHROME_WIDTH = 63;
const WINDOW_MODE_SCHEMA_VERSION = 5;
const MAX_STORED_WINDOW_SIZE = 16384;
const MANUAL_RESIZE_SAVE_DELAY_MS = 260;
const MIN_WIDGET_SCALE = 80;
const MAX_WIDGET_SCALE = 140;
const DEFAULT_WIDGET_SCALE = 100;
const WIDGET_SCALE_STEP = 5;
const DEFAULT_ACCOUNT_COUNT = 3;
const SETTINGS_WINDOW_WIDTH = 720;
const SETTINGS_WINDOW_HEIGHT = 800;
const SETTINGS_WINDOW_MIN_WIDTH = 600;
const SETTINGS_WINDOW_MIN_HEIGHT = 560;
const CARD_SURFACE_MODES = new Set(["separate", "unified"]);
const SETTINGS_CATEGORIES = new Set([
  "general",
  "dashboard",
  "accounts",
  "appearance",
]);
const MINIMAL_ORIENTATIONS = new Set([
  "horizontal",
  "medium",
  "vertical",
]);
const WINDOW_LAYOUTS = new Set([
  "vertical",
  "horizontal",
  "grid-2x2",
  "grid-3x3",
]);

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function getIconPath() {
  return path.join(__dirname, "..", "assets", "tokencat-icon.png");
}

function getWindowModePath() {
  return path.join(app.getPath("userData"), "window-mode.json");
}

function getUiPreferencesPath() {
  return path.join(app.getPath("userData"), "ui-preferences.json");
}

function normalizeLanguage(language) {
  return language === "en" ? "en" : "ko";
}

function normalizeSettingsCategory(category) {
  return SETTINGS_CATEGORIES.has(category) ? category : "general";
}

function getAppWindows() {
  return [mainWindow, settingsWindow].filter(
    (window) => window && !window.isDestroyed(),
  );
}

function broadcastToAppWindows(channel, ...args) {
  for (const window of getAppWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  }
}

function isTrustedAppWindowSender(event) {
  try {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    return getAppWindows().includes(sourceWindow);
  } catch {
    return false;
  }
}

function readUiPreferences() {
  try {
    const stored = JSON.parse(
      fs.readFileSync(getUiPreferencesPath(), "utf8"),
    );
    return { language: normalizeLanguage(stored.language) };
  } catch {
    return { language: "ko" };
  }
}

function saveUiPreferences() {
  try {
    fs.mkdirSync(path.dirname(getUiPreferencesPath()), { recursive: true });
    fs.writeFileSync(
      getUiPreferencesPath(),
      JSON.stringify({ language: appLanguage }),
      "utf8",
    );
  } catch {
    // Renderer localStorage remains the source of truth for the visible UI.
  }
}

function mainText(korean, english) {
  return appLanguage === "en" ? english : korean;
}

function normalizeWidgetScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WIDGET_SCALE;
  const snapped =
    Math.round(numeric / WIDGET_SCALE_STEP) * WIDGET_SCALE_STEP;
  return Math.min(MAX_WIDGET_SCALE, Math.max(MIN_WIDGET_SCALE, snapped));
}

function normalizeWindowLayout(value) {
  return WINDOW_LAYOUTS.has(value) ? value : "vertical";
}

function normalizeMinimalOrientation(value) {
  return MINIMAL_ORIENTATIONS.has(value) ? value : "horizontal";
}

function isGridWindowLayout(value) {
  return value === "grid-2x2" || value === "grid-3x3";
}

function getGridColumnCount(layout, viewportWidth = Number.POSITIVE_INFINITY) {
  if (layout === "grid-2x2") {
    return viewportWidth <= 650 ? 1 : 2;
  }
  if (layout === "grid-3x3") {
    if (viewportWidth <= 650) return 1;
    return viewportWidth <= 900 ? 2 : 3;
  }
  return 1;
}

function getGridRowCount(layout, accountCount, viewportWidth) {
  const columns = getGridColumnCount(layout, viewportWidth);
  return Math.max(1, Math.ceil(accountCount / columns));
}

function getSteppedGridHeight(rows, firstRow, secondRow, extraRow) {
  if (rows <= 1) return firstRow;
  return secondRow + Math.max(0, rows - 2) * extraRow;
}

function normalizeAccountCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ACCOUNT_COUNT;
  return Math.min(99, Math.max(1, Math.round(numeric)));
}

function normalizeCardSurfaceMode(value) {
  return CARD_SURFACE_MODES.has(value) ? value : "separate";
}

function normalizeStoredWindowSize(value) {
  if (!value || typeof value !== "object") return null;
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    width: Math.min(MAX_STORED_WINDOW_SIZE, width),
    height: Math.min(MAX_STORED_WINDOW_SIZE, height),
  };
}

function normalizeSavedWindowSizes(value) {
  if (!value || typeof value !== "object") return {};
  const normalized = {};
  for (const layout of WINDOW_LAYOUTS) {
    const size = normalizeStoredWindowSize(value[layout]);
    if (size) normalized[layout] = size;
  }
  return normalized;
}

function normalizeMinimalWindowSize(value, orientation = "horizontal") {
  const normalized = normalizeStoredWindowSize(value);
  if (!normalized) return null;
  const normalizedOrientation = normalizeMinimalOrientation(orientation);
  if (normalizedOrientation === "medium") {
    return {
      width: DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH,
      height: normalized.height,
    };
  }
  if (normalizedOrientation === "vertical") {
    return {
      width: DEFAULT_VERTICAL_MINIMAL_WINDOW_WIDTH,
      height: normalized.height,
    };
  }
  return {
    width: normalized.width,
    height: DEFAULT_MINIMAL_WINDOW_HEIGHT,
  };
}

function normalizeMinimalWindowSizes(value, legacyHorizontalSize = null) {
  const source = value && typeof value === "object" ? value : {};
  const horizontal = normalizeMinimalWindowSize(
    source.horizontal ?? legacyHorizontalSize,
    "horizontal",
  );
  const medium = normalizeMinimalWindowSize(source.medium, "medium");
  const vertical = normalizeMinimalWindowSize(source.vertical, "vertical");
  return {
    ...(horizontal ? { horizontal } : {}),
    ...(medium ? { medium } : {}),
    ...(vertical ? { vertical } : {}),
  };
}

function migrateLegacyMinimalWindowMode(stored) {
  if (
    Number(stored.schemaVersion) >= WINDOW_MODE_SCHEMA_VERSION
  ) {
    return {
      minimalOrientation: stored.minimalOrientation,
      minimalSizes: stored.minimalSizes,
    };
  }

  const source =
    stored.minimalSizes && typeof stored.minimalSizes === "object"
      ? stored.minimalSizes
      : {};
  const { vertical: legacyVerticalSize, ...remainingSizes } = source;
  return {
    minimalOrientation:
      stored.minimalOrientation === "vertical"
        ? "medium"
        : stored.minimalOrientation,
    minimalSizes: {
      ...remainingSizes,
      ...(legacyVerticalSize
        ? { medium: legacyVerticalSize }
        : {}),
    },
  };
}

function normalizeWindowMode(
  layout,
  compact,
  quotaOnly = false,
  widgetScale = DEFAULT_WIDGET_SCALE,
  accountCount = DEFAULT_ACCOUNT_COUNT,
  cardSurfaceMode = "separate",
  sizeLocked = false,
  savedSizes = {},
  minimal = false,
  minimalOrientation = "horizontal",
  minimalSizes = {},
  legacyMinimalSize = null,
) {
  return {
    schemaVersion: WINDOW_MODE_SCHEMA_VERSION,
    layout: normalizeWindowLayout(layout),
    compact: Boolean(compact),
    minimal: Boolean(minimal),
    minimalOrientation: normalizeMinimalOrientation(minimalOrientation),
    quotaOnly: Boolean(quotaOnly),
    widgetScale: normalizeWidgetScale(widgetScale),
    accountCount: normalizeAccountCount(accountCount),
    cardSurfaceMode: normalizeCardSurfaceMode(cardSurfaceMode),
    sizeLocked: Boolean(sizeLocked),
    savedSizes: normalizeSavedWindowSizes(savedSizes),
    minimalSizes: normalizeMinimalWindowSizes(
      minimalSizes,
      legacyMinimalSize,
    ),
  };
}

function readWindowMode() {
  try {
    const stored = JSON.parse(fs.readFileSync(getWindowModePath(), "utf8"));
    const migratedMinimal = migrateLegacyMinimalWindowMode(stored);
    return normalizeWindowMode(
      stored.layout,
      stored.compact,
      stored.quotaOnly,
      stored.widgetScale,
      stored.accountCount,
      stored.cardSurfaceMode,
      stored.sizeLocked,
      stored.savedSizes,
      stored.minimal,
      migratedMinimal.minimalOrientation,
      migratedMinimal.minimalSizes,
      stored.schemaVersion === WINDOW_MODE_SCHEMA_VERSION
        ? null
        : stored.minimalSize,
    );
  } catch {
    return normalizeWindowMode("vertical", false);
  }
}

function saveWindowMode(mode) {
  try {
    fs.mkdirSync(path.dirname(getWindowModePath()), { recursive: true });
    fs.writeFileSync(getWindowModePath(), JSON.stringify(mode), "utf8");
  } catch {
    // The renderer still keeps the same preference in localStorage.
  }
}

function getWindowPreset(mode, workArea) {
  const scale = normalizeWidgetScale(mode.widgetScale) / 100;
  if (mode.minimal) {
    const orientation = normalizeMinimalOrientation(mode.minimalOrientation);
    if (orientation === "medium") {
      const availableWidth = Math.max(1, workArea.width - 16);
      const width = Math.min(
        availableWidth,
        DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH,
      );
      const requestedHeight =
        normalizeAccountCount(mode.accountCount) *
          MEDIUM_MINIMAL_ACCOUNT_HEIGHT +
        MINIMAL_CONTENT_CHROME_HEIGHT;
      const height = Math.min(
        workArea.height,
        Math.max(DEFAULT_MINIMAL_WINDOW_HEIGHT, requestedHeight),
      );
      return {
        width,
        height,
        minWidth: width,
        minHeight: height,
      };
    }
    if (orientation === "vertical") {
      const availableWidth = Math.max(1, workArea.width - 16);
      const width = Math.min(
        availableWidth,
        DEFAULT_VERTICAL_MINIMAL_WINDOW_WIDTH,
      );
      const requestedHeight =
        normalizeAccountCount(mode.accountCount) *
          VERTICAL_MINIMAL_ACCOUNT_HEIGHT +
        MINIMAL_CONTENT_CHROME_HEIGHT;
      const height = Math.min(
        workArea.height,
        Math.max(DEFAULT_MINIMAL_WINDOW_HEIGHT, requestedHeight),
      );
      return {
        width,
        height,
        minWidth: width,
        minHeight: height,
      };
    }

    const availableWidth = Math.max(1, workArea.width - 16);
    const minimumWidth = Math.min(MIN_WINDOW_WIDTH, availableWidth);
    const minimumHeight = Math.min(
      MINIMAL_WINDOW_HEIGHT,
      workArea.height,
    );
    const height = Math.min(
      workArea.height,
      Math.max(minimumHeight, DEFAULT_MINIMAL_WINDOW_HEIGHT),
    );
    const contentWidth =
      normalizeAccountCount(mode.accountCount) *
        MINIMAL_HORIZONTAL_ACCOUNT_WIDTH +
      MINIMAL_HORIZONTAL_CHROME_WIDTH;
    const width = Math.min(
      availableWidth,
      Math.max(minimumWidth, contentWidth),
    );
    return {
      width,
      height,
      minWidth: minimumWidth,
      minHeight: minimumHeight,
    };
  }

  const baseWidth =
    mode.layout === "horizontal"
      ? mode.compact
        ? 1374
        : 920
      : mode.layout === "grid-3x3"
        ? 1374
        : mode.layout === "grid-2x2"
        ? 920
        : mode.compact
          ? 420
          : 480;
  const scaledWidth = Math.round(baseWidth * scale);

  const availableWidth =
    (mode.layout === "horizontal" && mode.compact) ||
    mode.layout === "grid-2x2" ||
    mode.layout === "grid-3x3"
      ? Math.max(1, workArea.width - 16)
      : workArea.width;
  const minimumWidth = Math.min(MIN_WINDOW_WIDTH, availableWidth);
  const minimumHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height);
  const width = Math.min(
    availableWidth,
    Math.max(minimumWidth, scaledWidth),
  );
  const gridRows = getGridRowCount(
    mode.layout,
    mode.accountCount,
    width,
  );
  let baseHeight;
  if (mode.layout === "horizontal") {
    baseHeight = mode.compact
      ? mode.quotaOnly
        ? 300
        : 388
      : mode.quotaOnly
        ? 350
        : 420;
  } else if (mode.layout === "grid-2x2") {
    baseHeight = mode.compact
      ? mode.quotaOnly
        ? getSteppedGridHeight(gridRows, 300, 390, 130)
        : getSteppedGridHeight(gridRows, 300, 620, 220)
      : mode.quotaOnly
        ? getSteppedGridHeight(gridRows, 350, 500, 150)
        : getSteppedGridHeight(gridRows, 460, 720, 220);
  } else if (mode.layout === "grid-3x3") {
    baseHeight = mode.compact
      ? mode.quotaOnly
        ? getSteppedGridHeight(gridRows, 300, 390, 130)
        : getSteppedGridHeight(gridRows, 300, 520, 260)
      : mode.quotaOnly
        ? getSteppedGridHeight(gridRows, 350, 500, 150)
        : getSteppedGridHeight(gridRows, 460, 680, 220);
  } else {
    baseHeight = mode.compact
      ? mode.quotaOnly
        ? 520
        : 600
      : mode.quotaOnly
        ? 640
        : 720;
  }
  const scaledHeight = Math.round(baseHeight * scale);
  const height = Math.min(
    workArea.height,
    Math.max(minimumHeight, scaledHeight),
  );

  return {
    width,
    height,
    minWidth: minimumWidth,
    minHeight: minimumHeight,
  };
}

function clampWindowSizeToWorkArea(size, workArea, mode = windowMode) {
  const preset = getWindowPreset(mode, workArea);
  const minimumWidth = preset.minWidth;
  const minimumHeight = preset.minHeight;
  return {
    width: Math.min(
      workArea.width,
      Math.max(minimumWidth, Math.round(size.width)),
    ),
    height: Math.min(
      workArea.height,
      Math.max(minimumHeight, Math.round(size.height)),
    ),
  };
}

function getSavedWindowSize(mode, workArea) {
  const stored = normalizeStoredWindowSize(mode.savedSizes?.[mode.layout]);
  return stored
    ? clampWindowSizeToWorkArea(stored, workArea, mode)
    : null;
}

function getMinimalWindowSize(mode, workArea) {
  const orientation = normalizeMinimalOrientation(mode.minimalOrientation);
  const stored = normalizeMinimalWindowSize(
    mode.minimalSizes?.[orientation],
    orientation,
  );
  return stored
    ? clampWindowSizeToWorkArea(stored, workArea, {
        ...mode,
        minimal: true,
        minimalOrientation: orientation,
      })
    : null;
}

function getActiveSavedWindowSize(mode, workArea) {
  return mode.minimal
    ? getMinimalWindowSize(mode, workArea)
    : getSavedWindowSize(mode, workArea);
}

function clearManualResizeTracking() {
  manualResizePending = false;
  if (manualResizeTimer !== null) {
    clearTimeout(manualResizeTimer);
    manualResizeTimer = null;
  }
}

function setBoundsProgrammatically(bounds, animate = true) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearManualResizeTracking();
  programmaticResizeDepth += 1;
  try {
    mainWindow.setBounds(bounds, animate);
  } finally {
    setImmediate(() => {
      programmaticResizeDepth = Math.max(0, programmaticResizeDepth - 1);
    });
  }
}

function setSavedWindowSize(layout, size) {
  const normalizedLayout = normalizeWindowLayout(layout);
  const normalizedSize = normalizeStoredWindowSize(size);
  if (!normalizedSize) return null;
  windowMode = {
    ...windowMode,
    savedSizes: {
      ...windowMode.savedSizes,
      [normalizedLayout]: normalizedSize,
    },
  };
  saveWindowMode(windowMode);
  return normalizedSize;
}

function setMinimalWindowSize(
  size,
  orientation = windowMode.minimalOrientation,
) {
  const normalizedOrientation = normalizeMinimalOrientation(orientation);
  const normalizedSize = normalizeMinimalWindowSize(
    size,
    normalizedOrientation,
  );
  if (!normalizedSize) return null;
  windowMode = {
    ...windowMode,
    minimalSizes: {
      ...windowMode.minimalSizes,
      [normalizedOrientation]: normalizedSize,
    },
  };
  saveWindowMode(windowMode);
  return normalizedSize;
}

function captureCurrentWindowSize(mode = windowMode) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return null;
  const bounds = mainWindow.isMaximized()
    ? mainWindow.getNormalBounds()
    : mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const normalizedBounds = clampWindowSizeToWorkArea(
    bounds,
    workArea,
    mode,
  );
  return mode.minimal
    ? setMinimalWindowSize(normalizedBounds, mode.minimalOrientation)
    : setSavedWindowSize(mode.layout, normalizedBounds);
}

function scheduleManualWindowSizeSave() {
  if (
    !manualResizePending ||
    programmaticResizeDepth > 0 ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }
  if (manualResizeTimer !== null) clearTimeout(manualResizeTimer);
  manualResizeTimer = setTimeout(() => {
    manualResizeTimer = null;
    if (!manualResizePending || programmaticResizeDepth > 0) return;
    manualResizePending = false;
    if (
      !windowMode.sizeLocked &&
      !mainWindow?.isMinimized() &&
      !mainWindow?.isMaximized() &&
      !mainWindow?.isFullScreen()
    ) {
        if (captureCurrentWindowSize()) notifyWindowSizeState("manual");
    }
  }, MANUAL_RESIZE_SAVE_DELAY_MS);
}

function getWindowSizeState(changeSource = "programmatic") {
  const presetWorkArea = screen.getPrimaryDisplay().workArea;
  const bounds =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : getWindowPreset(windowMode, presetWorkArea);
  const { workArea } =
    mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(bounds)
      : { workArea: presetWorkArea };
  const savedWindowSize = getActiveSavedWindowSize(windowMode, workArea);
  return {
    changeSource,
    sizeLocked: windowMode.sizeLocked,
    currentWindowSize: {
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    },
    savedWindowSize,
    hasSavedWindowSize: Boolean(savedWindowSize),
  };
}

function notifyWindowSizeState(changeSource = "programmatic") {
  broadcastToAppWindows(
    "window:size-state-changed",
    getWindowSizeState(changeSource),
  );
}

function getCenteredWindowBounds(
  size,
  currentBounds,
  workArea,
  mode = windowMode,
) {
  const clampedSize = clampWindowSizeToWorkArea(size, workArea, mode);
  const centerX = currentBounds.x + currentBounds.width / 2;
  const centerY = currentBounds.y + currentBounds.height / 2;
  const maxX = workArea.x + workArea.width - clampedSize.width;
  const maxY = workArea.y + workArea.height - clampedSize.height;
  return {
    x: Math.max(
      workArea.x,
      Math.min(Math.round(centerX - clampedSize.width / 2), maxX),
    ),
    y: Math.max(
      workArea.y,
      Math.min(Math.round(centerY - clampedSize.height / 2), maxY),
    ),
    width: clampedSize.width,
    height: clampedSize.height,
  };
}

function applyWindowConstraints(mode, workArea) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const preset = getWindowPreset(mode, workArea);
  if (mode.minimal) {
    // Clear the previous profile first. Otherwise changing between a short,
    // wide strip and a tall, narrow strip can momentarily request a minimum
    // that exceeds the previous profile's maximum.
    mainWindow.setMinimumSize(1, 1);
    mainWindow.setMaximumSize(
      MAX_STORED_WINDOW_SIZE,
      MAX_STORED_WINDOW_SIZE,
    );
    mainWindow.setMinimumSize(preset.minWidth, preset.minHeight);
    mainWindow.setMaximumSize(workArea.width, workArea.height);
    mainWindow.setResizable(!mode.sizeLocked);
    mainWindow.setMaximizable(false);
    return;
  }

  mainWindow.setMaximumSize(
    MAX_STORED_WINDOW_SIZE,
    MAX_STORED_WINDOW_SIZE,
  );
  mainWindow.setMinimumSize(preset.minWidth, preset.minHeight);
  mainWindow.setResizable(!mode.sizeLocked);
  mainWindow.setMaximizable(!mode.sizeLocked);
}

function applyWindowMode(
  layout,
  compact,
  quotaOnly,
  widgetScale,
  accountCount,
  cardSurfaceMode,
  minimal,
  minimalOrientation,
  transitionSource = "manual",
) {
  if (!mainWindow) return;

  const nextMinimal = Boolean(minimal);
  const nextMinimalOrientation = normalizeMinimalOrientation(
    minimalOrientation ?? windowMode.minimalOrientation,
  );
  const minimalChanged = nextMinimal !== windowMode.minimal;
  const minimalOrientationChanged =
    nextMinimalOrientation !== windowMode.minimalOrientation;
  const activeMinimalProfileChanged =
    windowMode.minimal && nextMinimal && minimalOrientationChanged;
  const resizeDrivenProfileChange =
    transitionSource === "auto-resize" &&
    (minimalChanged || activeMinimalProfileChanged);
  if (minimalChanged || activeMinimalProfileChanged) {
    clearManualResizeTracking();
    if (!resizeDrivenProfileChange) {
      captureCurrentWindowSize(windowMode);
    }
  }

  const nextMode = normalizeWindowMode(
    layout,
    compact,
    quotaOnly,
    widgetScale,
    accountCount,
    cardSurfaceMode,
    windowMode.sizeLocked,
    windowMode.savedSizes,
    nextMinimal,
    nextMinimalOrientation,
    windowMode.minimalSizes,
  );
  const currentBounds = mainWindow.getBounds();
  const resizeReferenceBounds = mainWindow.isMaximized()
    ? mainWindow.getNormalBounds()
    : currentBounds;
  const { workArea } = screen.getDisplayMatching(currentBounds);
  const currentPreset = getWindowPreset(windowMode, workArea);
  const nextPreset = getWindowPreset(nextMode, workArea);
  const adaptivePresetChanged =
    nextMode.layout === windowMode.layout &&
    nextMode.minimal === windowMode.minimal &&
    nextMode.minimalOrientation === windowMode.minimalOrientation &&
    (nextMode.minimal || isGridWindowLayout(nextMode.layout)) &&
    (nextPreset.width !== currentPreset.width ||
      nextPreset.height !== currentPreset.height);
  const modeChanged =
    nextMode.layout !== windowMode.layout ||
    nextMode.compact !== windowMode.compact ||
    minimalChanged ||
    minimalOrientationChanged ||
    nextMode.quotaOnly !== windowMode.quotaOnly ||
    nextMode.widgetScale !== windowMode.widgetScale ||
    adaptivePresetChanged;
  const layoutChanged = nextMode.layout !== windowMode.layout;
  const sizeProfileChanged =
    minimalChanged ||
    (nextMode.minimal && minimalOrientationChanged) ||
    (!nextMode.minimal && layoutChanged);
  const widgetScaleChanged =
    nextMode.widgetScale !== windowMode.widgetScale;
  if (!modeChanged) {
    if (
      nextMode.accountCount !== windowMode.accountCount ||
      nextMode.cardSurfaceMode !== windowMode.cardSurfaceMode
    ) {
      windowMode = nextMode;
      saveWindowMode(windowMode);
    }
    return;
  }

  let targetSize = null;
  if (sizeProfileChanged) {
    targetSize = resizeDrivenProfileChange
      ? clampWindowSizeToWorkArea(
          resizeReferenceBounds,
          workArea,
          nextMode,
        )
      : getActiveSavedWindowSize(nextMode, workArea) ?? nextPreset;
  } else if (
    adaptivePresetChanged &&
    nextMode.minimal &&
    nextMode.minimalOrientation !== "horizontal"
  ) {
    // Account-count changes can raise the content minimum without discarding
    // a larger size the user is currently dragging through.
    targetSize = clampWindowSizeToWorkArea(
      resizeReferenceBounds,
      workArea,
      nextMode,
    );
  } else if (widgetScaleChanged && !nextMode.minimal) {
    const scaleRatio =
      nextMode.widgetScale / Math.max(MIN_WIDGET_SCALE, windowMode.widgetScale);
    targetSize = clampWindowSizeToWorkArea(
      {
        width: Math.round(resizeReferenceBounds.width * scaleRatio),
        height: Math.round(resizeReferenceBounds.height * scaleRatio),
      },
      workArea,
      nextMode,
    );
    nextMode.savedSizes = {
      ...nextMode.savedSizes,
      [nextMode.layout]: targetSize,
    };
  } else if (
    !nextMode.sizeLocked &&
    !getActiveSavedWindowSize(nextMode, workArea)
  ) {
    targetSize = nextPreset;
  }

  if (targetSize && mainWindow.isMaximized()) mainWindow.unmaximize();
  applyWindowConstraints(nextMode, workArea);
  if (targetSize) {
    setBoundsProgrammatically(
      getCenteredWindowBounds(
        targetSize,
        currentBounds,
        workArea,
        nextMode,
      ),
      true,
    );
  }
  windowMode = nextMode;
  saveWindowMode(windowMode);
  notifyWindowSizeState();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openSettings(category = "general") {
  const normalizedCategory = normalizeSettingsCategory(category);
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow(normalizedCategory);
    return;
  }

  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.focus();
  const sendCategory = () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    settingsWindow.webContents.send("app:open-settings", normalizedCategory);
  };
  if (settingsWindow.webContents.isLoadingMainFrame()) {
    settingsWindow.webContents.once("did-finish-load", sendCategory);
  } else {
    sendCategory();
  }
}

function openSafeIntegrationLoginUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      !(
        host === "chatgpt.com" ||
        host.endsWith(".chatgpt.com") ||
        host === "openai.com" ||
        host.endsWith(".openai.com")
      )
    ) {
      throw new Error("UNSAFE_LOGIN_URL");
    }
    return shell.openExternal(parsed.toString());
  } catch {
    return Promise.reject(new Error("UNSAFE_LOGIN_URL"));
  }
}

function getSafeDevServerUrl() {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return null;
  try {
    const parsed = new URL(process.env.VITE_DEV_SERVER_URL);
    const isLoopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]";
    if (parsed.protocol !== "http:" || !isLoopback) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function loadRendererWindow(targetWindow, query = {}) {
  const devServerUrl = getSafeDevServerUrl();
  const rendererFilePath = path.join(__dirname, "..", "dist", "index.html");
  const rendererFileUrl = pathToFileURL(rendererFilePath);

  if (devServerUrl) {
    const targetUrl = new URL(devServerUrl);
    for (const [key, value] of Object.entries(query)) {
      targetUrl.searchParams.set(key, String(value));
    }
    targetWindow.loadURL(targetUrl.toString());
  } else {
    targetWindow.loadFile(rendererFilePath, { query });
  }

  const allowedDevOrigin = devServerUrl
    ? new URL(devServerUrl).origin
    : null;
  targetWindow.webContents.on("will-navigate", (event, url) => {
    let allowed = false;
    try {
      const target = new URL(url);
      allowed = allowedDevOrigin
        ? target.origin === allowedDevOrigin
        : target.protocol === "file:" &&
          target.pathname === rendererFileUrl.pathname;
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
  });

  targetWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
}

function createSettingsWindow(category = "general") {
  const normalizedCategory = normalizeSettingsCategory(category);
  const referenceBounds =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const { workArea } = referenceBounds
    ? screen.getDisplayMatching(referenceBounds)
    : screen.getPrimaryDisplay();
  const availableWidth = Math.max(1, workArea.width - 32);
  const availableHeight = Math.max(1, workArea.height - 32);
  const width = Math.min(SETTINGS_WINDOW_WIDTH, availableWidth);
  const height = Math.min(SETTINGS_WINDOW_HEIGHT, availableHeight);
  const createdWindow = new BrowserWindow({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(SETTINGS_WINDOW_MIN_WIDTH, width),
    minHeight: Math.min(SETTINGS_WINDOW_MIN_HEIGHT, height),
    backgroundColor: "#f5f5f4",
    title: mainText("TokenCat 설정", "TokenCat Settings"),
    show: false,
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow = createdWindow;
  createdWindow.setMenu(null);
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop()) {
    createdWindow.setAlwaysOnTop(true, "floating");
  }
  loadRendererWindow(createdWindow, {
    window: "settings",
    category: normalizedCategory,
  });

  createdWindow.once("ready-to-show", () => {
    if (createdWindow.isDestroyed()) return;
    createdWindow.show();
    createdWindow.focus();
  });
  createdWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    createdWindow.hide();
  });
  createdWindow.on("closed", () => {
    if (settingsWindow === createdWindow) settingsWindow = null;
  });
}

function createTrayUpdateItems() {
  if (!updateService) return [];
  const state = updateService.getState();
  if (state.status === "ready") {
    const koreanLabel = state.availableVersion
      ? `v${state.availableVersion} 업데이트를 위해 재시작`
      : "업데이트를 위해 재시작";
    const englishLabel = state.availableVersion
      ? `Restart to update to v${state.availableVersion}`
      : "Restart to update";
    return [
      {
        label: mainText(koreanLabel, englishLabel),
        click: () => updateService?.installUpdate(),
      },
    ];
  }

  if (state.distribution === "portable") {
    return [
      {
        label: mainText(
          "자동 업데이트 설치형 다운로드...",
          "Download auto-updating installer...",
        ),
        click: () => void updateService?.openUpdateDownloadPage(),
      },
    ];
  }
  if (!state.supported) return [];

  const busy = new Set([
    "checking",
    "available",
    "downloading",
  ]).has(state.status);
  let label = mainText("업데이트 확인", "Check for updates");
  if (state.status === "checking") {
    label = mainText(
      "업데이트 확인 중...",
      "Checking for updates...",
    );
  } else if (state.status === "available") {
    label = mainText(
      "업데이트 다운로드 준비 중...",
      "Preparing update download...",
    );
  } else if (state.status === "downloading") {
    const progress =
      state.progressPercent === null
        ? ""
        : ` ${state.progressPercent}%`;
    label = mainText(
      `업데이트 다운로드 중...${progress}`,
      `Downloading update...${progress}`,
    );
  } else if (state.status === "error") {
    label = mainText(
      "업데이트 다시 확인",
      "Check for updates again",
    );
  }

  return [
    {
      label,
      enabled: !busy,
      click: () => void updateService?.checkForUpdates(),
    },
  ];
}

function createTrayMenu() {
  if (!tray || !mainWindow) return;
  const updateItems = createTrayUpdateItems();

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: mainText("TokenCat 열기", "Open TokenCat"),
        click: showWindow,
      },
      {
        label: mainText("설정...", "Settings..."),
        click: () => openSettings(),
      },
      ...(updateItems.length > 0
        ? [{ type: "separator" }, ...updateItems]
        : []),
      { type: "separator" },
      {
        label: mainText("항상 위에 표시", "Always on top"),
        type: "checkbox",
        checked: mainWindow.isAlwaysOnTop(),
        click: (item) => {
          mainWindow?.setAlwaysOnTop(item.checked, "floating");
          createTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: mainText("종료", "Quit"),
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath()).resize({
    width: 20,
    height: 20,
  });

  tray = new Tray(icon);
  tray.setToolTip(
    mainText("TokenCat · AI 사용량 위젯", "TokenCat · AI usage widget"),
  );
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  createTrayMenu();
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const preset = getWindowPreset(windowMode, workArea);
  const restoredSize =
    getActiveSavedWindowSize(windowMode, workArea) ?? {
      width: preset.width,
      height: preset.height,
    };

  mainWindow = new BrowserWindow({
    width: restoredSize.width,
    height: restoredSize.height,
    minWidth: preset.minWidth,
    minHeight: preset.minHeight,
    ...(windowMode.minimal
      ? {
          maxWidth: workArea.width,
          maxHeight: workArea.height,
        }
      : {}),
    resizable: !windowMode.sizeLocked,
    maximizable: !windowMode.sizeLocked && !windowMode.minimal,
    backgroundColor: "#f5f5f4",
    title: "TokenCat",
    frame: false,
    show: false,
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenu(null);

  loadRendererWindow(mainWindow);

  mainWindow.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) {
      mainWindow?.show();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("always-on-top-changed", () => {
    const alwaysOnTop = mainWindow?.isAlwaysOnTop() ?? false;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setAlwaysOnTop(alwaysOnTop, "floating");
    }
    createTrayMenu();
    broadcastToAppWindows("window:pin-changed", alwaysOnTop);
  });

  mainWindow.on("maximize", () => {
    broadcastToAppWindows("window:maximized-changed", true);
  });

  mainWindow.on("unmaximize", () => {
    broadcastToAppWindows("window:maximized-changed", false);
  });

  mainWindow.on("will-resize", (event) => {
    if (windowMode.sizeLocked) {
      event.preventDefault();
      return;
    }
    if (programmaticResizeDepth === 0) {
      manualResizePending = true;
    }
  });

  mainWindow.on("resize", scheduleManualWindowSizeSave);
  mainWindow.on("resized", scheduleManualWindowSizeSave);
}

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:hide", () => mainWindow?.hide());

ipcMain.handle("app:open-settings-window", (_event, category) => {
  openSettings(category);
  return true;
});

ipcMain.handle("app:close-settings-window", (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (
    !settingsWindow ||
    settingsWindow.isDestroyed() ||
    sourceWindow !== settingsWindow
  ) {
    return false;
  }
  settingsWindow.hide();
  return true;
});

ipcMain.handle("window:toggle-pin", () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next, "floating");
  createTrayMenu();
  return next;
});

ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return false;
  if (windowMode.sizeLocked || windowMode.minimal) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    return false;
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});

ipcMain.handle(
  "window:set-layout",
  (
    event,
    layout,
    compact,
    quotaOnly,
    widgetScale,
    accountCount,
    cardSurfaceMode,
    minimal,
    minimalOrientation,
    transitionSource,
  ) => {
    if (
      settingsWindow &&
      !settingsWindow.isDestroyed() &&
      BrowserWindow.fromWebContents(event.sender) === settingsWindow
    ) {
      return;
    }
    applyWindowMode(
      layout,
      compact,
      quotaOnly,
      widgetScale,
      accountCount,
      cardSurfaceMode,
      minimal,
      minimalOrientation,
      transitionSource,
    );
  },
);

ipcMain.handle(
  "settings:apply-window-layout",
  (
    event,
    layout,
    compact,
    quotaOnly,
    widgetScale,
    cardSurfaceMode,
    minimal,
    minimalOrientation,
  ) => {
    if (
      !settingsWindow ||
      settingsWindow.isDestroyed() ||
      BrowserWindow.fromWebContents(event.sender) !== settingsWindow
    ) {
      return false;
    }
    applyWindowMode(
      layout,
      compact,
      quotaOnly,
      widgetScale,
      windowMode.accountCount,
      cardSurfaceMode,
      minimal,
      minimalOrientation,
      "manual",
    );
    return true;
  },
);

ipcMain.handle("window:set-size-locked", (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return getWindowSizeState();
  const nextLocked = Boolean(enabled);
  if (nextLocked === windowMode.sizeLocked) return getWindowSizeState();

  clearManualResizeTracking();
  if (nextLocked) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    captureCurrentWindowSize();
  }
  windowMode = { ...windowMode, sizeLocked: nextLocked };
  const currentBounds = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(currentBounds);
  applyWindowConstraints(windowMode, workArea);
  saveWindowMode(windowMode);
  const state = getWindowSizeState();
  notifyWindowSizeState();
  return state;
});

ipcMain.handle("window:save-current-size", () => {
  clearManualResizeTracking();
  captureCurrentWindowSize();
  const state = getWindowSizeState();
  notifyWindowSizeState();
  return state;
});

ipcMain.handle("window:reset-saved-size", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return getWindowSizeState();
  const currentBounds = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(currentBounds);
  const preset = getWindowPreset(windowMode, workArea);
  if (windowMode.minimal) {
    const minimalSizes = { ...windowMode.minimalSizes };
    delete minimalSizes[windowMode.minimalOrientation];
    windowMode = { ...windowMode, minimalSizes };
  } else {
    const savedSizes = { ...windowMode.savedSizes };
    delete savedSizes[windowMode.layout];
    windowMode = { ...windowMode, savedSizes };
  }
  saveWindowMode(windowMode);

  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  applyWindowConstraints(windowMode, workArea);
  setBoundsProgrammatically(
    getCenteredWindowBounds(
      preset,
      currentBounds,
      workArea,
      windowMode,
    ),
    true,
  );
  const state = getWindowSizeState();
  notifyWindowSizeState();
  return state;
});

ipcMain.handle("app:get-settings", () => ({
  alwaysOnTop: mainWindow?.isAlwaysOnTop() ?? false,
  maximized: mainWindow?.isMaximized() ?? false,
  openAtLogin: app.getLoginItemSettings().openAtLogin,
  version: app.getVersion(),
  packaged: app.isPackaged,
  layout: windowMode.layout,
  compact: windowMode.compact,
  minimal: windowMode.minimal,
  minimalOrientation: windowMode.minimalOrientation,
  quotaOnly: windowMode.quotaOnly,
  widgetScale: windowMode.widgetScale,
  cardSurfaceMode: windowMode.cardSurfaceMode,
  ...getWindowSizeState("initial"),
  language: appLanguage,
}));

ipcMain.handle("app:set-language", (_event, language) => {
  appLanguage = normalizeLanguage(language);
  saveUiPreferences();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.setTitle(
      mainText("TokenCat 설정", "TokenCat Settings"),
    );
  }
  if (tray) {
    tray.setToolTip(
      mainText("TokenCat · AI 사용량 위젯", "TokenCat · AI usage widget"),
    );
    createTrayMenu();
  }
  return appLanguage;
});

ipcMain.handle("app:set-open-at-login", (_event, enabled) => {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ["--hidden"],
  });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on("app:quit", () => {
  isQuitting = true;
  app.quit();
});

app.whenReady().then(() => {
  windowMode = readWindowMode();
  saveWindowMode(windowMode);
  appLanguage = readUiPreferences().language;
  integrationService = registerIntegrationIpc(
    app,
    ipcMain,
    (snapshot) => {
      broadcastToAppWindows("integrations:snapshot-changed", snapshot);
    },
    openSafeIntegrationLoginUrl,
  );
  updateService = new UpdateService({
    app,
    onStateChanged: (state) => {
      broadcastToAppWindows("updates:state-changed", state);
      createTrayMenu();
    },
    beforeInstall: () => {
      // Both BrowserWindows normally turn close into hide. Mark the app as
      // quitting before electron-updater closes them so installation can run.
      isQuitting = true;
    },
    afterInstallFailure: () => {
      // quitAndInstall can fail synchronously. Keep the running app usable so
      // its windows can still be shown and integration polling can continue.
      isQuitting = false;
    },
    openExternal: (url) => shell.openExternal(url),
  });
  unregisterUpdateIpc = registerUpdateIpc(
    ipcMain,
    updateService,
    isTrustedAppWindowSender,
  );
  createWindow();
  createTray();
  updateService.start();

  app.on("activate", () => {
    if (!mainWindow) createWindow();
    showWindow();
  });
});

app.on("second-instance", showWindow);

app.on("before-quit", () => {
  isQuitting = true;
  updateService?.shutdown();
  unregisterUpdateIpc?.();
  unregisterUpdateIpc = null;
  integrationService?.shutdown();
});

app.on("window-all-closed", () => {
  // TokenCat stays available from the Windows tray.
});
