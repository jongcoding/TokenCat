const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadMinimalLayoutModule() {
  const filename = path.join(__dirname, "..", "src", "minimalLayout.ts");
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  const loadedModule = { exports: {} };
  const load = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    outputText,
  );
  load(
    loadedModule.exports,
    require,
    loadedModule,
    filename,
    path.dirname(filename),
  );
  return loadedModule.exports;
}

const {
  chooseActiveMinimalOrientationForSize,
  chooseMinimalOrientationForSize,
  shouldExitMinimalForSize,
  VERTICAL_MINIMAL_ENTER_WIDTH,
} = loadMinimalLayoutModule();
const {
  getMediumMinimalWidthConstraint,
} = require("../electron/minimal-window-constraints.cjs");

test("automatic minimal entry prioritizes width before height", () => {
  assert.equal(
    chooseMinimalOrientationForSize(
      { width: 465, height: 299 },
      420,
      320,
    ),
    "horizontal",
  );
  assert.equal(
    chooseMinimalOrientationForSize(
      { width: 420, height: 299 },
      420,
      320,
    ),
    "medium",
  );
  assert.equal(
    chooseMinimalOrientationForSize(
      { width: 240, height: 500 },
      420,
      320,
    ),
    "medium",
  );
  assert.equal(
    chooseMinimalOrientationForSize(
      { width: 239, height: 500 },
      420,
      320,
    ),
    "vertical",
  );
});

test("active minimal orientation crosses medium and vertical boundaries", () => {
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 420, height: 56 },
      420,
      320,
      "horizontal",
    ),
    "medium",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 240, height: 202 },
      420,
      320,
      "medium",
    ),
    "medium",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 239, height: 202 },
      420,
      320,
      "medium",
    ),
    "vertical",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 260, height: 418 },
      420,
      320,
      "vertical",
    ),
    "vertical",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 261, height: 418 },
      420,
      320,
      "vertical",
    ),
    "medium",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 440, height: 202 },
      420,
      320,
      "medium",
    ),
    "medium",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: 441, height: 202 },
      420,
      320,
      "medium",
    ),
    "horizontal",
  );
});

test("minimal exit keeps the exact 20px hysteresis boundary", () => {
  assert.equal(
    shouldExitMinimalForSize(
      { width: 440, height: 340 },
      420,
      320,
    ),
    false,
  );
  assert.equal(
    shouldExitMinimalForSize(
      { width: 441, height: 341 },
      420,
      320,
    ),
    true,
  );
});

test("medium native constraints leave room to cross the vertical boundary", () => {
  const standard = getMediumMinimalWidthConstraint(1920);
  assert.deepEqual(standard, {
    width: 240,
    minWidth: 232,
  });
  assert.ok(standard.minWidth < VERTICAL_MINIMAL_ENTER_WIDTH);
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: standard.minWidth, height: 202 },
      420,
      320,
      "medium",
    ),
    "vertical",
  );
  assert.equal(
    chooseActiveMinimalOrientationForSize(
      { width: standard.width, height: 202 },
      420,
      320,
      "medium",
    ),
    "medium",
  );
  assert.deepEqual(getMediumMinimalWidthConstraint(200), {
    width: 200,
    minWidth: 200,
  });
});
