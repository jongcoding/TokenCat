const DEFAULT_WINDOW_OPACITY = 100;
const MIN_WINDOW_OPACITY = 60;
const MAX_WINDOW_OPACITY = 100;
const DEFAULT_TRANSPARENCY_MODE = "whole-window";
const TRANSPARENCY_MODES = new Set([
  "whole-window",
  "background-only",
]);
const WINDOWS_11_22H2_BUILD = 22621;

function normalizeWindowOpacity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_OPACITY;
  return Math.min(
    MAX_WINDOW_OPACITY,
    Math.max(MIN_WINDOW_OPACITY, Math.round(numeric)),
  );
}

function normalizeTransparencyMode(value) {
  return TRANSPARENCY_MODES.has(value)
    ? value
    : DEFAULT_TRANSPARENCY_MODE;
}

function normalizeTransparencyPreferences(value = {}) {
  return {
    mode: normalizeTransparencyMode(
      value.mode ?? value.transparencyMode,
    ),
    opacity: normalizeWindowOpacity(
      value.opacity ?? value.windowOpacity,
    ),
  };
}

function supportsBackgroundOnlyTransparency(platform, release) {
  if (platform !== "win32" || typeof release !== "string") {
    return false;
  }

  const releaseParts = release.trim().split(".");
  if (releaseParts.length < 3) return false;
  const build = Number(releaseParts[2]);
  return Number.isInteger(build) && build >= WINDOWS_11_22H2_BUILD;
}

function resolveSupportedTransparencyPreferences(
  preferences,
  platform,
  release,
) {
  const normalized = normalizeTransparencyPreferences(preferences);
  if (
    normalized.mode === "background-only" &&
    !supportsBackgroundOnlyTransparency(platform, release)
  ) {
    return {
      ...normalized,
      mode: "whole-window",
    };
  }
  return normalized;
}

function resolveTransparencyEffect(preferences, target = "main") {
  const normalized = normalizeTransparencyPreferences(preferences);
  if (target === "settings") {
    return {
      nativeOpacity: 1,
      backgroundAlpha: 1,
      backgroundMaterial: "none",
      backgroundColor: "#f5f5f4",
    };
  }

  if (normalized.mode === "background-only") {
    return {
      nativeOpacity: 1,
      backgroundAlpha: normalized.opacity / 100,
      backgroundMaterial: "acrylic",
      backgroundColor: "#00000000",
    };
  }

  return {
    nativeOpacity: normalized.opacity / 100,
    backgroundAlpha: 1,
    backgroundMaterial: "none",
    backgroundColor: "#f5f5f4",
  };
}

module.exports = {
  DEFAULT_TRANSPARENCY_MODE,
  DEFAULT_WINDOW_OPACITY,
  MAX_WINDOW_OPACITY,
  MIN_WINDOW_OPACITY,
  normalizeTransparencyMode,
  normalizeTransparencyPreferences,
  normalizeWindowOpacity,
  resolveTransparencyEffect,
  resolveSupportedTransparencyPreferences,
  supportsBackgroundOnlyTransparency,
};
