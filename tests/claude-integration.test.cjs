const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { spawnSync } = childProcess;
const test = require("node:test");

const { IntegrationService } = require("../electron/integrations.cjs");

function fakeApp(userDataPath = path.join(os.tmpdir(), "tokencat-integration-test")) {
  return {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataPath;
    },
    getVersion() {
      return "0.24.0-test";
    },
  };
}

function claudeUsageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function writeClaudeOAuthCredential(configPath, credential) {
  fs.mkdirSync(configPath, { recursive: true });
  fs.writeFileSync(
    path.join(configPath, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: credential }),
    "utf8",
  );
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function integrationServiceWithSpawn(spawnImplementation) {
  const modulePath = require.resolve("../electron/integrations.cjs");
  const originalSpawn = childProcess.spawn;
  try {
    childProcess.spawn = spawnImplementation;
    delete require.cache[modulePath];
    return require(modulePath).IntegrationService;
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[modulePath];
    require(modulePath);
  }
}

test("status reads reuse recent CLI snapshots while explicit refresh stays fresh", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-status-cache-"),
  );
  const service = new IntegrationService(fakeApp(temporaryRoot));
  let codexReads = 0;

  try {
    service.writeConnection("codex", true);
    service.writeConnection("claude", false);
    service.readCodexAccountAndRateLimits = async () => {
      codexReads += 1;
      return {
        accountResult: {
          account: {
            type: "chatgpt",
            planType: "plus",
          },
        },
        rateLimitResult: {},
      };
    };

    const first = await service.getStatus();
    const second = await service.getStatus();

    assert.equal(codexReads, 1);
    assert.equal(first[0].connected, true);
    assert.equal(second[0].connected, true);
    assert.equal(first[0], second[0]);

    await service.refreshConnectedProvider("codex");
    assert.equal(codexReads, 2);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("integration caches stay bounded and are released on shutdown", () => {
  const service = new IntegrationService(fakeApp());

  for (let index = 0; index < 40; index += 1) {
    service.cacheSnapshot({
      provider: "claude",
      accountId: `account-${index}`,
    });
  }
  service.claudeUsageCache.set("usage", { usage: {}, expiresAt: Infinity });
  service.claudeTranscriptCache.set("transcript", {
    contextTokens: null,
    expiresAt: Infinity,
  });

  assert.equal(service.snapshotCache.size, 26);
  assert.equal(service.snapshotCache.has("managed:account-0"), false);
  assert.equal(service.snapshotCache.has("managed:account-39"), true);

  service.shutdown();

  assert.equal(service.snapshotCache.size, 0);
  assert.equal(service.claudeUsageCache.size, 0);
  assert.equal(service.claudeTranscriptCache.size, 0);
  assert.equal(service.snapshotListener, null);
});

test("refresh upgrades an existing TokenCat Claude bridge in place", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-upgrade-"),
  );
  const userDataPath = path.join(temporaryRoot, "user-data");
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const previousConfigPath = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigPath;
  const service = new IntegrationService(fakeApp(userDataPath));

  try {
    fs.mkdirSync(service.integrationsDirectory, { recursive: true });
    fs.mkdirSync(claudeConfigPath, { recursive: true });
    fs.writeFileSync(service.installedClaudeBridgePath, "old bridge", "utf8");
    fs.writeFileSync(
      path.join(claudeConfigPath, "settings.json"),
      `${JSON.stringify({
        statusLine: {
          type: "command",
          command: service.claudeStatusLineCommand(),
        },
      })}\n`,
      "utf8",
    );
    service.readClaudeAuth = async () => ({
      loggedIn: true,
      subscriptionType: "max",
      verifiedAt: "2026-07-30T06:00:00.000Z",
    });
    service.readClaudeOAuthUsage = async () => ({
      usage: null,
      errorCode: "CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE",
    });
    service.readLatestClaudeContextTokens = () => null;

    const snapshot = await service.refreshClaude();
    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeConfigPath, "settings.json"), "utf8"),
    );
    assert.equal(snapshot.connected, true);
    assert.equal(settings.statusLine.refreshInterval, 30);
    assert.deepEqual(
      fs.readFileSync(service.installedClaudeBridgePath),
      fs.readFileSync(service.sourceClaudeBridgePath),
    );
  } finally {
    service.shutdown();
    if (previousConfigPath === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigPath;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude authentication stays connected while expired quotas are hidden", async () => {
  const service = new IntegrationService(fakeApp());
  service.readClaudeAuth = async () => ({
    loggedIn: true,
    subscriptionType: "max",
    verifiedAt: "2026-07-30T06:00:00.000Z",
  });
  service.readClaudeOAuthUsage = async () => ({
    usage: null,
    errorCode: "CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE",
  });
  service.readLatestClaudeContextTokens = () => null;
  service.readClaudeRateLimitSnapshot = () => ({
    fiveHour: {
      usedPercent: 21,
      resetsAt: new Date(Date.now() - 60_000).toISOString(),
    },
    weekly: {
      usedPercent: 63,
      resetsAt: new Date(Date.now() - 30_000).toISOString(),
    },
    contextTokens: {
      inputTokens: 15_500,
      outputTokens: 1_200,
      contextWindowSize: 200_000,
      usedPercent: 7.75,
      observedAt: "2026-07-30T05:59:00.000Z",
    },
    updatedAt: "2026-07-30T05:59:00.000Z",
  });

  const snapshot = await service.refreshClaude({ requireBridge: false });
  service.shutdown();

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.plan, "max");
  assert.deepEqual(snapshot.quotas, {});
  assert.deepEqual(snapshot.contextTokens, {
    source: "claude-context-window",
    inputTokens: 15_500,
    outputTokens: 1_200,
    totalTokens: 16_700,
    contextWindowSize: 200_000,
    usedPercent: 7.75,
    observedAt: "2026-07-30T05:59:00.000Z",
  });
  assert.equal(snapshot.authVerifiedAt, "2026-07-30T06:00:00.000Z");
});

test("Claude OAuth usage accepts zero and deduplicates the same account", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-"),
  );
  const userDataPath = path.join(temporaryRoot, "user-data");
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(fakeApp(userDataPath));
  let requestCount = 0;

  try {
    fs.mkdirSync(claudeConfigPath, { recursive: true });
    fs.writeFileSync(
      path.join(claudeConfigPath, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-access-token",
          refreshToken: "must-never-leave-this-file",
        },
        unrelatedSecret: "discard-me",
      }),
      "utf8",
    );
    service.requestClaudeOAuthUsage = async () => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        five_hour: {
          utilization: 0,
          resets_at: null,
          ignored: "discard-me",
        },
        seven_day: {
          utilization: 5,
          resets_at: "2026-08-05T13:59:59.582Z",
        },
        extra_usage: {
          enabled: true,
          secret: "discard-me",
        },
      };
    };
    const auth = {
      loggedIn: true,
      subscriptionType: "max",
      accountFingerprint: "same-opaque-account",
    };
    const options = {
      env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
      managed: true,
    };

    const [first, second] = await Promise.all([
      service.readClaudeOAuthUsage(auth, options),
      service.readClaudeOAuthUsage(auth, options),
    ]);

    assert.equal(requestCount, 1);
    assert.equal(first.errorCode, null);
    assert.deepEqual(first, second);
    assert.deepEqual(first.usage.fiveHour, {
      usedPercent: 0,
      resetsAt: null,
    });
    assert.deepEqual(first.usage.weekly, {
      usedPercent: 5,
      resetsAt: "2026-08-05T13:59:59.582Z",
    });
    assert.deepEqual(Object.keys(first.usage).sort(), [
      "fiveHour",
      "updatedAt",
      "weekly",
    ]);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude OAuth usage refreshes a credential whose access token is expired", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-expired-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  let refreshCount = 0;
  const requestedTokens = [];

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "known-expired-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() - 60_000,
    });
    service.refreshClaudeOAuthCredential = async (...args) => {
      refreshCount += 1;
      assert.equal(args.length, 1);
      assert.equal(
        JSON.stringify(args[0]).includes("private-refresh-token"),
        false,
      );
      return {
        accessToken: "refreshed-access-token",
        refreshToken: "rotated-private-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
    };
    service.requestClaudeOAuthUsage = async (accessToken) => {
      requestedTokens.push(accessToken);
      return {
        five_hour: { utilization: 11, resets_at: null },
        seven_day: { utilization: 22, resets_at: null },
      };
    };

    const result = await service.readClaudeOAuthUsage(
      {
        loggedIn: true,
        accountFingerprint: "known-expired-account",
      },
      options,
    );

    assert.equal(refreshCount, 1);
    assert.deepEqual(requestedTokens, ["refreshed-access-token"]);
    assert.equal(result.errorCode, null);
    assert.equal(result.usage.fiveHour.usedPercent, 11);
    assert.equal(JSON.stringify(result).includes("access-token"), false);
    assert.equal(JSON.stringify(result).includes("refresh-token"), false);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude OAuth usage refreshes after 401 and retries exactly once", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-retry-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  const auth = {
    loggedIn: true,
    accountFingerprint: "retry-account",
  };
  let refreshCount = 0;
  const requestedTokens = [];

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "rejected-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    service.refreshClaudeOAuthCredential = async () => {
      refreshCount += 1;
      const refreshed = {
        accessToken: "accepted-access-token",
        refreshToken: "rotated-private-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      writeClaudeOAuthCredential(claudeConfigPath, refreshed);
      return refreshed;
    };
    service.requestClaudeOAuthUsage = async (accessToken) => {
      requestedTokens.push(accessToken);
      if (accessToken === "rejected-access-token") {
        throw claudeUsageError("CLAUDE_USAGE_TOKEN_EXPIRED");
      }
      return {
        five_hour: { utilization: 31, resets_at: null },
        seven_day: { utilization: 42, resets_at: null },
      };
    };

    const result = await service.readClaudeOAuthUsage(auth, options);

    assert.equal(refreshCount, 1);
    assert.deepEqual(requestedTokens, [
      "rejected-access-token",
      "accepted-access-token",
    ]);
    assert.equal(result.errorCode, null);
    assert.equal(result.usage.weekly.usedPercent, 42);

    const cached = await service.readClaudeOAuthUsage(auth, options);
    assert.equal(cached.errorCode, null);
    assert.equal(cached.usage.weekly.usedPercent, 42);
    assert.equal(requestedTokens.length, 2);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("concurrent Claude 401 responses share one credential refresh per profile", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-refresh-dedupe-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  const fakeBinPath = path.join(temporaryRoot, "fake-bin");
  const fakeClaudePath = path.join(fakeBinPath, "claude.exe");
  const previousPath = process.env.PATH;
  let expiredRequestCount = 0;
  let refreshedRequestCount = 0;
  let refreshCount = 0;

  try {
    fs.mkdirSync(fakeBinPath, { recursive: true });
    fs.writeFileSync(fakeClaudePath, Buffer.from([0x4d, 0x5a, 0, 0]));
    process.env.PATH = previousPath
      ? `${fakeBinPath}${path.delimiter}${previousPath}`
      : fakeBinPath;
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "shared-expired-access-token",
      refreshToken: "shared-private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      scopes: ["user:profile"],
    });
    service.requestClaudeOAuthUsage = async (accessToken) => {
      if (accessToken === "shared-expired-access-token") {
        expiredRequestCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw claudeUsageError("CLAUDE_USAGE_TOKEN_EXPIRED");
      }
      refreshedRequestCount += 1;
      return {
        five_hour: { utilization: 7, resets_at: null },
        seven_day: { utilization: 9, resets_at: null },
      };
    };
    service.runNative = async (
      executablePath,
      args,
      errorPrefix,
      runOptions,
    ) => {
      refreshCount += 1;
      assert.equal(path.basename(executablePath).toLowerCase(), "claude.exe");
      assert.deepEqual(args, ["auth", "login", "--claudeai"]);
      assert.equal(errorPrefix, "CLAUDE_USAGE_REFRESH");
      assert.equal(
        runOptions.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
        "shared-private-refresh-token",
      );
      assert.equal(
        runOptions.env.CLAUDE_CODE_OAUTH_SCOPES,
        "user:profile",
      );
      assert.equal(
        options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
        undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const refreshed = {
        accessToken: "shared-refreshed-access-token",
        refreshToken: "rotated-shared-private-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:profile"],
      };
      writeClaudeOAuthCredential(claudeConfigPath, refreshed);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const [first, second] = await Promise.all([
      service.readClaudeOAuthUsage(
        { loggedIn: true, accountFingerprint: "first-account" },
        options,
      ),
      service.readClaudeOAuthUsage(
        { loggedIn: true, accountFingerprint: "second-account" },
        options,
      ),
    ]);

    assert.equal(expiredRequestCount, 1);
    assert.equal(refreshCount, 1);
    assert.equal(refreshedRequestCount, 1);
    assert.equal(first.errorCode, null);
    assert.equal(second.errorCode, null);
    assert.equal(service.claudeCredentialRefreshRequests.size, 0);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude OAuth usage distinguishes refresh failure from an expired token", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-refresh-failure-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  let requestCount = 0;
  let refreshCount = 0;

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "expired-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    service.requestClaudeOAuthUsage = async () => {
      requestCount += 1;
      throw claudeUsageError("CLAUDE_USAGE_TOKEN_EXPIRED");
    };
    service.refreshClaudeOAuthCredential = async () => {
      refreshCount += 1;
      throw new Error("sanitized refresh failure");
    };

    const result = await service.readClaudeOAuthUsage(
      {
        loggedIn: true,
        accountFingerprint: "refresh-failure-account",
      },
      options,
    );

    assert.equal(requestCount, 1);
    assert.equal(refreshCount, 1);
    assert.equal(result.usage, null);
    assert.equal(result.errorCode, "CLAUDE_USAGE_REFRESH_FAILED");
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude OAuth usage does not refresh a permission-denied credential", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-permission-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  let refreshCount = 0;

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "permission-denied-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    service.requestClaudeOAuthUsage = async () => {
      throw claudeUsageError("CLAUDE_USAGE_PERMISSION_DENIED");
    };
    service.refreshClaudeOAuthCredential = async () => {
      refreshCount += 1;
      throw new Error("must not refresh on 403");
    };

    const result = await service.readClaudeOAuthUsage(
      {
        loggedIn: true,
        accountFingerprint: "permission-denied-account",
      },
      { env: { CLAUDE_CONFIG_DIR: claudeConfigPath } },
    );

    assert.equal(refreshCount, 0);
    assert.equal(result.usage, null);
    assert.equal(
      result.errorCode,
      "CLAUDE_USAGE_PERMISSION_DENIED",
    );
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude OAuth usage stops after one failed post-refresh retry", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-reauth-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  let requestCount = 0;
  let refreshCount = 0;

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "first-expired-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    service.requestClaudeOAuthUsage = async () => {
      requestCount += 1;
      throw claudeUsageError("CLAUDE_USAGE_TOKEN_EXPIRED");
    };
    service.refreshClaudeOAuthCredential = async () => {
      refreshCount += 1;
      const refreshed = {
        accessToken: "second-expired-access-token",
        refreshToken: "rotated-private-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      writeClaudeOAuthCredential(claudeConfigPath, refreshed);
      return refreshed;
    };

    const result = await service.readClaudeOAuthUsage(
      {
        loggedIn: true,
        accountFingerprint: "reauth-account",
      },
      options,
    );

    assert.equal(requestCount, 2);
    assert.equal(refreshCount, 1);
    assert.equal(result.usage, null);
    assert.equal(result.errorCode, "CLAUDE_USAGE_REAUTH_REQUIRED");
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude usage cache and requests do not cross credential changes in one profile", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-account-switch-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  const secondAccountAStarted = createDeferred();
  const secondAccountAResponse = createDeferred();
  const accountBStarted = createDeferred();
  let accountARequests = 0;
  let accountBRequests = 0;

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "account-a-access-token",
      refreshToken: "account-a-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    service.requestClaudeOAuthUsage = async (accessToken) => {
      if (accessToken === "account-a-access-token") {
        accountARequests += 1;
        if (accountARequests === 1) {
          return {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 20, resets_at: null },
          };
        }
        secondAccountAStarted.resolve();
        return secondAccountAResponse.promise;
      }
      assert.equal(accessToken, "account-b-access-token");
      accountBRequests += 1;
      accountBStarted.resolve();
      return {
        five_hour: { utilization: 80, resets_at: null },
        seven_day: { utilization: 90, resets_at: null },
      };
    };

    const accountAAuth = {
      loggedIn: true,
      accountFingerprint: "account-a",
    };
    const accountBAuth = {
      loggedIn: true,
      accountFingerprint: "account-b",
    };
    const firstAccountA = await service.readClaudeOAuthUsage(
      accountAAuth,
      options,
    );
    assert.equal(firstAccountA.usage.fiveHour.usedPercent, 10);
    await new Promise((resolve) => setImmediate(resolve));

    const pendingAccountA = service.readClaudeOAuthUsage(
      accountAAuth,
      { ...options, forceRefresh: true },
    );
    await secondAccountAStarted.promise;
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "account-b-access-token",
      refreshToken: "account-b-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    const pendingAccountB = service.readClaudeOAuthUsage(
      accountBAuth,
      options,
    );
    const accountBStartedBeforeACompleted = await Promise.race([
      accountBStarted.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    secondAccountAResponse.resolve({
      five_hour: { utilization: 25, resets_at: null },
      seven_day: { utilization: 35, resets_at: null },
    });
    const accountB = await pendingAccountB;
    const forcedAccountA = await pendingAccountA;

    assert.equal(accountBStartedBeforeACompleted, true);
    assert.equal(accountB.usage.fiveHour.usedPercent, 80);
    assert.equal(accountBRequests, 1);
    assert.equal(forcedAccountA.usage.fiveHour.usedPercent, 25);

    const cachedAccountB = await service.readClaudeOAuthUsage(
      accountBAuth,
      options,
    );
    assert.equal(cachedAccountB.usage.fiveHour.usedPercent, 80);
    assert.equal(accountARequests, 2);
    assert.equal(accountBRequests, 1);
    const cachedPercents = [...service.claudeUsageCache.values()].map(
      (entry) => entry.usage.fiveHour.usedPercent,
    );
    assert.equal(cachedPercents.includes(25), false);
    assert.equal(cachedPercents.includes(80), true);
  } finally {
    secondAccountAResponse.resolve({
      five_hour: { utilization: 0, resets_at: null },
    });
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("shared Claude 429 request increments backoff only once for all waiters", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-rate-limit-backoff-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  let requestCount = 0;

  try {
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "rate-limited-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    service.requestClaudeOAuthUsage = async () => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw claudeUsageError("CLAUDE_USAGE_RATE_LIMITED");
    };

    const [first, second] = await Promise.all([
      service.readClaudeOAuthUsage(
        { loggedIn: true, accountFingerprint: "rate-waiter-a" },
        options,
      ),
      service.readClaudeOAuthUsage(
        { loggedIn: true, accountFingerprint: "rate-waiter-b" },
        options,
      ),
    ]);

    assert.equal(requestCount, 1);
    assert.equal(first.errorCode, "CLAUDE_USAGE_RATE_LIMITED");
    assert.equal(second.errorCode, "CLAUDE_USAGE_RATE_LIMITED");
    const credentialVersion = service.claudeCredentialVersion(options);
    const backoffKey = service.claudeProfileCredentialCacheKey(
      options,
      credentialVersion,
    );
    assert.equal(service.claudeUsageBackoff.get(backoffKey).failures, 1);

    const third = await service.readClaudeOAuthUsage(
      { loggedIn: true, accountFingerprint: "rate-waiter-c" },
      options,
    );
    assert.equal(third.errorCode, "CLAUDE_USAGE_RATE_LIMITED");
    assert.equal(requestCount, 1);
    assert.equal(service.claudeUsageBackoff.get(backoffKey).failures, 1);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude credential refresh backoff prevents repeated CLI launches", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-refresh-backoff-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );
  const options = {
    env: { CLAUDE_CONFIG_DIR: claudeConfigPath },
    managed: true,
  };
  let cliLaunchCount = 0;

  try {
    service._performClaudeOAuthCredentialRefresh = async () => {
      cliLaunchCount += 1;
      throw claudeUsageError("CLAUDE_USAGE_REFRESH_FAILED");
    };

    await assert.rejects(
      service.refreshClaudeOAuthCredential(options),
      { code: "CLAUDE_USAGE_REFRESH_FAILED" },
    );
    await assert.rejects(
      service.refreshClaudeOAuthCredential(options),
      { code: "CLAUDE_USAGE_REFRESH_FAILED" },
    );

    const refreshKey = service.claudeCredentialRefreshKey(options);
    assert.equal(cliLaunchCount, 1);
    assert.equal(
      service.claudeCredentialRefreshBackoff.get(refreshKey).failures,
      1,
    );
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("new Claude context does not replace usage timestamp after OAuth failure", async () => {
  const service = new IntegrationService(fakeApp());
  const previousUsageUpdatedAt = "2026-08-10T02:00:00.000Z";
  const contextObservedAt = "2026-08-12T10:30:00.000Z";

  service.readClaudeOAuthUsage = async () => ({
    usage: null,
    errorCode: "CLAUDE_USAGE_NETWORK_ERROR",
  });
  service.readLatestClaudeContextTokens = () => ({
    inputTokens: 4_000,
    outputTokens: 500,
    contextWindowSize: 200_000,
    usedPercent: 2.25,
    observedAt: contextObservedAt,
  });

  try {
    const collected = await service.collectClaudeUsageSnapshot(
      { loggedIn: true, accountFingerprint: "context-only-account" },
      {
        fiveHour: { usedPercent: 17, resetsAt: null },
        usageUpdatedAt: previousUsageUpdatedAt,
        updatedAt: previousUsageUpdatedAt,
      },
    );

    assert.equal(
      collected.storedSnapshot.usageUpdatedAt,
      previousUsageUpdatedAt,
    );
    assert.equal(collected.storedSnapshot.updatedAt, contextObservedAt);
    assert.equal(
      collected.storedSnapshot.contextTokens.observedAt,
      contextObservedAt,
    );
    assert.equal(
      collected.usageState.errorCode,
      "CLAUDE_USAGE_NETWORK_ERROR",
    );
  } finally {
    service.shutdown();
  }
});

test("successful Claude logins clear transient state and force fresh usage", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-login-refresh-"),
  );
  const service = new IntegrationService(fakeApp(temporaryRoot));
  const staleCredentialSuffix = "credential:stale-version";
  const seedTransientState = (options = {}) => {
    const refreshKey = service.claudeCredentialRefreshKey(options);
    const profileKey = service.claudeProfileCacheKey(options);
    const credentialKey = `${profileKey}:${staleCredentialSuffix}`;
    service.claudeCredentialRefreshBackoff.set(refreshKey, {
      failures: 2,
      until: Date.now() + 60_000,
    });
    service.claudeUsageBackoff.set(credentialKey, {
      failures: 2,
      until: Date.now() + 60_000,
    });
    service.claudeUsageRequests.set(
      credentialKey,
      Promise.resolve({ stale: true }),
    );
    service.claudeUsageCache.set(credentialKey, {
      usage: { fiveHour: { usedPercent: 99, resetsAt: null } },
      expiresAt: Date.now() + 60_000,
    });
    return { credentialKey, profileKey, refreshKey };
  };
  const assertTransientStateCleared = (keys) => {
    assert.equal(
      service.claudeCredentialRefreshBackoff.has(keys.refreshKey),
      false,
    );
    assert.equal(service.claudeUsageBackoff.has(keys.credentialKey), false);
    assert.equal(service.claudeUsageRequests.has(keys.credentialKey), false);
    assert.equal(service.claudeUsageCache.has(keys.credentialKey), false);
  };

  try {
    const globalKeys = seedTransientState();
    service.claudeLoginProcess = {
      cancelled: false,
      child: {},
      closed: true,
      pollTimer: null,
      timer: null,
    };
    service.maintainClaudeBridgeIfOwned = () => {};
    service.writeConnection = () => {};
    service.startClaudeSnapshotWatcher = () => {};
    service.readClaudeRateLimitSnapshot = () => ({});
    let globalForceRefresh = null;
    service.collectClaudeUsageSnapshot = async (
      _auth,
      _stored,
      options,
    ) => {
      assertTransientStateCleared(globalKeys);
      globalForceRefresh = options.forceRefresh;
      return {
        storedSnapshot: {
          fiveHour: { usedPercent: 12, resetsAt: null },
          usageUpdatedAt: "2026-08-12T11:00:00.000Z",
          updatedAt: "2026-08-12T11:00:00.000Z",
        },
        usageState: { source: "oauth", errorCode: null },
      };
    };

    const globalSnapshot = await service.completeClaudeLogin(
      true,
      null,
      {
        loggedIn: true,
        subscriptionType: "max",
        verifiedAt: "2026-08-12T11:00:00.000Z",
        accountFingerprint: "fresh-global-account",
      },
    );
    assert.equal(globalSnapshot.connected, true);
    assert.equal(globalForceRefresh, true);

    const account = {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "claude",
      label: "Managed Max",
      createdAt: "2026-08-12T11:00:00.000Z",
    };
    const profilePath = service.managedProfilePath(account);
    const managedOptions = {
      env: { CLAUDE_CONFIG_DIR: profilePath },
    };
    const managedKeys = seedTransientState(managedOptions);
    service.managedLoginProcesses.set(account.id, {
      cancelled: false,
      child: {},
      closed: true,
      pollTimer: null,
      timer: null,
    });
    let managedForceUsage = null;
    service.refreshManagedIntegration = async (accountId, options) => {
      assert.equal(accountId, account.id);
      assertTransientStateCleared(managedKeys);
      managedForceUsage = options.forceUsage;
      return {
        provider: "claude",
        accountId,
        connected: true,
        status: "connected",
      };
    };
    service.findManagedAccountSafe = () => account;

    const managedSnapshot = await service.completeManagedLogin(
      account,
      true,
    );
    assert.equal(managedSnapshot.connected, true);
    assert.equal(managedForceUsage, true);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("concurrent global Claude login starts wait for refresh and spawn only once", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-global-login-dedupe-"),
  );
  const fakeBinPath = path.join(temporaryRoot, "fake-bin");
  const previousPath = process.env.PATH;
  const spawnCalls = [];
  const SpawnIntegrationService = integrationServiceWithSpawn(
    (executablePath, args, options) => {
      spawnCalls.push({ executablePath, args, options });
      const child = new EventEmitter();
      child.pid = null;
      return child;
    },
  );
  const service = new SpawnIntegrationService(fakeApp(temporaryRoot));
  const refresh = createDeferred();

  try {
    fs.mkdirSync(fakeBinPath, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBinPath, "claude.exe"),
      Buffer.from([0x4d, 0x5a, 0, 0]),
    );
    process.env.PATH = previousPath
      ? `${fakeBinPath}${path.delimiter}${previousPath}`
      : fakeBinPath;
    const profileKey = service.claudeCredentialRefreshKey();
    service.claudeCredentialRefreshRequests.set(
      profileKey,
      refresh.promise,
    );

    const first = service.startClaudeLogin({ force: true });
    const second = service.startClaudeLogin({ force: true });
    assert.equal(first, second);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls.length, 0);
    assert.equal(service.claudeInteractiveLoginProfiles.has(profileKey), true);

    service.claudeCredentialRefreshRequests.delete(profileKey);
    let lateRefreshLaunches = 0;
    service._performClaudeOAuthCredentialRefresh = async () => {
      lateRefreshLaunches += 1;
      throw claudeUsageError("CLAUDE_USAGE_REFRESH_FAILED");
    };
    await assert.rejects(
      service.refreshClaudeOAuthCredential(),
      { code: "CLAUDE_USAGE_REFRESH_FAILED" },
    );
    assert.equal(lateRefreshLaunches, 0);

    refresh.resolve({ accessToken: "refreshed" });
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first,
      second,
    ]);
    assert.equal(firstSnapshot.status, "connecting");
    assert.deepEqual(firstSnapshot, secondSnapshot);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args, [
      "auth",
      "login",
      "--claudeai",
    ]);
  } finally {
    refresh.resolve({ accessToken: "cleanup" });
    service.shutdown();
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("concurrent managed Claude login starts spawn only once per account", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-managed-login-dedupe-"),
  );
  const fakeBinPath = path.join(temporaryRoot, "fake-bin");
  const previousPath = process.env.PATH;
  let spawnCount = 0;
  const SpawnIntegrationService = integrationServiceWithSpawn(() => {
    spawnCount += 1;
    const child = new EventEmitter();
    child.pid = null;
    return child;
  });
  const service = new SpawnIntegrationService(fakeApp(temporaryRoot));
  const refresh = createDeferred();
  const account = {
    id: "22222222-2222-4222-8222-222222222222",
    provider: "claude",
    label: "Managed Max",
    createdAt: "2026-08-12T11:00:00.000Z",
  };

  try {
    fs.mkdirSync(fakeBinPath, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBinPath, "claude.exe"),
      Buffer.from([0x4d, 0x5a, 0, 0]),
    );
    process.env.PATH = previousPath
      ? `${fakeBinPath}${path.delimiter}${previousPath}`
      : fakeBinPath;
    service.ensureManagedClaudeBridge = () => {};
    const profileKey = service.claudeCredentialRefreshKey({
      env: {
        CLAUDE_CONFIG_DIR: service.managedProfilePath(account),
      },
    });
    service.claudeCredentialRefreshRequests.set(
      profileKey,
      refresh.promise,
    );

    const first = service.startManagedClaudeLogin(account);
    const second = service.startManagedClaudeLogin(account);
    assert.equal(first, second);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCount, 0);
    assert.equal(service.claudeInteractiveLoginProfiles.has(profileKey), true);

    refresh.resolve({ accessToken: "refreshed" });
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first,
      second,
    ]);
    assert.equal(firstSnapshot.status, "connecting");
    assert.deepEqual(firstSnapshot, secondSnapshot);
    assert.equal(spawnCount, 1);
    assert.equal(service.managedLoginProcesses.has(account.id), true);
  } finally {
    refresh.resolve({ accessToken: "cleanup" });
    service.shutdown();
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("shutdown keeps caches empty when pending Claude usage settles", async () => {
  const runPendingCase = async (outcome) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `tokencat-shutdown-${outcome}-`),
    );
    const service = new IntegrationService(fakeApp(temporaryRoot));
    const requestStarted = createDeferred();
    const response = createDeferred();

    service.readClaudeAuth = async () => ({
      loggedIn: true,
      subscriptionType: "max",
      verifiedAt: "2026-08-12T11:00:00.000Z",
      accountFingerprint: `shutdown-${outcome}`,
    });
    service.readClaudeOAuthCredential = () => ({
      accessToken: `pending-${outcome}-access-token`,
      refreshToken: null,
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshTokenExpiresAt: null,
      scopes: [],
    });
    service.requestClaudeOAuthUsage = async () => {
      requestStarted.resolve();
      return response.promise;
    };
    service.readClaudeRateLimitSnapshot = () => ({});
    service.readLatestClaudeContextTokens = () => null;

    try {
      const pendingRefresh = service.refreshClaude({
        requireBridge: false,
        forceUsage: true,
      });
      await requestStarted.promise;
      service.shutdown();
      if (outcome === "success") {
        response.resolve({
          five_hour: { utilization: 14, resets_at: null },
          seven_day: { utilization: 28, resets_at: null },
        });
      } else {
        response.reject(claudeUsageError("CLAUDE_USAGE_RATE_LIMITED"));
      }
      await pendingRefresh;
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(service.claudeUsageCache.size, 0);
      assert.equal(service.snapshotCache.size, 0);
      assert.equal(service.claudeUsageBackoff.size, 0);
      assert.equal(service.claudeCredentialRefreshBackoff.size, 0);
      assert.equal(service.claudeUsageRequests.size, 0);
    } finally {
      response.resolve({
        five_hour: { utilization: 0, resets_at: null },
      });
      service.shutdown();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  };

  await runPendingCase("success");
  await runPendingCase("rate-limit");
});

test("Claude refresh child receives only allowlisted transport environment", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-refresh-env-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const fakeBinPath = path.join(temporaryRoot, "fake-bin");
  const previousPath = process.env.PATH;
  const service = new IntegrationService(fakeApp(temporaryRoot));
  let capturedEnvironment = null;
  let environmentReference = null;

  try {
    fs.mkdirSync(fakeBinPath, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBinPath, "claude.exe"),
      Buffer.from([0x4d, 0x5a, 0, 0]),
    );
    process.env.PATH = previousPath
      ? `${fakeBinPath}${path.delimiter}${previousPath}`
      : fakeBinPath;
    writeClaudeOAuthCredential(claudeConfigPath, {
      accessToken: "old-access-token",
      refreshToken: "private-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      scopes: ["user:profile"],
    });
    const options = {
      env: {
        PATH: "safe-path",
        HTTPS_PROXY: "http://proxy.example:8080",
        NO_PROXY: "localhost",
        NODE_EXTRA_CA_CERTS: "C:\\transport\\extra-ca.pem",
        SSL_CERT_FILE: "C:\\transport\\ca.pem",
        CLAUDE_CODE_CLIENT_CERT: "C:\\transport\\client.pem",
        CLAUDE_CODE_CLIENT_KEY: "C:\\transport\\client.key",
        CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "transport-passphrase",
        OPENAI_API_KEY: "must-not-leak-openai",
        GITHUB_TOKEN: "must-not-leak-github",
        CONNECTORS_TOKEN: "must-not-leak-connectors",
        ANTHROPIC_API_KEY: "must-not-leak-anthropic",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak-existing-oauth",
        RANDOM_PRIVATE_SECRET: "must-not-leak-random",
        CLAUDE_CONFIG_DIR: "C:\\wrong-profile",
      },
      managed: true,
    };
    options.env.CLAUDE_CONFIG_DIR = claudeConfigPath;
    service.runNative = async (_path, _args, _prefix, runOptions) => {
      environmentReference = runOptions.env;
      capturedEnvironment = { ...runOptions.env };
      writeClaudeOAuthCredential(claudeConfigPath, {
        accessToken: "new-access-token",
        refreshToken: "rotated-private-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:profile"],
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const refreshed = await service._performClaudeOAuthCredentialRefresh(
      options,
    );
    assert.equal(refreshed.accessToken, "new-access-token");
    assert.equal(capturedEnvironment.PATH, "safe-path");
    assert.equal(
      capturedEnvironment.HTTPS_PROXY,
      "http://proxy.example:8080",
    );
    assert.equal(capturedEnvironment.NO_PROXY, "localhost");
    assert.equal(
      capturedEnvironment.NODE_EXTRA_CA_CERTS,
      "C:\\transport\\extra-ca.pem",
    );
    assert.equal(
      capturedEnvironment.CLAUDE_CODE_CLIENT_CERT,
      "C:\\transport\\client.pem",
    );
    assert.equal(
      capturedEnvironment.CLAUDE_CONFIG_DIR,
      claudeConfigPath,
    );
    assert.equal(
      capturedEnvironment.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
      "private-refresh-token",
    );
    assert.equal(
      capturedEnvironment.CLAUDE_CODE_OAUTH_SCOPES,
      "user:profile",
    );
    for (const secretName of [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "CONNECTORS_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "RANDOM_PRIVATE_SECRET",
    ]) {
      assert.equal(capturedEnvironment[secretName], undefined);
    }
    assert.equal(
      environmentReference.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
      undefined,
    );
    assert.equal(
      environmentReference.CLAUDE_CODE_OAUTH_SCOPES,
      undefined,
    );
    assert.equal(
      options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
      undefined,
    );
  } finally {
    service.shutdown();
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude usage honors HTTPS proxy and NO_PROXY bypass", async () => {
  const https = require("node:https");
  const originalRequest = https.request;
  const capturedRequests = [];
  const service = new IntegrationService(fakeApp());
  https.request = (requestOptions, onResponse) => {
    capturedRequests.push(requestOptions);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.destroy = () => {};
      onResponse(response);
      queueMicrotask(() => {
        response.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              five_hour: { utilization: 3, resets_at: null },
              seven_day: { utilization: 6, resets_at: null },
            }),
          ),
        );
        response.emit("end");
      });
    };
    return request;
  };

  try {
    const proxied = await service.requestClaudeOAuthUsage("token", {
      env: { HTTPS_PROXY: "http://proxy.example:8080" },
    });
    const bypassed = await service.requestClaudeOAuthUsage("token", {
      env: {
        HTTPS_PROXY: "http://proxy.example:8080",
        NO_PROXY: "localhost,.anthropic.com",
      },
    });

    assert.equal(proxied.five_hour.utilization, 3);
    assert.equal(bypassed.seven_day.utilization, 6);
    assert.ok(capturedRequests[0].agent);
    assert.equal("agent" in capturedRequests[1], false);
  } finally {
    https.request = originalRequest;
    service.shutdown();
  }
});

test("Claude credential maintenance refreshes only expiring eligible profiles", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-maintenance-"),
  );
  const service = new IntegrationService(fakeApp(temporaryRoot));
  const now = Date.now();
  const expiringClaude = {
    id: "33333333-3333-4333-8333-333333333333",
    provider: "claude",
    label: "Expiring Max",
    createdAt: "2026-08-12T11:00:00.000Z",
  };
  const normalClaude = {
    id: "44444444-4444-4444-8444-444444444444",
    provider: "claude",
    label: "Healthy Max",
    createdAt: "2026-08-12T11:00:00.000Z",
  };
  const interactiveClaude = {
    id: "55555555-5555-4555-8555-555555555555",
    provider: "claude",
    label: "Interactive Max",
    createdAt: "2026-08-12T11:00:00.000Z",
  };
  const codexAccount = {
    id: "66666666-6666-4666-8666-666666666666",
    provider: "codex",
    label: "Codex Plus",
    createdAt: "2026-08-12T11:00:00.000Z",
  };
  const expiringPath = service.managedProfilePath(expiringClaude);
  const normalPath = service.managedProfilePath(normalClaude);
  const interactivePath = service.managedProfilePath(interactiveClaude);
  const credentialReads = [];
  const refreshes = [];

  try {
    service.readConnections = () => ({ codex: true, claude: true });
    service.readManagedAccounts = () => [
      expiringClaude,
      normalClaude,
      interactiveClaude,
      codexAccount,
    ];
    service.readClaudeOAuthCredential = (options = {}) => {
      const configPath = options.env?.CLAUDE_CONFIG_DIR ?? "global";
      credentialReads.push(configPath);
      const expiresAt =
        configPath === normalPath
          ? now + 2 * 60 * 60 * 1000
          : now + 44 * 60 * 1000;
      return {
        accessToken: `access-${path.basename(configPath)}`,
        refreshToken: "refresh-token",
        expiresAt,
        refreshTokenExpiresAt: now + 24 * 60 * 60 * 1000,
        scopes: ["user:profile"],
      };
    };
    service.refreshClaudeOAuthCredential = async (options = {}) => {
      refreshes.push(options.env?.CLAUDE_CONFIG_DIR ?? "global");
      return service.readClaudeOAuthCredential(options);
    };
    const interactiveKey = service.claudeCredentialRefreshKey({
      env: { CLAUDE_CONFIG_DIR: interactivePath },
    });
    service.claudeInteractiveLoginProfiles.add(interactiveKey);

    await service.maintainClaudeCredentials();

    assert.deepEqual(refreshes.sort(), ["global", expiringPath].sort());
    assert.equal(credentialReads.includes("global"), true);
    assert.equal(credentialReads.includes(expiringPath), true);
    assert.equal(credentialReads.includes(normalPath), true);
    assert.equal(credentialReads.includes(interactivePath), false);
    assert.equal(
      credentialReads.some((entry) => entry.includes(codexAccount.id)),
      false,
    );
    assert.equal(service.claudeCredentialMaintenanceRequest, null);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("snapshot listener starts unrefed maintenance and shutdown clears all handles", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-maintenance-shutdown-"),
  );
  const service = new IntegrationService(fakeApp(temporaryRoot));
  const maintenance = createDeferred();
  let destroyedRequests = 0;

  service.readConnections = () => ({ codex: false, claude: false });
  service.startManagedSnapshotWatcher = () => {};
  service.setSnapshotListener(() => {});

  try {
    const timer = service.claudeCredentialMaintenanceTimer;
    assert.ok(timer);
    assert.equal(typeof timer.hasRef, "function");
    assert.equal(timer.hasRef(), false);

    service.claudeCredentialMaintenanceRequest = maintenance.promise;
    service.claudeCredentialRefreshRequests.set(
      "pending-refresh",
      Promise.resolve(),
    );
    service.claudeUsageRequests.set("pending-usage", Promise.resolve());
    service.claudeUsageHttpRequests.add({
      destroy() {
        destroyedRequests += 1;
      },
    });

    service.shutdown();
    maintenance.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(destroyedRequests, 1);
    assert.equal(service.claudeCredentialMaintenanceTimer, null);
    assert.equal(service.claudeCredentialMaintenanceRequest, null);
    assert.equal(service.claudeCredentialRefreshRequests.size, 0);
    assert.equal(service.claudeUsageRequests.size, 0);
    assert.equal(service.claudeUsageHttpRequests.size, 0);
    assert.equal(service.snapshotListener, null);
  } finally {
    maintenance.resolve();
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("managed Claude ignores fake nested usage and reads structured message usage", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-managed-"),
  );
  const userDataPath = path.join(temporaryRoot, "user-data");
  const globalConfigPath = path.join(temporaryRoot, "global-claude");
  const previousConfigPath = process.env.CLAUDE_CONFIG_DIR;
  const futureWeeklyResetAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  process.env.CLAUDE_CONFIG_DIR = globalConfigPath;
  const service = new IntegrationService(fakeApp(userDataPath));

  try {
    const transcriptDirectory = path.join(
      globalConfigPath,
      "projects",
      "safe-project-key",
    );
    fs.mkdirSync(transcriptDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(globalConfigPath, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "global-access-token" },
      }),
      "utf8",
    );
    const transcript = {
      parentUuid: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "SECRET PROMPT CONTENT MUST NOT BE PARSED OR RETURNED",
          },
        ],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5_000,
          output_tokens: 700,
          service_tier: "standard",
        },
      },
      requestId: "redacted",
      type: "assistant",
      timestamp: "2026-07-30T08:00:00.000Z",
    };
    const fakeNestedUsage = {
      role: "assistant",
      usage: {
        input_tokens: 900_000,
        cache_creation_input_tokens: 90_000,
        cache_read_input_tokens: 9_000,
        output_tokens: 8_000,
      },
      type: "assistant",
    };
    const assistantWithFakeToolUsageOnly = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_result",
            content: fakeNestedUsage,
          },
          {
            type: "text",
            text: 'SECRET PROMPT WITH {"role":"assistant","usage":{"input_tokens":777777},"type":"assistant"}',
          },
        ],
      },
      timestamp: "2026-07-30T08:01:00.000Z",
    };
    const userWithFakePromptUsage = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "SECRET USER PROMPT",
            payload: fakeNestedUsage,
          },
        ],
      },
      timestamp: "2026-07-30T08:02:00.000Z",
    };
    fs.writeFileSync(
      path.join(transcriptDirectory, "session.jsonl"),
      [
        JSON.stringify(transcript),
        JSON.stringify(assistantWithFakeToolUsageOnly),
        JSON.stringify(userWithFakePromptUsage),
        "",
      ].join("\n"),
      "utf8",
    );

    const created = await service.createManagedIntegration({
      provider: "claude",
      label: "Max",
    });
    const managedProfile = service.managedProfilePath({
      id: created.accountId,
      provider: "claude",
    });
    fs.writeFileSync(
      path.join(managedProfile, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "managed-access-token" },
      }),
      "utf8",
    );
    service.readClaudeAuth = async () => ({
      loggedIn: true,
      subscriptionType: "max",
      verifiedAt: "2026-07-30T08:01:00.000Z",
      accountFingerprint: "matching-global-and-managed-account",
    });
    service.requestClaudeOAuthUsage = async () => ({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: {
        utilization: 5,
        resets_at: futureWeeklyResetAt,
      },
      ignored: { content: "discard-me" },
    });

    const snapshot = await service.refreshManagedIntegration(
      created.accountId,
    );

    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.plan, "max");
    assert.equal(snapshot.usageSource, "oauth");
    assert.equal(snapshot.usageErrorCode, null);
    assert.equal(snapshot.matchesGlobalAccount, true);
    assert.deepEqual(snapshot.quotas.fiveHour, {
      usedPercent: 0,
      resetsAt: null,
    });
    assert.deepEqual(snapshot.quotas.weekly, {
      usedPercent: 5,
      resetsAt: futureWeeklyResetAt,
    });
    assert.deepEqual(snapshot.contextTokens, {
      source: "claude-context-window",
      inputTokens: 5_302,
      outputTokens: 700,
      totalTokens: 6_002,
      contextWindowSize: null,
      usedPercent: null,
      observedAt: snapshot.contextTokens.observedAt,
    });
    assert.ok(Date.parse(snapshot.contextTokens.observedAt));
    assert.equal(
      JSON.stringify(snapshot).includes("SECRET PROMPT"),
      false,
    );
    assert.notEqual(snapshot.contextTokens.inputTokens, 999_000);
    assert.notEqual(snapshot.contextTokens.outputTokens, 8_000);
  } finally {
    service.shutdown();
    if (previousConfigPath === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigPath;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("OAuth auth failure keeps sanitized local fallback and status", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-oauth-fallback-"),
  );
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const service = new IntegrationService(
    fakeApp(path.join(temporaryRoot, "user-data")),
  );

  try {
    fs.mkdirSync(claudeConfigPath, { recursive: true });
    fs.writeFileSync(
      path.join(claudeConfigPath, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "expired-access-token" },
      }),
      "utf8",
    );
    service.requestClaudeOAuthUsage = async () => {
      const error = new Error("sanitized");
      error.code = "CLAUDE_USAGE_AUTH_ERROR";
      throw error;
    };
    service.readLatestClaudeContextTokens = () => null;

    const collected = await service.collectClaudeUsageSnapshot(
      {
        loggedIn: true,
        accountFingerprint: "fallback-account",
      },
      {
        fiveHour: {
          usedPercent: 12,
          resetsAt: "2026-08-01T00:00:00.000Z",
        },
        weekly: {
          usedPercent: 34,
          resetsAt: "2026-08-06T00:00:00.000Z",
        },
        updatedAt: "2026-07-30T07:00:00.000Z",
      },
      { env: { CLAUDE_CONFIG_DIR: claudeConfigPath } },
    );

    assert.equal(
      collected.usageState.errorCode,
      "CLAUDE_USAGE_AUTH_ERROR",
    );
    assert.equal(collected.usageState.source, "local");
    assert.equal(collected.storedSnapshot.fiveHour.usedPercent, 12);
    assert.equal(collected.storedSnapshot.weekly.usedPercent, 34);
  } finally {
    service.shutdown();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("custom Claude statusLine does not block OAuth connection", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-custom-statusline-"),
  );
  const userDataPath = path.join(temporaryRoot, "user-data");
  const claudeConfigPath = path.join(temporaryRoot, "claude-config");
  const previousConfigPath = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigPath;
  const service = new IntegrationService(fakeApp(userDataPath));

  try {
    fs.mkdirSync(claudeConfigPath, { recursive: true });
    const customStatusLine = {
      type: "command",
      command: "my-private-statusline",
      refreshInterval: 7,
    };
    fs.writeFileSync(
      path.join(claudeConfigPath, "settings.json"),
      JSON.stringify({ statusLine: customStatusLine }),
      "utf8",
    );
    service.readClaudeAuth = async () => ({
      loggedIn: true,
      subscriptionType: "max",
      verifiedAt: "2026-07-30T08:00:00.000Z",
      accountFingerprint: "custom-statusline-account",
    });
    service.readClaudeOAuthUsage = async () => ({
      usage: {
        fiveHour: { usedPercent: 1, resetsAt: null },
        weekly: { usedPercent: 2, resetsAt: null },
        updatedAt: "2026-07-30T08:00:00.000Z",
      },
      errorCode: null,
    });
    service.readLatestClaudeContextTokens = () => null;

    const snapshot = await service.connect("claude");
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(claudeConfigPath, "settings.json"),
        "utf8",
      ),
    );

    assert.equal(snapshot.connected, true);
    assert.deepEqual(settings.statusLine, customStatusLine);
  } finally {
    service.shutdown();
    if (previousConfigPath === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigPath;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test(
  "Claude status-line bridge stores exact current-context token counts",
  { skip: process.platform !== "win32" },
  () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "tokencat-claude-bridge-"),
    );
    const snapshotPath = path.join(temporaryRoot, "snapshot.json");
    const bridgePath = path.join(
      __dirname,
      "..",
      "electron",
      "claude-statusline-bridge.ps1",
    );
    const powershellPath = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const payload = {
      rate_limits: {
        five_hour: {
          used_percentage: 23.5,
          resets_at: 1_893_456_000,
        },
        seven_day: {
          used_percentage: 41.2,
          resets_at: 1_893_542_400,
        },
      },
      context_window: {
        total_input_tokens: 15_500,
        total_output_tokens: 1_200,
        context_window_size: 200_000,
        used_percentage: 7.75,
      },
    };

    try {
      const result = spawnSync(
        powershellPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          bridgePath,
          "-SnapshotPath",
          snapshotPath,
        ],
        {
          encoding: "utf8",
          input: JSON.stringify(payload),
          windowsHide: true,
        },
      );
      assert.equal(result.status, 0, result.stderr);

      const stored = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      assert.deepEqual(stored.fiveHour, {
        usedPercent: 23.5,
        resetsAt: 1_893_456_000,
      });
      assert.deepEqual(stored.weekly, {
        usedPercent: 41.2,
        resetsAt: 1_893_542_400,
      });
      assert.equal(stored.contextTokens.inputTokens, 15_500);
      assert.equal(stored.contextTokens.outputTokens, 1_200);
      assert.equal(stored.contextTokens.contextWindowSize, 200_000);
      assert.equal(stored.contextTokens.usedPercent, 7.75);
      assert.ok(Date.parse(stored.contextTokens.observedAt));

      const contextOnlyResult = spawnSync(
        powershellPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          bridgePath,
          "-SnapshotPath",
          snapshotPath,
        ],
        {
          encoding: "utf8",
          input: JSON.stringify({
            context_window: {
              context_window_size: 200_000,
              used_percentage: 10,
              current_usage: {
                input_tokens: 12_000,
                output_tokens: 2_000,
                cache_creation_input_tokens: 3_000,
                cache_read_input_tokens: 5_000,
              },
            },
          }),
          windowsHide: true,
        },
      );
      assert.equal(contextOnlyResult.status, 0, contextOnlyResult.stderr);

      const contextOnlyStored = JSON.parse(
        fs.readFileSync(snapshotPath, "utf8"),
      );
      assert.deepEqual(contextOnlyStored.fiveHour, stored.fiveHour);
      assert.deepEqual(contextOnlyStored.weekly, stored.weekly);
      assert.equal(contextOnlyStored.contextTokens.inputTokens, 20_000);
      assert.equal(contextOnlyStored.contextTokens.outputTokens, 2_000);
      assert.equal(contextOnlyStored.contextTokens.usedPercent, 10);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
