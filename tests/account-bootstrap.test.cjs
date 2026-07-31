const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadAccountBootstrapModule() {
  const filename = path.join(
    __dirname,
    "..",
    "src",
    "accountBootstrap.ts",
  );
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
  ACCOUNT_STORAGE_KEY,
  parseAccountStorage,
} = loadAccountBootstrapModule();

test("exports the existing account storage key", () => {
  assert.equal(ACCOUNT_STORAGE_KEY, "tokencat-desktop-accounts");
});

test("missing storage starts onboarding with an empty account list", () => {
  assert.deepEqual(parseAccountStorage(null), {
    status: "missing",
    accounts: [],
    shouldStartOnboarding: true,
  });
});

test("a stored empty array is valid and does not restart onboarding", () => {
  assert.deepEqual(parseAccountStorage("[]"), {
    status: "valid",
    accounts: [],
    shouldStartOnboarding: false,
  });
});

test("a stored array preserves valid account candidates", () => {
  const rawAccounts = [
    {
      id: "claude-work",
      provider: "Claude",
      quotas: {
        weekly: { used: 37, visible: true },
      },
    },
    {
      id: "codex-personal",
      provider: "Codex",
    },
  ];
  const originalAccounts = structuredClone(rawAccounts);
  const stored = JSON.stringify(rawAccounts);

  const result = parseAccountStorage(stored);

  assert.equal(result.status, "valid");
  assert.equal(result.shouldStartOnboarding, false);
  assert.deepEqual(result.accounts, rawAccounts);
  assert.deepEqual(rawAccounts, originalAccounts);
  assert.equal(stored, JSON.stringify(originalAccounts));
});

test("invalid array entries are ignored instead of becoming sample accounts", () => {
  const validAccount = {
    id: "claude-valid",
    provider: "Claude",
  };
  const stored = JSON.stringify([
    null,
    42,
    "legacy-entry",
    [],
    {},
    { provider: "Unknown" },
    validAccount,
  ]);

  assert.deepEqual(parseAccountStorage(stored), {
    status: "valid",
    accounts: [validAccount],
    shouldStartOnboarding: false,
  });
});

test("malformed JSON is invalid without triggering onboarding", () => {
  assert.deepEqual(parseAccountStorage("{not-json"), {
    status: "invalid",
    accounts: [],
    shouldStartOnboarding: false,
  });
});

test("valid non-array JSON is invalid without triggering onboarding", () => {
  for (const stored of [
    "null",
    "{}",
    '"accounts"',
    "42",
    "true",
  ]) {
    assert.deepEqual(parseAccountStorage(stored), {
      status: "invalid",
      accounts: [],
      shouldStartOnboarding: false,
    });
  }
});
