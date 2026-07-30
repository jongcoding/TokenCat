const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

test("managed Claude ignores fake nested usage and reads structured message usage", async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tokencat-claude-managed-"),
  );
  const userDataPath = path.join(temporaryRoot, "user-data");
  const globalConfigPath = path.join(temporaryRoot, "global-claude");
  const previousConfigPath = process.env.CLAUDE_CONFIG_DIR;
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
        resets_at: "2026-08-05T13:59:59.582Z",
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
      resetsAt: "2026-08-05T13:59:59.582Z",
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
