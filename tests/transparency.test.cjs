const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeTransparencyPreferences,
  resolveTransparencyEffect,
  resolveSupportedTransparencyPreferences,
  supportsBackgroundOnlyTransparency,
} = require("../electron/transparency.cjs");

test("legacy opacity preferences migrate to whole-window mode", () => {
  assert.deepEqual(
    normalizeTransparencyPreferences({ windowOpacity: 82 }),
    {
      mode: "whole-window",
      opacity: 82,
    },
  );
});

test("transparency preferences normalize mode and opacity together", () => {
  assert.deepEqual(
    normalizeTransparencyPreferences({
      transparencyMode: "background-only",
      windowOpacity: 59,
    }),
    {
      mode: "background-only",
      opacity: 60,
    },
  );
  assert.deepEqual(
    normalizeTransparencyPreferences({
      mode: "unknown",
      opacity: 140,
    }),
    {
      mode: "whole-window",
      opacity: 100,
    },
  );
});

test("whole-window mode fades the native window", () => {
  assert.deepEqual(
    resolveTransparencyEffect(
      { mode: "whole-window", opacity: 75 },
      "main",
    ),
    {
      nativeOpacity: 0.75,
      backgroundAlpha: 1,
      backgroundMaterial: "none",
      backgroundColor: "#f5f5f4",
    },
  );
});

test("background-only mode keeps foreground content fully opaque", () => {
  assert.deepEqual(
    resolveTransparencyEffect(
      { mode: "background-only", opacity: 75 },
      "main",
    ),
    {
      nativeOpacity: 1,
      backgroundAlpha: 0.75,
      backgroundMaterial: "acrylic",
      backgroundColor: "#00000000",
    },
  );
});

test("settings window always stays fully opaque", () => {
  assert.deepEqual(
    resolveTransparencyEffect(
      { mode: "background-only", opacity: 60 },
      "settings",
    ),
    {
      nativeOpacity: 1,
      backgroundAlpha: 1,
      backgroundMaterial: "none",
      backgroundColor: "#f5f5f4",
    },
  );
});

test("background-only transparency requires Windows 11 22H2", () => {
  assert.equal(
    supportsBackgroundOnlyTransparency("win32", "10.0.22620"),
    false,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency("win32", "10.0.22621"),
    true,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency(
      "win32",
      "10.0.22621.3155",
    ),
    true,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency("win32", "10.0.26100"),
    true,
  );
});

test("background-only support rejects other platforms and malformed releases", () => {
  assert.equal(
    supportsBackgroundOnlyTransparency("linux", "6.8.0"),
    false,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency("darwin", "23.5.0"),
    false,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency("win32", "10.0"),
    false,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency("win32", "10.0.preview"),
    false,
  );
  assert.equal(
    supportsBackgroundOnlyTransparency("win32", undefined),
    false,
  );
});

test("unsupported background-only mode falls back to whole-window opacity", () => {
  const requested = {
    mode: "background-only",
    opacity: 74,
  };

  assert.deepEqual(
    resolveSupportedTransparencyPreferences(
      requested,
      "win32",
      "10.0.19045",
    ),
    {
      mode: "whole-window",
      opacity: 74,
    },
  );
  assert.deepEqual(requested, {
    mode: "background-only",
    opacity: 74,
  });
});

test("supported and already whole-window preferences are preserved", () => {
  assert.deepEqual(
    resolveSupportedTransparencyPreferences(
      { mode: "background-only", opacity: 82 },
      "win32",
      "10.0.22621",
    ),
    {
      mode: "background-only",
      opacity: 82,
    },
  );
  assert.deepEqual(
    resolveSupportedTransparencyPreferences(
      { mode: "whole-window", opacity: 82 },
      "win32",
      "10.0.19045",
    ),
    {
      mode: "whole-window",
      opacity: 82,
    },
  );
});
