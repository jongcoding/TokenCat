const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const PROVIDERS = new Set(["codex", "claude"]);
const PROCESS_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const CONNECTIONS_FILE_NAME = "connections.json";
const CLAUDE_SNAPSHOT_FILE_NAME = "claude-rate-limits.json";
const CLAUDE_BRIDGE_FILE_NAME = "claude-statusline-bridge.ps1";
const CLAUDE_WATCH_DEBOUNCE_MS = 80;
const CLAUDE_STATUSLINE_REFRESH_SECONDS = 30;
const CLAUDE_USAGE_CACHE_MS = 45_000;
const CLAUDE_AUTH_CACHE_MS = 15_000;
const CLAUDE_USAGE_RESPONSE_LIMIT_BYTES = 64 * 1024;
const CLAUDE_CREDENTIALS_LIMIT_BYTES = 1024 * 1024;
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const CLAUDE_TRANSCRIPT_RECORD_LIMIT_BYTES = 8 * 1024 * 1024;
const CLAUDE_TRANSCRIPT_RECORD_SCAN_LIMIT = 200;
const CLAUDE_USAGE_HOST = "api.anthropic.com";
const CLAUDE_USAGE_PATH = "/api/oauth/usage";
const CLAUDE_USAGE_USER_AGENT = "claude-cli/2.1.220";
const MANAGED_ACCOUNTS_FILE_NAME = "managed-accounts.json";
const MANAGED_ACCOUNT_LIMIT = 12;
const MANAGED_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CLAUDE_LOGIN_POLL_MS = 900;
const CLAUDE_LOGIN_EXIT_GRACE_MS = 5_000;
const MANAGED_REFRESH_CONCURRENCY = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function disconnectedSnapshot(provider) {
  return {
    provider,
    connected: false,
    plan: null,
    status: "disconnected",
    quotas: {},
    contextTokens: null,
    lastUpdatedAt: null,
    authVerifiedAt: null,
    usageSource: null,
    usageErrorCode: null,
    errorCode: null,
  };
}

function errorSnapshot(provider, status, errorCode) {
  return {
    ...disconnectedSnapshot(provider),
    status,
    errorCode,
  };
}

function connectingSnapshot(provider) {
  return {
    ...disconnectedSnapshot(provider),
    status: "connecting",
  };
}

function integrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isTerminalClaudeLoginError(error) {
  return (
    error?.code === "CLAUDE_NOT_FOUND" ||
    error?.code === "CLAUDE_API_MODE_UNSUPPORTED" ||
    error?.code === "CLAUDE_SUBSCRIPTION_UNSUPPORTED"
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandsMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function clampPercent(value) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  ) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(100, Math.max(0, numeric));
}

function nonnegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const normalized = Math.floor(numeric);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function epochToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeIso(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeQuota(usedPercent, resetsAt) {
  const normalizedPercent = clampPercent(usedPercent);
  if (normalizedPercent === null) return null;
  return {
    usedPercent: normalizedPercent,
    resetsAt:
      typeof resetsAt === "string"
        ? normalizeIso(resetsAt)
        : epochToIso(resetsAt),
  };
}

function normalizeContextTokens(value) {
  if (!isPlainObject(value)) return null;
  const inputTokens = nonnegativeInteger(value.inputTokens);
  const outputTokens = nonnegativeInteger(value.outputTokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens <= 0
  ) {
    return null;
  }

  const contextWindowSize = nonnegativeInteger(value.contextWindowSize);
  return {
    source: "claude-context-window",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contextWindowSize:
      contextWindowSize !== null && contextWindowSize > 0
        ? contextWindowSize
        : null,
    usedPercent: clampPercent(value.usedPercent),
    observedAt: normalizeIso(value.observedAt),
  };
}

function normalizeClaudeOAuthWindow(value) {
  if (!isPlainObject(value)) return null;
  const usedPercent = clampPercent(value.utilization);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    resetsAt: normalizeIso(value.resets_at),
  };
}

function normalizeClaudeOAuthUsage(value, fetchedAt = new Date().toISOString()) {
  if (!isPlainObject(value)) {
    throw integrationError("CLAUDE_USAGE_RESPONSE_INVALID");
  }
  const fiveHour = normalizeClaudeOAuthWindow(value.five_hour);
  const weekly = normalizeClaudeOAuthWindow(value.seven_day);
  if (!fiveHour && !weekly) {
    throw integrationError("CLAUDE_USAGE_RESPONSE_INVALID");
  }
  return {
    fiveHour,
    weekly,
    updatedAt: normalizeIso(fetchedAt) ?? new Date().toISOString(),
  };
}

function newestContextTokens(...values) {
  let selected = null;
  let selectedTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!isPlainObject(value)) continue;
    const normalized = normalizeContextTokens(value);
    if (!normalized) continue;
    const observedTime = normalized.observedAt
      ? Date.parse(normalized.observedAt)
      : Number.NEGATIVE_INFINITY;
    if (!selected || observedTime >= selectedTime) {
      selected = value;
      selectedTime = Number.isFinite(observedTime)
        ? observedTime
        : Number.NEGATIVE_INFINITY;
    }
  }
  return selected;
}

function mergeClaudeUsageSnapshot(storedSnapshot, oauthUsage, contextTokens) {
  const stored = isPlainObject(storedSnapshot) ? storedSnapshot : {};
  const oauth = isPlainObject(oauthUsage) ? oauthUsage : null;
  const mergedContext = newestContextTokens(
    stored.contextTokens,
    contextTokens,
  );
  const localTimestamps = [
    stored.updatedAt,
    mergedContext?.observedAt,
  ]
    .map(normalizeIso)
    .filter(Boolean);
  const newestTimestamp =
    normalizeIso(oauth?.updatedAt) ??
    localTimestamps.sort(
      (left, right) => Date.parse(right) - Date.parse(left),
    )[0] ??
    null;

  return {
    fiveHour: oauth ? oauth.fiveHour : stored.fiveHour,
    weekly: oauth ? oauth.weekly : stored.weekly,
    contextTokens: mergedContext,
    updatedAt: newestTimestamp,
  };
}

function claudeAccountFingerprint(value) {
  if (!isPlainObject(value)) return null;
  const email =
    typeof value.email === "string"
      ? value.email.trim().toLowerCase()
      : "";
  const organization =
    typeof value.orgId === "string" ? value.orgId.trim().toLowerCase() : "";
  if (!email || !organization) return null;
  return crypto
    .createHash("sha256")
    .update(`claude-account\0${email}\0${organization}`, "utf8")
    .digest("hex");
}

function extractClaudeContextTokensFromRecord(recordBuffer) {
  if (
    !Buffer.isBuffer(recordBuffer) ||
    recordBuffer.length <= 0 ||
    recordBuffer.length > CLAUDE_TRANSCRIPT_RECORD_LIMIT_BYTES
  ) {
    return null;
  }

  let record;
  try {
    // Parse exactly one bounded JSONL record so nested prompt/tool strings
    // cannot impersonate top-level fields. Only the numeric allowlist below
    // escapes this function; the parsed record and source text are discarded
    // immediately and are never logged, returned, or persisted.
    record = JSON.parse(recordBuffer.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isPlainObject(record) ||
    record.type !== "assistant" ||
    !isPlainObject(record.message) ||
    record.message.role !== "assistant" ||
    !isPlainObject(record.message.usage)
  ) {
    return null;
  }

  const usage = record.message.usage;
  const directInput = nonnegativeInteger(usage.input_tokens) ?? 0;
  const cacheCreation =
    nonnegativeInteger(usage.cache_creation_input_tokens) ?? 0;
  const cacheRead =
    nonnegativeInteger(usage.cache_read_input_tokens) ?? 0;
  const outputTokens = nonnegativeInteger(usage.output_tokens) ?? 0;
  const inputTokens = directInput + cacheCreation + cacheRead;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens <= 0
  ) {
    return null;
  }
  return { inputTokens, outputTokens };
}

function extractLatestClaudeContextTokens(filePath) {
  let descriptor;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const bytesToRead = Math.min(stat.size, CLAUDE_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    descriptor = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      bytesToRead,
      stat.size - bytesToRead,
    );
    const content = buffer.subarray(0, bytesRead);
    const readOffset = stat.size - bytesToRead;
    let lineEnd = content.length;
    if (lineEnd > 0 && content[lineEnd - 1] === 0x0a) lineEnd -= 1;
    let scannedRecords = 0;

    while (
      lineEnd > 0 &&
      scannedRecords < CLAUDE_TRANSCRIPT_RECORD_SCAN_LIMIT
    ) {
      const newlineBefore = content.lastIndexOf(0x0a, lineEnd - 1);
      const lineStart = newlineBefore + 1;
      const lineLength = lineEnd - lineStart;
      scannedRecords += 1;

      // If the tail starts midway through a record, never parse that partial
      // line as standalone JSON. A complete earlier record is outside the
      // bounded privacy/read window and therefore intentionally unavailable.
      const partialFirstLine = lineStart === 0 && readOffset > 0;
      if (
        !partialFirstLine &&
        lineLength > 0 &&
        lineLength <= CLAUDE_TRANSCRIPT_RECORD_LIMIT_BYTES
      ) {
        const tokens = extractClaudeContextTokensFromRecord(
          content.subarray(lineStart, lineEnd),
        );
        if (tokens) {
          return {
            ...tokens,
            contextWindowSize: null,
            usedPercent: null,
            observedAt: stat.mtime.toISOString(),
          };
        }
      }
      if (newlineBefore < 0) break;
      lineEnd = newlineBefore;
      if (lineEnd > 0 && content[lineEnd - 1] === 0x0d) lineEnd -= 1;
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best effort close after a read failure.
      }
    }
  }
  return null;
}

function quotaWindowIsCurrent(quota) {
  if (!quota?.resetsAt) return true;
  const resetTime = Date.parse(quota.resetsAt);
  return !Number.isFinite(resetTime) || resetTime > Date.now();
}

function classifyCodexWindow(window, quotas) {
  if (!isPlainObject(window)) return;
  const duration = Number(window.windowDurationMins);
  const quota = normalizeQuota(window.usedPercent, window.resetsAt);
  if (!quota || !Number.isFinite(duration)) return;

  // The app-server reports rolling window duration in minutes. Codex currently
  // uses 300 minutes for the short window and 10,080 for the weekly window.
  if (duration <= 24 * 60) {
    quotas.fiveHour = quota;
  } else if (duration >= 6 * 24 * 60) {
    quotas.weekly = quota;
  }
}

function chooseCodexRateLimit(result) {
  const byLimitId = isPlainObject(result?.rateLimitsByLimitId)
    ? result.rateLimitsByLimitId
    : null;
  if (isPlainObject(byLimitId?.codex)) return byLimitId.codex;

  if (byLimitId) {
    const matching = Object.values(byLimitId).find(
      (entry) => isPlainObject(entry) && entry.limitId === "codex",
    );
    if (matching) return matching;
  }

  return isPlainObject(result?.rateLimits) ? result.rateLimits : null;
}

function normalizeCodexSnapshot(accountResult, rateLimitResult) {
  const account = isPlainObject(accountResult?.account)
    ? accountResult.account
    : null;
  if (!account) {
    return errorSnapshot(
      "codex",
      "disconnected",
      "CODEX_NOT_AUTHENTICATED",
    );
  }

  const selectedRateLimit = chooseCodexRateLimit(rateLimitResult);
  const quotas = {};
  classifyCodexWindow(selectedRateLimit?.primary, quotas);
  classifyCodexWindow(selectedRateLimit?.secondary, quotas);

  let plan = null;
  if (typeof account.planType === "string") {
    plan = account.planType;
  } else if (typeof selectedRateLimit?.planType === "string") {
    plan = selectedRateLimit.planType;
  } else if (account.type === "apiKey") {
    plan = "apiKey";
  } else if (account.type === "amazonBedrock") {
    plan = "amazonBedrock";
  }

  return {
    provider: "codex",
    connected: true,
    plan,
    status: "connected",
    quotas,
    contextTokens: null,
    lastUpdatedAt: new Date().toISOString(),
    authVerifiedAt: null,
    usageSource: "app-server",
    usageErrorCode: null,
    errorCode: null,
  };
}

function normalizeClaudeSnapshot(auth, storedSnapshot, usageState = {}) {
  if (!auth.loggedIn) {
    return errorSnapshot(
      "claude",
      "disconnected",
      "CLAUDE_NOT_AUTHENTICATED",
    );
  }

  const quotas = {};
  if (isPlainObject(storedSnapshot?.fiveHour)) {
    const quota = normalizeQuota(
      storedSnapshot.fiveHour.usedPercent,
      storedSnapshot.fiveHour.resetsAt,
    );
    if (quota && quotaWindowIsCurrent(quota)) quotas.fiveHour = quota;
  }
  if (isPlainObject(storedSnapshot?.weekly)) {
    const quota = normalizeQuota(
      storedSnapshot.weekly.usedPercent,
      storedSnapshot.weekly.resetsAt,
    );
    if (quota && quotaWindowIsCurrent(quota)) quotas.weekly = quota;
  }

  return {
    provider: "claude",
    connected: true,
    plan:
      typeof auth.subscriptionType === "string"
        ? auth.subscriptionType
        : null,
    status: "connected",
    quotas,
    contextTokens: normalizeContextTokens(storedSnapshot?.contextTokens),
    lastUpdatedAt: normalizeIso(storedSnapshot?.updatedAt),
    authVerifiedAt: normalizeIso(auth.verifiedAt),
    usageSource:
      usageState.source === "oauth"
        ? "oauth"
        : usageState.source === "local"
          ? "local"
          : null,
    usageErrorCode:
      typeof usageState.errorCode === "string"
        ? usageState.errorCode
        : null,
    matchesGlobalAccount: usageState.matchesGlobalAccount === true,
    errorCode: null,
  };
}

function parseJsonText(value) {
  return JSON.parse(String(value).replace(/^\uFEFF/, ""));
}

function readJsonFile(filePath, fallback) {
  try {
    return parseJsonText(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Best effort cleanup; the destination was never partially written.
    }
  }
}

function sanitizeManagedLabel(value, provider) {
  const sanitized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 40);
  return sanitized || (provider === "claude" ? "Claude" : "Codex");
}

function normalizeManagedAccount(value) {
  const allowedKeys = new Set(["id", "provider", "label", "createdAt"]);
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !PROVIDERS.has(value.provider) ||
    typeof value.label !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const createdAt = normalizeIso(value.createdAt);
  if (!createdAt) return null;
  const label = sanitizeManagedLabel(value.label, value.provider);
  return {
    id: value.id.toLowerCase(),
    provider: value.provider,
    label,
    createdAt,
  };
}

function withManagedIdentity(snapshot, account) {
  return {
    ...snapshot,
    accountId: account.id,
    displayName: account.label,
    managed: true,
  };
}

function connectingManagedSnapshot(account) {
  return withManagedIdentity(
    connectingSnapshot(account.provider),
    account,
  );
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function managedChildEnvironment(provider, profilePath) {
  const environment = { ...process.env };
  const sensitivePatterns =
    provider === "codex"
      ? [
          /^OPENAI_/i,
          /^AZURE_OPENAI_/i,
          /^CODEX_/i,
          /^CONNECTORS_TOKEN$/i,
          /^(?:GH|GITHUB)_TOKEN$/i,
          /^GITHUB_PERSONAL_ACCESS_TOKEN$/i,
        ]
      : [
          /^ANTHROPIC_/i,
          /^CLAUDE_/i,
          /^(?:AWS|GOOGLE|VERTEX|AZURE)_/i,
          /^CLOUD_ML_REGION$/i,
        ];
  for (const key of Object.keys(environment)) {
    if (sensitivePatterns.some((pattern) => pattern.test(key))) {
      delete environment[key];
    }
  }
  if (provider === "codex") {
    environment.CODEX_HOME = profilePath;
  } else {
    environment.CLAUDE_CONFIG_DIR = profilePath;
  }
  return environment;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function isSafeLoginUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com") ||
      host === "openai.com" ||
      host.endsWith(".openai.com")
    );
  } catch {
    return false;
  }
}

function hasPortableExecutableHeader(filePath) {
  let descriptor;
  try {
    const resolvedPath = fs.realpathSync(filePath);
    if (resolvedPath.toLowerCase().includes(`${path.sep}windowsapps${path.sep}`)) {
      return false;
    }
    if (path.extname(resolvedPath).toLowerCase() !== ".exe") return false;
    descriptor = fs.openSync(resolvedPath, "r");
    const header = Buffer.alloc(2);
    return fs.readSync(descriptor, header, 0, 2, 0) === 2 &&
      header[0] === 0x4d &&
      header[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore a close failure for a read-only validation handle.
      }
    }
  }
}

function uniqueExistingExecutable(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (hasPortableExecutableHeader(normalized)) {
      return fs.realpathSync(normalized);
    }
  }
  return null;
}

function npmGlobalRoots() {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm"));
  if (process.env.npm_config_prefix) roots.push(process.env.npm_config_prefix);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function pathExecutableCandidates(executableName) {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory.replace(/^"|"$/g, ""), executableName));
}

function resolveCodexExecutable() {
  const architecture =
    process.arch === "arm64"
      ? {
          packageName: "codex-win32-arm64",
          triple: "aarch64-pc-windows-msvc",
        }
      : {
          packageName: "codex-win32-x64",
          triple: "x86_64-pc-windows-msvc",
        };
  const candidates = [];

  for (const npmRoot of npmGlobalRoots()) {
    candidates.push(
      path.join(
        npmRoot,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        architecture.packageName,
        "vendor",
        architecture.triple,
        "bin",
        "codex.exe",
      ),
      path.join(
        npmRoot,
        "node_modules",
        "@openai",
        architecture.packageName,
        "vendor",
        architecture.triple,
        "bin",
        "codex.exe",
      ),
    );
  }

  // Native npm payloads are preferred. PATH is only a fallback, and Store
  // aliases under WindowsApps are rejected by executable validation.
  candidates.push(...pathExecutableCandidates("codex.exe"));
  return uniqueExistingExecutable(candidates);
}

function resolveClaudeExecutable() {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const candidates = [];

  for (const npmRoot of npmGlobalRoots()) {
    candidates.push(
      path.join(
        npmRoot,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
      path.join(
        npmRoot,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "node_modules",
        "@anthropic-ai",
        `claude-code-win32-${architecture}`,
        "bin",
        "claude.exe",
      ),
    );
  }

  if (process.env.USERPROFILE) {
    candidates.push(
      path.join(process.env.USERPROFILE, ".local", "bin", "claude.exe"),
    );
  }
  candidates.push(...pathExecutableCandidates("claude.exe"));
  return uniqueExistingExecutable(candidates);
}

function terminateProcessTree(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const taskkillPath = path.join(systemRoot, "System32", "taskkill.exe");
    try {
      const killer = spawn(
        taskkillPath,
        ["/pid", String(child.pid), "/T", "/F"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.once("error", () => {
        try {
          child.kill();
        } catch {
          // The process already exited.
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill();
      } catch {
        // The process already exited.
      }
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

class IntegrationService {
  constructor(electronApp) {
    this.app = electronApp;
    this.activeChildren = new Set();
    this.refreshesInFlight = new Map();
    this.claudeUsageCache = new Map();
    this.claudeUsageRequests = new Map();
    this.claudeTranscriptCache = new Map();
    this.globalClaudeAuthCache = null;
    this.globalClaudeAuthRequest = null;
    this.snapshotListener = null;
    this.lastClaudeAuth = null;
    this.claudeSnapshotWatcher = null;
    this.claudeWatchDebounceTimer = null;
    this.claudeWatchRetryTimer = null;
    this.claudeLoginProcess = null;
    this.managedSnapshotWatcher = null;
    this.managedWatchDebounceTimers = new Map();
    this.managedLoginProcesses = new Map();
    this.managedOpenProcesses = new Map();
    this.managedAccountsBeingRemoved = new Set();
    this.openExternal = null;
    this.shuttingDown = false;
    this.integrationsDirectory = path.join(
      this.app.getPath("userData"),
      "integrations",
    );
    this.connectionsPath = path.join(
      this.integrationsDirectory,
      CONNECTIONS_FILE_NAME,
    );
    this.claudeSnapshotPath = path.join(
      this.integrationsDirectory,
      CLAUDE_SNAPSHOT_FILE_NAME,
    );
    this.installedClaudeBridgePath = path.join(
      this.integrationsDirectory,
      CLAUDE_BRIDGE_FILE_NAME,
    );
    this.sourceClaudeBridgePath = path.join(
      __dirname,
      CLAUDE_BRIDGE_FILE_NAME,
    );
    this.managedAccountsPath = path.join(
      this.integrationsDirectory,
      MANAGED_ACCOUNTS_FILE_NAME,
    );
    this.managedProfilesRoot = path.join(
      this.integrationsDirectory,
      "managed-profiles",
    );
    this.managedSnapshotsRoot = path.join(
      this.integrationsDirectory,
      "managed-snapshots",
    );
    this.removedProfilesRoot = path.join(
      this.integrationsDirectory,
      "removed-profiles",
    );
    this.managedSessionsRoot = path.join(
      this.integrationsDirectory,
      "managed-sessions",
    );
  }

  setSnapshotListener(listener) {
    this.snapshotListener =
      typeof listener === "function" ? listener : null;
    if (this.readConnections().claude) {
      this.startClaudeSnapshotWatcher();
    }
    this.startManagedSnapshotWatcher();
  }

  setOpenExternal(listener) {
    this.openExternal = typeof listener === "function" ? listener : null;
  }

  emitSnapshot(snapshot) {
    try {
      this.snapshotListener?.(snapshot);
    } catch {
      // Renderer delivery is best effort. The next status read still returns
      // the sanitized snapshot from disk.
    }
  }

  deduplicateRefresh(key, operation) {
    const existing = this.refreshesInFlight.get(key);
    if (existing) return existing;

    const task = Promise.resolve().then(operation);
    const tracked = task.finally(() => {
      if (this.refreshesInFlight.get(key) === tracked) {
        this.refreshesInFlight.delete(key);
      }
    });
    this.refreshesInFlight.set(key, tracked);
    return tracked;
  }

  scheduleClaudeWatchRetry() {
    if (this.shuttingDown || this.claudeWatchRetryTimer !== null) return;
    this.claudeWatchRetryTimer = setTimeout(() => {
      this.claudeWatchRetryTimer = null;
      if (this.readConnections().claude) {
        this.startClaudeSnapshotWatcher();
      }
    }, 1_000);
  }

  startClaudeSnapshotWatcher() {
    if (
      this.shuttingDown ||
      this.claudeSnapshotWatcher ||
      !this.readConnections().claude
    ) {
      return;
    }

    try {
      fs.mkdirSync(this.integrationsDirectory, { recursive: true });
      const watcher = fs.watch(
        this.integrationsDirectory,
        { persistent: false },
        (_eventType, filename) => {
          const changedFile = filename ? path.basename(String(filename)) : "";
          if (
            changedFile &&
            changedFile.toLowerCase() !==
              CLAUDE_SNAPSHOT_FILE_NAME.toLowerCase()
          ) {
            return;
          }

          if (this.claudeWatchDebounceTimer !== null) {
            clearTimeout(this.claudeWatchDebounceTimer);
          }
          this.claudeWatchDebounceTimer = setTimeout(() => {
            this.claudeWatchDebounceTimer = null;
            void this.publishClaudeSnapshotChange();
          }, CLAUDE_WATCH_DEBOUNCE_MS);
        },
      );
      this.claudeSnapshotWatcher = watcher;
      watcher.once("error", () => {
        if (this.claudeSnapshotWatcher === watcher) {
          this.claudeSnapshotWatcher = null;
        }
        try {
          watcher.close();
        } catch {
          // The watcher may already be closed after an error.
        }
        this.scheduleClaudeWatchRetry();
      });
    } catch {
      this.scheduleClaudeWatchRetry();
    }
  }

  stopClaudeSnapshotWatcher() {
    if (this.claudeWatchDebounceTimer !== null) {
      clearTimeout(this.claudeWatchDebounceTimer);
      this.claudeWatchDebounceTimer = null;
    }
    if (this.claudeWatchRetryTimer !== null) {
      clearTimeout(this.claudeWatchRetryTimer);
      this.claudeWatchRetryTimer = null;
    }
    if (this.claudeSnapshotWatcher) {
      try {
        this.claudeSnapshotWatcher.close();
      } catch {
        // Best effort shutdown.
      }
      this.claudeSnapshotWatcher = null;
    }
  }

  async publishClaudeSnapshotChange() {
    if (!this.readConnections().claude) return;

    const snapshot = await this.refreshClaude({ requireBridge: false });

    // A disconnect may have completed while a CLI status check was running.
    if (this.readConnections().claude) {
      this.emitSnapshot(snapshot);
    }
  }

  readManagedAccounts() {
    if (!fs.existsSync(this.managedAccountsPath)) return [];
    let stored;
    try {
      stored = parseJsonText(
        fs.readFileSync(this.managedAccountsPath, "utf8"),
      );
    } catch {
      throw integrationError("MANAGED_REGISTRY_INVALID");
    }
    if (
      !Array.isArray(stored) ||
      stored.length > MANAGED_ACCOUNT_LIMIT
    ) {
      throw integrationError("MANAGED_REGISTRY_INVALID");
    }
    const accounts = [];
    const seen = new Set();
    for (const value of stored) {
      const account = normalizeManagedAccount(value);
      if (!account || seen.has(account.id)) {
        throw integrationError("MANAGED_REGISTRY_INVALID");
      }
      seen.add(account.id);
      accounts.push(account);
    }
    return accounts;
  }

  writeManagedAccounts(accounts) {
    const normalized = accounts.map(normalizeManagedAccount);
    if (
      normalized.some((account) => account === null) ||
      normalized.length > MANAGED_ACCOUNT_LIMIT ||
      new Set(normalized.map((account) => account.id)).size !==
        normalized.length
    ) {
      throw integrationError("MANAGED_REGISTRY_INVALID");
    }
    writeJsonAtomic(this.managedAccountsPath, normalized);
  }

  managedAccount(accountId) {
    if (typeof accountId !== "string" || !UUID_PATTERN.test(accountId)) {
      throw integrationError("MANAGED_ACCOUNT_NOT_FOUND");
    }
    const normalizedId = accountId.toLowerCase();
    const account = this.readManagedAccounts().find(
      (candidate) => candidate.id === normalizedId,
    );
    if (!account) throw integrationError("MANAGED_ACCOUNT_NOT_FOUND");
    return account;
  }

  findManagedAccountSafe(accountId) {
    try {
      return (
        this.readManagedAccounts().find(
          (candidate) => candidate.id === accountId,
        ) || null
      );
    } catch {
      return null;
    }
  }

  managedProfilePath(account) {
    const profilePath = path.join(
      this.managedProfilesRoot,
      account.provider,
      account.id,
    );
    if (!isPathInside(this.managedProfilesRoot, profilePath)) {
      throw integrationError("MANAGED_PATH_INVALID");
    }
    return profilePath;
  }

  managedSnapshotPath(account) {
    const snapshotPath = path.join(
      this.managedSnapshotsRoot,
      `${account.id}.json`,
    );
    if (!isPathInside(this.managedSnapshotsRoot, snapshotPath)) {
      throw integrationError("MANAGED_PATH_INVALID");
    }
    return snapshotPath;
  }

  managedSessionPath(account) {
    const sessionPath = path.join(
      this.managedSessionsRoot,
      `${account.id}.json`,
    );
    if (!isPathInside(this.managedSessionsRoot, sessionPath)) {
      throw integrationError("MANAGED_PATH_INVALID");
    }
    return sessionPath;
  }

  clearManagedSessionMarker(account, expectedProcessId = null) {
    const sessionPath = this.managedSessionPath(account);
    try {
      if (
        expectedProcessId !== null &&
        fs.existsSync(sessionPath)
      ) {
        const stored = parseJsonText(fs.readFileSync(sessionPath, "utf8"));
        if (stored?.processId !== expectedProcessId) return;
      }
      if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    } catch {
      // A stale marker only blocks removal until it can be checked safely.
    }
  }

  hasManagedOpenSession(account) {
    const tracked = this.managedOpenProcesses.get(account.id);
    if (
      tracked &&
      tracked.exitCode === null &&
      tracked.signalCode === null &&
      isProcessAlive(tracked.pid)
    ) {
      return true;
    }
    if (tracked) this.managedOpenProcesses.delete(account.id);

    const sessionPath = this.managedSessionPath(account);
    if (!fs.existsSync(sessionPath)) return false;
    try {
      const stored = parseJsonText(fs.readFileSync(sessionPath, "utf8"));
      if (
        !isPlainObject(stored) ||
        !Number.isInteger(stored.processId) ||
        stored.processId <= 0
      ) {
        throw integrationError("MANAGED_SESSION_INVALID");
      }
      if (isProcessAlive(stored.processId)) return true;
      this.clearManagedSessionMarker(account, stored.processId);
      return false;
    } catch (error) {
      if (error?.code === "MANAGED_SESSION_INVALID") throw error;
      throw integrationError("MANAGED_SESSION_INVALID");
    }
  }

  managedClaudeStatusLineCommand(account) {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const quote = (value) => `"${String(value).replace(/"/g, '`"')}"`;
    const shellPath = (value) => String(value).replace(/\\/g, "/");
    return [
      quote(shellPath(powershellPath)),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      quote(shellPath(this.installedClaudeBridgePath)),
      "-SnapshotPath",
      quote(shellPath(this.managedSnapshotPath(account))),
    ].join(" ");
  }

  ensureManagedClaudeBridge(account) {
    const profilePath = this.managedProfilePath(account);
    const settingsPath = path.join(profilePath, "settings.json");
    if (!isPathInside(profilePath, settingsPath)) {
      throw integrationError("MANAGED_PATH_INVALID");
    }

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = parseJsonText(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        throw integrationError("CLAUDE_SETTINGS_INVALID");
      }
      if (!isPlainObject(settings)) {
        throw integrationError("CLAUDE_SETTINGS_INVALID");
      }
    }

    const command = this.managedClaudeStatusLineCommand(account);
    if (
      settings.statusLine !== undefined &&
      !(
        isPlainObject(settings.statusLine) &&
        settings.statusLine.type === "command" &&
        commandsMatch(settings.statusLine.command, command)
      )
    ) {
      throw integrationError("CLAUDE_STATUSLINE_CONFLICT");
    }

    try {
      fs.mkdirSync(profilePath, { recursive: true });
      fs.mkdirSync(this.managedSnapshotsRoot, { recursive: true });
      fs.mkdirSync(this.integrationsDirectory, { recursive: true });
      const bridgeNeedsUpdate =
        !fs.existsSync(this.installedClaudeBridgePath) ||
        !fs
          .readFileSync(this.installedClaudeBridgePath)
          .equals(fs.readFileSync(this.sourceClaudeBridgePath));
      if (bridgeNeedsUpdate) {
        fs.copyFileSync(
          this.sourceClaudeBridgePath,
          this.installedClaudeBridgePath,
        );
      }
      if (
        settings.statusLine === undefined ||
        settings.statusLine.refreshInterval !==
          CLAUDE_STATUSLINE_REFRESH_SECONDS
      ) {
        settings.statusLine = {
          ...(isPlainObject(settings.statusLine) ? settings.statusLine : {}),
          type: "command",
          command,
          refreshInterval: CLAUDE_STATUSLINE_REFRESH_SECONDS,
        };
        writeJsonAtomic(settingsPath, settings);
      }
    } catch (error) {
      if (
        error?.code === "CLAUDE_STATUSLINE_CONFLICT" ||
        error?.code === "CLAUDE_SETTINGS_INVALID"
      ) {
        throw error;
      }
      throw integrationError("CLAUDE_BRIDGE_INSTALL_FAILED");
    }
  }

  startManagedSnapshotWatcher() {
    if (this.shuttingDown || this.managedSnapshotWatcher) return;
    try {
      fs.mkdirSync(this.managedSnapshotsRoot, { recursive: true });
      const watcher = fs.watch(
        this.managedSnapshotsRoot,
        { persistent: false },
        (_eventType, filename) => {
          const baseName = filename ? path.basename(String(filename)) : "";
          const match = /^([0-9a-f-]{36})\.json$/i.exec(baseName);
          if (!match || !UUID_PATTERN.test(match[1])) return;
          const accountId = match[1].toLowerCase();
          const account = this.findManagedAccountSafe(accountId);
          if (!account || account.provider !== "claude") return;
          const existing = this.managedWatchDebounceTimers.get(accountId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            this.managedWatchDebounceTimers.delete(accountId);
            void this.refreshManagedIntegration(accountId).then((snapshot) => {
              if (this.findManagedAccountSafe(accountId)) {
                this.emitSnapshot(snapshot);
              }
            }).catch(() => {
              // The account may have been removed while refresh was queued.
            });
          }, CLAUDE_WATCH_DEBOUNCE_MS);
          this.managedWatchDebounceTimers.set(accountId, timer);
        },
      );
      this.managedSnapshotWatcher = watcher;
      watcher.once("error", () => {
        if (this.managedSnapshotWatcher === watcher) {
          this.managedSnapshotWatcher = null;
        }
        try {
          watcher.close();
        } catch {
          // The watcher may already be closed.
        }
        if (!this.shuttingDown) {
          setTimeout(() => this.startManagedSnapshotWatcher(), 1_000).unref?.();
        }
      });
    } catch {
      if (!this.shuttingDown) {
        setTimeout(() => this.startManagedSnapshotWatcher(), 1_000).unref?.();
      }
    }
  }

  stopManagedSnapshotWatcher() {
    for (const timer of this.managedWatchDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.managedWatchDebounceTimers.clear();
    if (this.managedSnapshotWatcher) {
      try {
        this.managedSnapshotWatcher.close();
      } catch {
        // Best effort shutdown.
      }
      this.managedSnapshotWatcher = null;
    }
  }

  readConnections() {
    const stored = readJsonFile(this.connectionsPath, {});
    return {
      codex: stored?.codex === true,
      claude: stored?.claude === true,
    };
  }

  writeConnection(provider, enabled) {
    const connections = this.readConnections();
    connections[provider] = Boolean(enabled);
    writeJsonAtomic(this.connectionsPath, connections);
  }

  async runNative(executablePath, args, errorPrefix, options = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let child;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child) this.activeChildren.delete(child);
        callback();
      };

      try {
        child = spawn(executablePath, args, {
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          ...(options.env ? { env: options.env } : {}),
        });
        this.activeChildren.add(child);
      } catch {
        reject(integrationError(`${errorPrefix}_PROCESS_ERROR`));
        return;
      }

      const timeout = setTimeout(() => {
        terminateProcessTree(child);
        finish(() => reject(integrationError(`${errorPrefix}_TIMEOUT`)));
      }, PROCESS_TIMEOUT_MS);

      const appendOutput = (current, chunk) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
          terminateProcessTree(child);
          finish(() =>
            reject(integrationError(`${errorPrefix}_PROCESS_ERROR`)),
          );
          return null;
        }
        return next;
      };

      child.stdout.on("data", (chunk) => {
        const next = appendOutput(stdout, chunk);
        if (next !== null) stdout = next;
      });
      child.stderr.on("data", (chunk) => {
        const next = appendOutput(stderr, chunk);
        if (next !== null) stderr = next;
      });
      child.once("error", () => {
        finish(() =>
          reject(integrationError(`${errorPrefix}_PROCESS_ERROR`)),
        );
      });
      child.once("close", (exitCode) => {
        finish(() => resolve({ exitCode, stdout, stderr }));
      });
    });
  }

  async readClaudeAuth(options = {}) {
    const executablePath = resolveClaudeExecutable();
    if (!executablePath) throw integrationError("CLAUDE_NOT_FOUND");

    const result = await this.runNative(
      executablePath,
      ["auth", "status", "--json"],
      "CLAUDE",
      options,
    );

    let parsed;
    try {
      parsed = parseJsonText(result.stdout.trim());
    } catch {
      throw integrationError("CLAUDE_AUTH_ERROR");
    }

    const subscriptionType =
      typeof parsed?.subscriptionType === "string"
        ? parsed.subscriptionType.trim().toLowerCase()
        : null;
    if (parsed?.loggedIn === true) {
      if (
        typeof parsed?.apiKeySource === "string" &&
        parsed.apiKeySource.trim()
      ) {
        throw integrationError("CLAUDE_API_MODE_UNSUPPORTED");
      }
      if (subscriptionType !== "pro" && subscriptionType !== "max") {
        throw integrationError("CLAUDE_SUBSCRIPTION_UNSUPPORTED");
      }
      if (
        parsed?.authMethod !== "claude.ai" ||
        parsed?.apiProvider !== "firstParty"
      ) {
        throw integrationError("CLAUDE_SUBSCRIPTION_UNSUPPORTED");
      }
    }

    // The opaque fingerprint is used only in memory to recognize the same
    // account across isolated Claude profiles. Raw email/org/login fields are
    // never persisted, logged, or returned to the renderer.
    const auth = {
      loggedIn: parsed?.loggedIn === true,
      subscriptionType,
      verifiedAt: new Date().toISOString(),
      accountFingerprint:
        parsed?.loggedIn === true
          ? claudeAccountFingerprint(parsed)
          : null,
    };
    if (result.exitCode !== 0 && auth.loggedIn) {
      throw integrationError("CLAUDE_AUTH_ERROR");
    }
    return auth;
  }

  claudeConfigDirectory(options = {}) {
    const configured =
      isPlainObject(options.env) &&
      typeof options.env.CLAUDE_CONFIG_DIR === "string" &&
      options.env.CLAUDE_CONFIG_DIR.trim()
        ? options.env.CLAUDE_CONFIG_DIR
        : process.env.CLAUDE_CONFIG_DIR;
    return configured
      ? path.resolve(configured)
      : path.join(os.homedir(), ".claude");
  }

  readClaudeOAuthCredential(options = {}) {
    const credentialsPath = path.join(
      this.claudeConfigDirectory(options),
      ".credentials.json",
    );
    let stored;
    try {
      const stat = fs.statSync(credentialsPath);
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > CLAUDE_CREDENTIALS_LIMIT_BYTES
      ) {
        throw integrationError("CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE");
      }
      stored = parseJsonText(fs.readFileSync(credentialsPath, "utf8"));
    } catch (error) {
      if (error?.code === "CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE") {
        throw error;
      }
      throw integrationError("CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE");
    }
    const accessToken = stored?.claudeAiOauth?.accessToken;
    if (
      typeof accessToken !== "string" ||
      !accessToken.trim() ||
      accessToken.length > 64 * 1024
    ) {
      throw integrationError("CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE");
    }
    return accessToken.trim();
  }

  requestClaudeOAuthUsage(accessToken) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let responseBytes = 0;
      const chunks = [];
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };
      let request;
      try {
        request = https.request(
          {
            protocol: "https:",
            hostname: CLAUDE_USAGE_HOST,
            port: 443,
            method: "GET",
            path: CLAUDE_USAGE_PATH,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": CLAUDE_USAGE_USER_AGENT,
            },
          },
          (response) => {
            response.on("data", (chunk) => {
              if (settled) return;
              responseBytes += chunk.length;
              if (responseBytes > CLAUDE_USAGE_RESPONSE_LIMIT_BYTES) {
                response.destroy();
                finish(() =>
                  reject(
                    integrationError("CLAUDE_USAGE_RESPONSE_INVALID"),
                  ),
                );
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            response.once("error", () => {
              finish(() =>
                reject(integrationError("CLAUDE_USAGE_NETWORK_ERROR")),
              );
            });
            response.once("end", () => {
              if (settled) return;
              const statusCode = Number(response.statusCode);
              if (statusCode === 401 || statusCode === 403) {
                finish(() =>
                  reject(integrationError("CLAUDE_USAGE_AUTH_ERROR")),
                );
                return;
              }
              if (statusCode === 429) {
                finish(() =>
                  reject(integrationError("CLAUDE_USAGE_RATE_LIMITED")),
                );
                return;
              }
              if (statusCode !== 200) {
                finish(() =>
                  reject(integrationError("CLAUDE_USAGE_NETWORK_ERROR")),
                );
                return;
              }
              let parsed;
              try {
                parsed = parseJsonText(
                  Buffer.concat(chunks).toString("utf8"),
                );
              } catch {
                finish(() =>
                  reject(
                    integrationError("CLAUDE_USAGE_RESPONSE_INVALID"),
                  ),
                );
                return;
              }
              finish(() => resolve(parsed));
            });
          },
        );
      } catch {
        reject(integrationError("CLAUDE_USAGE_NETWORK_ERROR"));
        return;
      }
      request.setTimeout(PROCESS_TIMEOUT_MS, () => {
        request.destroy();
        finish(() =>
          reject(integrationError("CLAUDE_USAGE_NETWORK_ERROR")),
        );
      });
      request.once("error", () => {
        finish(() =>
          reject(integrationError("CLAUDE_USAGE_NETWORK_ERROR")),
        );
      });
      request.end();
    });
  }

  async readClaudeOAuthUsage(auth, options = {}) {
    const now = Date.now();
    const identityCacheKey =
      typeof auth?.accountFingerprint === "string"
        ? `account:${auth.accountFingerprint}`
        : null;
    const identityCached = identityCacheKey
      ? this.claudeUsageCache.get(identityCacheKey) ?? null
      : null;
    if (identityCached && identityCached.expiresAt > now) {
      return { usage: identityCached.usage, errorCode: null };
    }

    let accessToken;
    try {
      accessToken = this.readClaudeOAuthCredential(options);
    } catch (error) {
      return {
        usage: identityCached?.usage ?? null,
        errorCode:
          typeof error?.code === "string"
            ? error.code
            : "CLAUDE_USAGE_CREDENTIALS_UNAVAILABLE",
      };
    }

    const tokenFingerprint = crypto
      .createHash("sha256")
      .update(accessToken, "utf8")
      .digest("hex");
    const cacheKey = identityCacheKey ?? `token:${tokenFingerprint}`;
    const cached =
      this.claudeUsageCache.get(cacheKey) ?? identityCached ?? null;
    if (cached && cached.expiresAt > now) {
      return { usage: cached.usage, errorCode: null };
    }

    let request = this.claudeUsageRequests.get(cacheKey);
    if (!request) {
      request = this.requestClaudeOAuthUsage(accessToken)
        .then((value) =>
          normalizeClaudeOAuthUsage(value, new Date().toISOString()),
        )
        .then((usage) => {
          this.claudeUsageCache.set(cacheKey, {
            usage,
            expiresAt: Date.now() + CLAUDE_USAGE_CACHE_MS,
          });
          if (this.claudeUsageCache.size > MANAGED_ACCOUNT_LIMIT * 2) {
            const oldestKey = this.claudeUsageCache.keys().next().value;
            if (oldestKey !== undefined) {
              this.claudeUsageCache.delete(oldestKey);
            }
          }
          return usage;
        });
      this.claudeUsageRequests.set(cacheKey, request);
      request.finally(() => {
        if (this.claudeUsageRequests.get(cacheKey) === request) {
          this.claudeUsageRequests.delete(cacheKey);
        }
      }).catch(() => {
        // The original caller receives the sanitized failure below.
      });
    }

    try {
      return { usage: await request, errorCode: null };
    } catch (error) {
      return {
        usage: cached?.usage ?? null,
        errorCode:
          typeof error?.code === "string" &&
          error.code.startsWith("CLAUDE_USAGE_")
            ? error.code
            : "CLAUDE_USAGE_NETWORK_ERROR",
      };
    }
  }

  findLatestClaudeTranscript(options = {}) {
    const projectsRoot = path.join(
      this.claudeConfigDirectory(options),
      "projects",
    );
    let newest = null;
    try {
      const projectDirectories = fs
        .readdirSync(projectsRoot, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
        )
        .slice(0, 5_000);
      for (const directory of projectDirectories) {
        const directoryPath = path.join(projectsRoot, directory.name);
        const files = fs
          .readdirSync(directoryPath, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isFile() &&
              !entry.isSymbolicLink() &&
              entry.name.toLowerCase().endsWith(".jsonl"),
          );
        for (const file of files) {
          const filePath = path.join(directoryPath, file.name);
          const stat = fs.statSync(filePath);
          if (
            !newest ||
            stat.mtimeMs > newest.mtimeMs ||
            (stat.mtimeMs === newest.mtimeMs && stat.size > newest.size)
          ) {
            newest = {
              filePath,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            };
          }
        }
      }
    } catch {
      return null;
    }
    return newest;
  }

  readLatestClaudeContextTokens(options = {}) {
    const configDirectory = this.claudeConfigDirectory(options);
    const cacheKey =
      process.platform === "win32"
        ? configDirectory.toLowerCase()
        : configDirectory;
    const now = Date.now();
    const cached = this.claudeTranscriptCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.contextTokens;

    const latest = this.findLatestClaudeTranscript(options);
    const contextTokens = latest
      ? extractLatestClaudeContextTokens(latest.filePath)
      : null;
    this.claudeTranscriptCache.set(cacheKey, {
      contextTokens,
      expiresAt: now + CLAUDE_AUTH_CACHE_MS,
    });
    if (this.claudeTranscriptCache.size > MANAGED_ACCOUNT_LIMIT * 2) {
      const oldestKey = this.claudeTranscriptCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.claudeTranscriptCache.delete(oldestKey);
      }
    }
    return contextTokens;
  }

  async readCachedGlobalClaudeAuth() {
    const now = Date.now();
    if (
      this.globalClaudeAuthCache &&
      this.globalClaudeAuthCache.expiresAt > now
    ) {
      return this.globalClaudeAuthCache.auth;
    }
    if (this.globalClaudeAuthRequest) return this.globalClaudeAuthRequest;

    const request = this.readClaudeAuth()
      .then((auth) => {
        this.globalClaudeAuthCache = {
          auth,
          expiresAt: Date.now() + CLAUDE_AUTH_CACHE_MS,
        };
        return auth;
      })
      .finally(() => {
        if (this.globalClaudeAuthRequest === request) {
          this.globalClaudeAuthRequest = null;
        }
      });
    this.globalClaudeAuthRequest = request;
    return request;
  }

  async collectClaudeUsageSnapshot(
    auth,
    storedSnapshot,
    options = {},
  ) {
    const oauthState = await this.readClaudeOAuthUsage(auth, options);
    let contextTokens = this.readLatestClaudeContextTokens(options);
    let matchesGlobalAccount = false;

    if (
      options.managed === true &&
      typeof auth?.accountFingerprint === "string"
    ) {
      try {
        const globalAuth = await this.readCachedGlobalClaudeAuth();
        if (
          globalAuth.loggedIn &&
          globalAuth.accountFingerprint === auth.accountFingerprint
        ) {
          matchesGlobalAccount = true;
          contextTokens = newestContextTokens(
            contextTokens,
            this.readLatestClaudeContextTokens(),
          );
        }
      } catch {
        // The isolated profile remains usable if the global profile is absent.
      }
    }

    const merged = mergeClaudeUsageSnapshot(
      storedSnapshot,
      oauthState.usage,
      contextTokens,
    );
    const hasLocalUsage = Boolean(
      merged.fiveHour ||
        merged.weekly ||
        merged.contextTokens,
    );
    return {
      storedSnapshot: merged,
      usageState: {
        source: oauthState.usage
          ? "oauth"
          : hasLocalUsage
            ? "local"
            : null,
        errorCode: oauthState.errorCode,
        matchesGlobalAccount,
      },
    };
  }

  async readCodexAccountAndRateLimits(options = {}) {
    const executablePath = resolveCodexExecutable();
    if (!executablePath) throw integrationError("CODEX_NOT_FOUND");

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let stdoutBuffer = "";
      let accountResult;
      let rateLimitResult;
      let initialized = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child) {
          this.activeChildren.delete(child);
          try {
            child.stdin.end();
          } catch {
            // The child already closed its input.
          }
          terminateProcessTree(child);
        }
        callback();
      };

      const fail = (code) =>
        finish(() => reject(integrationError(code)));

      const send = (message) => {
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
        } catch {
          fail("CODEX_PROTOCOL_ERROR");
        }
      };

      const handleMessage = (message) => {
        if (!isPlainObject(message) || !Object.hasOwn(message, "id")) return;
        if (message.error) {
          if (options.managed && message.id === 3) {
            // A fresh isolated profile has no rate-limit endpoint until the
            // ChatGPT login completes. account/read still determines the
            // disconnected state without reading any credential file.
            rateLimitResult = {};
            if (
              accountResult !== undefined &&
              rateLimitResult !== undefined
            ) {
              finish(() => resolve({ accountResult, rateLimitResult }));
            }
            return;
          }
          fail("CODEX_PROTOCOL_ERROR");
          return;
        }

        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ method: "initialized", params: {} });
          send({
            method: "account/read",
            id: 2,
            params: { refreshToken: false },
          });
          send({ method: "account/rateLimits/read", id: 3 });
          return;
        }

        if (message.id === 2) accountResult = message.result;
        if (message.id === 3) rateLimitResult = message.result;
        if (accountResult !== undefined && rateLimitResult !== undefined) {
          finish(() => resolve({ accountResult, rateLimitResult }));
        }
      };

      try {
        child = spawn(
          executablePath,
          [
            "app-server",
            ...(options.managed
              ? ["-c", 'cli_auth_credentials_store="file"']
              : []),
            "--listen",
            "stdio://",
          ],
          {
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            ...(options.env ? { env: options.env } : {}),
          },
        );
        this.activeChildren.add(child);
      } catch {
        reject(integrationError("CODEX_PROCESS_ERROR"));
        return;
      }

      const timeout = setTimeout(
        () => fail("CODEX_TIMEOUT"),
        PROCESS_TIMEOUT_MS,
      );

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        if (
          Buffer.byteLength(stdoutBuffer, "utf8") >
          MAX_PROCESS_OUTPUT_BYTES
        ) {
          fail("CODEX_PROTOCOL_ERROR");
          return;
        }

        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0 && !settled) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            try {
              handleMessage(JSON.parse(line));
            } catch {
              fail("CODEX_PROTOCOL_ERROR");
              return;
            }
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr.on("data", () => {
        // Configuration warnings can be emitted here. Never expose raw stderr
        // because it may contain local filesystem or account details.
      });
      child.once("error", () => fail("CODEX_PROCESS_ERROR"));
      child.once("close", () => {
        if (!settled) fail("CODEX_PROCESS_ERROR");
      });

      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "tokencat",
            title: "TokenCat",
            version: this.app.getVersion(),
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: [],
          },
        },
      });
    });
  }

  claudeStatusLineCommand() {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const quote = (value) => `"${String(value).replace(/"/g, '`"')}"`;
    const shellPath = (value) => String(value).replace(/\\/g, "/");
    return [
      quote(shellPath(powershellPath)),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      quote(shellPath(this.installedClaudeBridgePath)),
      "-SnapshotPath",
      quote(shellPath(this.claudeSnapshotPath)),
    ].join(" ");
  }

  claudeSettingsPath() {
    const configDirectory = process.env.CLAUDE_CONFIG_DIR
      ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
      : path.join(os.homedir(), ".claude");
    return path.join(configDirectory, "settings.json");
  }

  readClaudeSettings() {
    const settingsPath = this.claudeSettingsPath();
    if (!fs.existsSync(settingsPath)) return {};
    try {
      const parsed = parseJsonText(fs.readFileSync(settingsPath, "utf8"));
      if (!isPlainObject(parsed)) {
        throw integrationError("CLAUDE_SETTINGS_INVALID");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "CLAUDE_SETTINGS_INVALID") throw error;
      throw integrationError("CLAUDE_SETTINGS_INVALID");
    }
  }

  inspectClaudeBridge(settings) {
    const statusLine = settings?.statusLine;
    if (statusLine === undefined) return "missing";
    if (
      isPlainObject(statusLine) &&
      statusLine.type === "command" &&
      commandsMatch(statusLine.command, this.claudeStatusLineCommand())
    ) {
      return "installed";
    }
    return "conflict";
  }

  clearClaudeSnapshot() {
    for (const filePath of [
      this.claudeSnapshotPath,
      `${this.claudeSnapshotPath}.lock`,
    ]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // A status-line process may still own the lock briefly. Its atomic
        // write remains safe, and the disconnected snapshot is never exposed.
      }
    }
  }

  installClaudeBridge() {
    const settings = this.readClaudeSettings();
    const state = this.inspectClaudeBridge(settings);
    if (state === "conflict") {
      throw integrationError("CLAUDE_STATUSLINE_CONFLICT");
    }

    try {
      fs.mkdirSync(this.integrationsDirectory, { recursive: true });
      const bridgeNeedsUpdate =
        !fs.existsSync(this.installedClaudeBridgePath) ||
        !fs
          .readFileSync(this.installedClaudeBridgePath)
          .equals(fs.readFileSync(this.sourceClaudeBridgePath));
      if (bridgeNeedsUpdate) {
        fs.copyFileSync(
          this.sourceClaudeBridgePath,
          this.installedClaudeBridgePath,
        );
      }
      if (state !== "installed") {
        this.clearClaudeSnapshot();
      }
      if (
        state !== "installed" ||
        settings.statusLine.refreshInterval !==
          CLAUDE_STATUSLINE_REFRESH_SECONDS
      ) {
        settings.statusLine = {
          ...(isPlainObject(settings.statusLine) ? settings.statusLine : {}),
          type: "command",
          command: this.claudeStatusLineCommand(),
          refreshInterval: CLAUDE_STATUSLINE_REFRESH_SECONDS,
        };
        writeJsonAtomic(this.claudeSettingsPath(), settings);
      }
    } catch (error) {
      if (error?.code === "CLAUDE_STATUSLINE_CONFLICT") throw error;
      throw integrationError("CLAUDE_BRIDGE_INSTALL_FAILED");
    }
  }

  maintainClaudeBridgeIfOwned() {
    try {
      if (
        this.inspectClaudeBridge(this.readClaudeSettings()) === "installed"
      ) {
        this.installClaudeBridge();
        return true;
      }
    } catch {
      // OAuth usage and transcript parsing do not depend on statusLine.
      // Leave malformed or user-owned settings untouched.
    }
    return false;
  }

  removeClaudeBridge() {
    let settings;
    try {
      settings = this.readClaudeSettings();
    } catch (error) {
      return error?.code || "CLAUDE_SETTINGS_INVALID";
    }

    const state = this.inspectClaudeBridge(settings);
    if (state === "conflict") return null;
    if (state === "installed") {
      delete settings.statusLine;
      try {
        writeJsonAtomic(this.claudeSettingsPath(), settings);
        this.clearClaudeSnapshot();
        try {
          if (fs.existsSync(this.installedClaudeBridgePath)) {
            fs.unlinkSync(this.installedClaudeBridgePath);
          }
        } catch {
          // The settings entry is already removed, so the helper is inert.
        }
      } catch {
        return "CLAUDE_BRIDGE_REMOVE_FAILED";
      }
    }
    return null;
  }

  readClaudeRateLimitSnapshot() {
    const stored = readJsonFile(this.claudeSnapshotPath, null);
    if (!isPlainObject(stored)) return null;

    // Reconstruct a strict allowlist so no unexpected bridge data can reach
    // the renderer even if the snapshot file was externally modified.
    return {
      fiveHour: isPlainObject(stored.fiveHour)
        ? {
            usedPercent: stored.fiveHour.usedPercent,
            resetsAt: stored.fiveHour.resetsAt,
          }
        : null,
      weekly: isPlainObject(stored.weekly)
        ? {
            usedPercent: stored.weekly.usedPercent,
            resetsAt: stored.weekly.resetsAt,
          }
        : null,
      contextTokens: isPlainObject(stored.contextTokens)
        ? {
            inputTokens: stored.contextTokens.inputTokens,
            outputTokens: stored.contextTokens.outputTokens,
            contextWindowSize: stored.contextTokens.contextWindowSize,
            usedPercent: stored.contextTokens.usedPercent,
            observedAt: stored.contextTokens.observedAt,
          }
        : null,
      updatedAt: stored.updatedAt,
    };
  }

  readManagedClaudeRateLimitSnapshot(account) {
    const stored = readJsonFile(this.managedSnapshotPath(account), null);
    if (!isPlainObject(stored)) return null;
    return {
      fiveHour: isPlainObject(stored.fiveHour)
        ? {
            usedPercent: stored.fiveHour.usedPercent,
            resetsAt: stored.fiveHour.resetsAt,
          }
        : null,
      weekly: isPlainObject(stored.weekly)
        ? {
            usedPercent: stored.weekly.usedPercent,
            resetsAt: stored.weekly.resetsAt,
          }
        : null,
      contextTokens: isPlainObject(stored.contextTokens)
        ? {
            inputTokens: stored.contextTokens.inputTokens,
            outputTokens: stored.contextTokens.outputTokens,
            contextWindowSize: stored.contextTokens.contextWindowSize,
            usedPercent: stored.contextTokens.usedPercent,
            observedAt: stored.contextTokens.observedAt,
          }
        : null,
      updatedAt: stored.updatedAt,
    };
  }

  snapshotForError(provider, error) {
    const providerPrefix = `${provider.toUpperCase()}_`;
    const code =
      typeof error?.code === "string" &&
      error.code.startsWith(providerPrefix)
        ? error.code
        : `${provider.toUpperCase()}_UNKNOWN_ERROR`;
    const status = code.endsWith("_NOT_FOUND")
      ? "unavailable"
      : code.endsWith("_NOT_AUTHENTICATED")
        ? "disconnected"
        : code.endsWith("_CONFLICT")
          ? "conflict"
          : "error";
    return errorSnapshot(provider, status, code);
  }

  managedSnapshotForError(account, error) {
    const providerSnapshot = this.snapshotForError(account.provider, error);
    return withManagedIdentity(providerSnapshot, account);
  }

  async refreshManagedIntegration(accountId) {
    let account;
    try {
      account = this.managedAccount(accountId);
    } catch (error) {
      throw error;
    }
    if (this.managedAccountsBeingRemoved.has(account.id)) {
      throw integrationError("MANAGED_ACCOUNT_NOT_FOUND");
    }
    if (this.managedLoginProcesses.has(account.id)) {
      return connectingManagedSnapshot(account);
    }

    return this.deduplicateRefresh(`managed:${account.id}`, async () => {
      try {
        const profilePath = this.managedProfilePath(account);
        const env = managedChildEnvironment(account.provider, profilePath);
        if (account.provider === "codex") {
          const { accountResult, rateLimitResult } =
            await this.readCodexAccountAndRateLimits({
              env,
              managed: true,
            });
          return withManagedIdentity(
            normalizeCodexSnapshot(accountResult, rateLimitResult),
            account,
          );
        }

        this.ensureManagedClaudeBridge(account);
        const auth = await this.readClaudeAuth({ env });
        const usage = await this.collectClaudeUsageSnapshot(
          auth,
          this.readManagedClaudeRateLimitSnapshot(account),
          { env, managed: true },
        );
        return withManagedIdentity(
          normalizeClaudeSnapshot(
            auth,
            usage.storedSnapshot,
            usage.usageState,
          ),
          account,
        );
      } catch (error) {
        return this.managedSnapshotForError(account, error);
      }
    });
  }

  async getManagedStatus() {
    const accounts = this.readManagedAccounts();
    return mapWithConcurrency(
      accounts,
      MANAGED_REFRESH_CONCURRENCY,
      (account) => this.refreshManagedIntegration(account.id),
    );
  }

  async createManagedIntegration(input) {
    if (!isPlainObject(input) || !PROVIDERS.has(input.provider)) {
      throw integrationError("INVALID_PROVIDER");
    }
    const accounts = this.readManagedAccounts();
    if (accounts.length >= MANAGED_ACCOUNT_LIMIT) {
      throw integrationError("MANAGED_ACCOUNT_LIMIT");
    }
    const account = {
      id: crypto.randomUUID().toLowerCase(),
      provider: input.provider,
      label: sanitizeManagedLabel(input.label, input.provider),
      createdAt: new Date().toISOString(),
    };

    const profilePath = this.managedProfilePath(account);
    fs.mkdirSync(profilePath, { recursive: true });
    if (account.provider === "claude") {
      this.ensureManagedClaudeBridge(account);
      this.startManagedSnapshotWatcher();
    }
    this.writeManagedAccounts([...accounts, account]);
    return withManagedIdentity(disconnectedSnapshot(account.provider), account);
  }

  stopClaudeLogin(emitFailure = false, failureCode = null) {
    const login = this.claudeLoginProcess;
    if (!login) return;
    this.claudeLoginProcess = null;
    clearTimeout(login.timer);
    clearTimeout(login.pollTimer);
    login.cancelled = true;
    this.activeChildren.delete(login.child);
    if (!login.closed) terminateProcessTree(login.child);
    if (emitFailure && failureCode) {
      this.emitSnapshot(
        this.snapshotForError(
          "claude",
          integrationError(failureCode),
        ),
      );
    }
  }

  async completeClaudeLogin(
    success,
    failureCode = null,
    verifiedAuth = null,
  ) {
    const login = this.claudeLoginProcess;
    if (!login || login.cancelled) return null;
    this.claudeLoginProcess = null;
    clearTimeout(login.timer);
    clearTimeout(login.pollTimer);
    login.cancelled = true;
    this.activeChildren.delete(login.child);
    if (!login.closed) terminateProcessTree(login.child);

    if (!success) {
      const snapshot = this.snapshotForError(
        "claude",
        integrationError(failureCode || "CLAUDE_LOGIN_FAILED"),
      );
      this.emitSnapshot(snapshot);
      return snapshot;
    }

    let snapshot;
    try {
      const auth = verifiedAuth ?? (await this.readClaudeAuth());
      if (!auth.loggedIn) {
        throw integrationError("CLAUDE_NOT_AUTHENTICATED");
      }
      this.maintainClaudeBridgeIfOwned();
      try {
        this.writeConnection("claude", true);
      } catch {
        throw integrationError("CLAUDE_STATE_WRITE_FAILED");
      }
      this.lastClaudeAuth = auth;
      this.globalClaudeAuthCache = {
        auth,
        expiresAt: Date.now() + CLAUDE_AUTH_CACHE_MS,
      };
      this.startClaudeSnapshotWatcher();
      const usage = await this.collectClaudeUsageSnapshot(
        auth,
        this.readClaudeRateLimitSnapshot(),
      );
      snapshot = normalizeClaudeSnapshot(
        auth,
        usage.storedSnapshot,
        usage.usageState,
      );
    } catch (error) {
      snapshot = this.snapshotForError("claude", error);
    }
    this.emitSnapshot(snapshot);
    return snapshot;
  }

  async startClaudeLogin() {
    if (this.claudeLoginProcess) return connectingSnapshot("claude");

    const executablePath = resolveClaudeExecutable();
    if (!executablePath) {
      return this.snapshotForError(
        "claude",
        integrationError("CLAUDE_NOT_FOUND"),
      );
    }

    let child;
    try {
      child = spawn(
        executablePath,
        ["auth", "login", "--claudeai"],
        {
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: "ignore",
        },
      );
      this.activeChildren.add(child);
    } catch {
      return this.snapshotForError(
        "claude",
        integrationError("CLAUDE_PROCESS_ERROR"),
      );
    }

    const login = {
      child,
      cancelled: false,
      checking: false,
      closed: false,
      exitGraceUntil: null,
      pollTimer: null,
      timer: setTimeout(() => {
        if (this.claudeLoginProcess !== login) return;
        this.stopClaudeLogin(true, "CLAUDE_LOGIN_TIMEOUT");
      }, MANAGED_LOGIN_TIMEOUT_MS),
    };
    this.claudeLoginProcess = login;
    this.lastClaudeAuth = null;

    const schedulePoll = (delay = CLAUDE_LOGIN_POLL_MS) => {
      if (
        login.cancelled ||
        this.claudeLoginProcess !== login ||
        login.pollTimer !== null
      ) {
        return;
      }
      login.pollTimer = setTimeout(() => {
        login.pollTimer = null;
        void pollLogin();
      }, delay);
    };
    const pollLogin = async () => {
      if (
        login.cancelled ||
        login.checking ||
        this.claudeLoginProcess !== login
      ) {
        return;
      }
      login.checking = true;
      let auth = null;
      let terminalError = null;
      try {
        const candidate = await this.readClaudeAuth();
        if (candidate.loggedIn) auth = candidate;
      } catch (error) {
        if (isTerminalClaudeLoginError(error)) terminalError = error;
      } finally {
        login.checking = false;
      }
      if (login.cancelled || this.claudeLoginProcess !== login) return;
      if (auth) {
        await this.completeClaudeLogin(true, null, auth);
        return;
      }
      if (terminalError) {
        await this.completeClaudeLogin(false, terminalError.code);
        return;
      }
      if (
        login.closed &&
        Date.now() >= (login.exitGraceUntil ?? 0)
      ) {
        await this.completeClaudeLogin(false, "CLAUDE_LOGIN_FAILED");
        return;
      }
      schedulePoll();
    };

    child.once("error", () => {
      login.closed = true;
      void this.completeClaudeLogin(false, "CLAUDE_PROCESS_ERROR");
    });
    child.once("close", () => {
      this.activeChildren.delete(child);
      if (login.cancelled) return;
      login.closed = true;
      login.exitGraceUntil = Date.now() + CLAUDE_LOGIN_EXIT_GRACE_MS;
      schedulePoll(0);
    });
    schedulePoll(250);
    return connectingSnapshot("claude");
  }

  stopManagedLogin(accountId, emitFailure = false, failureCode = null) {
    const login = this.managedLoginProcesses.get(accountId);
    if (!login) return;
    this.managedLoginProcesses.delete(accountId);
    clearTimeout(login.timer);
    clearTimeout(login.pollTimer);
    login.cancelled = true;
    this.activeChildren.delete(login.child);
    if (!login.closed) terminateProcessTree(login.child);
    if (emitFailure && failureCode) {
      const account = this.findManagedAccountSafe(accountId);
      if (account) {
        this.emitSnapshot(
          this.managedSnapshotForError(
            account,
            integrationError(failureCode),
          ),
        );
      }
    }
  }

  async completeManagedLogin(account, success, failureCode = null) {
    const login = this.managedLoginProcesses.get(account.id);
    if (!login || login.cancelled) return null;
    this.managedLoginProcesses.delete(account.id);
    clearTimeout(login.timer);
    clearTimeout(login.pollTimer);
    login.cancelled = true;
    this.activeChildren.delete(login.child);
    if (!login.closed) terminateProcessTree(login.child);

    if (!success) {
      const snapshot = this.managedSnapshotForError(
        account,
        integrationError(
          failureCode || `${account.provider.toUpperCase()}_LOGIN_FAILED`,
        ),
      );
      this.emitSnapshot(snapshot);
      return snapshot;
    }
    const snapshot = await this.refreshManagedIntegration(account.id);
    if (this.findManagedAccountSafe(account.id)) {
      this.emitSnapshot(snapshot);
    }
    return snapshot;
  }

  async startManagedClaudeLogin(account) {
    let executablePath;
    let child;
    let env;
    try {
      this.ensureManagedClaudeBridge(account);
      executablePath = resolveClaudeExecutable();
      if (!executablePath) {
        throw integrationError("CLAUDE_NOT_FOUND");
      }
      env = managedChildEnvironment(
        "claude",
        this.managedProfilePath(account),
      );
      child = spawn(
        executablePath,
        ["auth", "login", "--claudeai"],
        {
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: "ignore",
          env,
        },
      );
      this.activeChildren.add(child);
    } catch (error) {
      const snapshot = this.managedSnapshotForError(account, error);
      this.emitSnapshot(snapshot);
      return snapshot;
    }

    const login = {
      child,
      cancelled: false,
      checking: false,
      closed: false,
      exitGraceUntil: null,
      pollTimer: null,
      timer: setTimeout(() => {
        this.stopManagedLogin(account.id, true, "CLAUDE_LOGIN_TIMEOUT");
      }, MANAGED_LOGIN_TIMEOUT_MS),
    };
    this.managedLoginProcesses.set(account.id, login);

    const schedulePoll = (delay = CLAUDE_LOGIN_POLL_MS) => {
      if (
        login.cancelled ||
        this.managedLoginProcesses.get(account.id) !== login ||
        login.pollTimer !== null
      ) {
        return;
      }
      login.pollTimer = setTimeout(() => {
        login.pollTimer = null;
        void pollLogin();
      }, delay);
    };
    const pollLogin = async () => {
      if (
        login.cancelled ||
        login.checking ||
        this.managedLoginProcesses.get(account.id) !== login
      ) {
        return;
      }
      login.checking = true;
      let authenticated = false;
      let terminalError = null;
      try {
        const auth = await this.readClaudeAuth({ env });
        authenticated = auth.loggedIn;
      } catch (error) {
        if (isTerminalClaudeLoginError(error)) terminalError = error;
      } finally {
        login.checking = false;
      }
      if (
        login.cancelled ||
        this.managedLoginProcesses.get(account.id) !== login
      ) {
        return;
      }
      if (authenticated) {
        await this.completeManagedLogin(account, true);
        return;
      }
      if (terminalError) {
        await this.completeManagedLogin(
          account,
          false,
          terminalError.code,
        );
        return;
      }
      if (
        login.closed &&
        Date.now() >= (login.exitGraceUntil ?? 0)
      ) {
        await this.completeManagedLogin(
          account,
          false,
          "CLAUDE_LOGIN_FAILED",
        );
        return;
      }
      schedulePoll();
    };

    child.once("error", () => {
      login.closed = true;
      void this.completeManagedLogin(
        account,
        false,
        "CLAUDE_PROCESS_ERROR",
      );
    });
    child.once("close", () => {
      this.activeChildren.delete(child);
      if (login.cancelled) return;
      login.closed = true;
      login.exitGraceUntil = Date.now() + CLAUDE_LOGIN_EXIT_GRACE_MS;
      schedulePoll(0);
    });
    schedulePoll(250);
    return connectingManagedSnapshot(account);
  }

  async startManagedCodexLogin(account) {
    const executablePath = resolveCodexExecutable();
    if (!executablePath) {
      const snapshot = this.managedSnapshotForError(
        account,
        integrationError("CODEX_NOT_FOUND"),
      );
      this.emitSnapshot(snapshot);
      return snapshot;
    }

    return new Promise((resolve) => {
      let child;
      let stdoutBuffer = "";
      let initialized = false;
      let pendingReturned = false;
      let completionWhileOpening = null;
      let loginId = null;
      let login;

      const returnFailure = (code) => {
        if (login?.cancelled) {
          if (!pendingReturned) {
            resolve(
              this.managedSnapshotForError(
                account,
                integrationError(code),
              ),
            );
          }
          return;
        }
        if (pendingReturned) {
          void this.completeManagedLogin(account, false, code);
        } else {
          if (login) {
            this.managedLoginProcesses.delete(account.id);
            clearTimeout(login.timer);
            login.cancelled = true;
          }
          if (child) {
            this.activeChildren.delete(child);
            terminateProcessTree(child);
          }
          const snapshot = this.managedSnapshotForError(
            account,
            integrationError(code),
          );
          this.emitSnapshot(snapshot);
          resolve(snapshot);
        }
      };

      const send = (message) => {
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
        } catch {
          returnFailure("CODEX_PROTOCOL_ERROR");
        }
      };

      const handleMessage = (message) => {
        if (!isPlainObject(message)) return;
        if (
          message.method === "account/login/completed" &&
          isPlainObject(message.params) &&
          (message.params.loginId === null ||
            message.params.loginId === loginId)
        ) {
          if (!pendingReturned) {
            completionWhileOpening = message.params.success === true;
            return;
          }
          void this.completeManagedLogin(
            account,
            message.params.success === true,
            "CODEX_LOGIN_FAILED",
          );
          return;
        }
        if (!Object.hasOwn(message, "id")) return;
        if (message.error) {
          returnFailure("CODEX_PROTOCOL_ERROR");
          return;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ method: "initialized", params: {} });
          send({
            method: "account/login/start",
            id: 2,
            params: { type: "chatgpt" },
          });
          return;
        }
        if (message.id !== 2) return;
        const result = message.result;
        if (
          !isPlainObject(result) ||
          result.type !== "chatgpt" ||
          typeof result.loginId !== "string" ||
          !isSafeLoginUrl(result.authUrl) ||
          typeof this.openExternal !== "function"
        ) {
          returnFailure("CODEX_LOGIN_URL_INVALID");
          return;
        }
        loginId = result.loginId;
        Promise.resolve(this.openExternal(result.authUrl))
          .then(async () => {
            if (login.cancelled) {
              resolve(
                this.managedSnapshotForError(
                  account,
                  integrationError("MANAGED_ACCOUNT_NOT_FOUND"),
                ),
              );
              return;
            }
            if (completionWhileOpening !== null) {
              const finalSnapshot = await this.completeManagedLogin(
                account,
                completionWhileOpening,
                "CODEX_LOGIN_FAILED",
              );
              resolve(
                finalSnapshot ||
                  this.managedSnapshotForError(
                    account,
                    integrationError("CODEX_LOGIN_FAILED"),
                  ),
              );
              return;
            }
            pendingReturned = true;
            resolve(connectingManagedSnapshot(account));
          })
          .catch(() => returnFailure("CODEX_LOGIN_OPEN_FAILED"));
      };

      try {
        child = spawn(
          executablePath,
          [
            "app-server",
            "-c",
            'cli_auth_credentials_store="file"',
            "--listen",
            "stdio://",
          ],
          {
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: managedChildEnvironment(
              "codex",
              this.managedProfilePath(account),
            ),
          },
        );
        this.activeChildren.add(child);
      } catch {
        returnFailure("CODEX_PROCESS_ERROR");
        return;
      }

      login = {
        child,
        cancelled: false,
        timer: setTimeout(() => {
          this.activeChildren.delete(child);
          if (pendingReturned) {
            this.stopManagedLogin(
              account.id,
              true,
              "CODEX_LOGIN_TIMEOUT",
            );
          } else {
            returnFailure("CODEX_LOGIN_TIMEOUT");
          }
        }, MANAGED_LOGIN_TIMEOUT_MS),
      };
      this.managedLoginProcesses.set(account.id, login);

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        if (
          Buffer.byteLength(stdoutBuffer, "utf8") >
          MAX_PROCESS_OUTPUT_BYTES
        ) {
          returnFailure("CODEX_PROTOCOL_ERROR");
          return;
        }
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0 && !login.cancelled) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            try {
              handleMessage(JSON.parse(line));
            } catch {
              returnFailure("CODEX_PROTOCOL_ERROR");
              return;
            }
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr.on("data", () => {
        // Never surface stderr; it may contain local account details.
      });
      child.once("error", () => {
        this.activeChildren.delete(child);
        returnFailure("CODEX_PROCESS_ERROR");
      });
      child.once("close", () => {
        this.activeChildren.delete(child);
        if (!login.cancelled) returnFailure("CODEX_PROCESS_ERROR");
      });
      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "tokencat",
            title: "TokenCat",
            version: this.app.getVersion(),
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: [],
          },
        },
      });
    });
  }

  async startManagedIntegrationLogin(accountId) {
    const account = this.managedAccount(accountId);
    if (this.managedLoginProcesses.has(account.id)) {
      return connectingManagedSnapshot(account);
    }
    return account.provider === "codex"
      ? this.startManagedCodexLogin(account)
      : this.startManagedClaudeLogin(account);
  }

  async openManagedIntegration(accountId) {
    const account = this.managedAccount(accountId);
    if (this.hasManagedOpenSession(account)) {
      throw integrationError("MANAGED_ACCOUNT_IN_USE");
    }
    const executablePath =
      account.provider === "codex"
        ? resolveCodexExecutable()
        : resolveClaudeExecutable();
    if (!executablePath) return false;

    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const providerArgs =
      account.provider === "codex"
        ? " -c 'cli_auth_credentials_store=\"file\"'"
        : "";
    const command = `& ${psQuote(executablePath)}${providerArgs}`;
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          powershellPath,
          ["-NoLogo", "-NoExit", "-EncodedCommand", encodedCommand],
          {
            shell: false,
            windowsHide: false,
            detached: true,
            stdio: "ignore",
            env: managedChildEnvironment(
              account.provider,
              this.managedProfilePath(account),
            ),
          },
        );
      } catch {
        resolve(false);
        return;
      }
      const cleanup = () => {
        if (this.managedOpenProcesses.get(account.id) === child) {
          this.managedOpenProcesses.delete(account.id);
        }
        this.clearManagedSessionMarker(account, child.pid);
      };
      child.once("spawn", () => {
        try {
          writeJsonAtomic(this.managedSessionPath(account), {
            processId: child.pid,
            createdAt: new Date().toISOString(),
          });
          this.managedOpenProcesses.set(account.id, child);
          child.unref();
          resolve(true);
        } catch {
          terminateProcessTree(child);
          resolve(false);
        }
      });
      child.once("close", cleanup);
      child.once("error", () => {
        cleanup();
        resolve(false);
      });
    });
  }

  async removeManagedIntegration(accountId) {
    const account = this.managedAccount(accountId);
    if (this.managedAccountsBeingRemoved.has(account.id)) {
      throw integrationError("MANAGED_ACCOUNT_BUSY");
    }
    this.managedAccountsBeingRemoved.add(account.id);
    try {
      this.stopManagedLogin(account.id);
      if (this.hasManagedOpenSession(account)) {
        throw integrationError("MANAGED_ACCOUNT_IN_USE");
      }
      const debounce = this.managedWatchDebounceTimers.get(account.id);
      if (debounce) {
        clearTimeout(debounce);
        this.managedWatchDebounceTimers.delete(account.id);
      }
      const refreshInFlight = this.refreshesInFlight.get(
        `managed:${account.id}`,
      );
      if (refreshInFlight) {
        try {
          await refreshInFlight;
        } catch {
          // The profile is still intact; removal can safely continue.
        }
      }

      const destination = path.join(
        this.removedProfilesRoot,
        `${Date.now()}-${account.provider}-${account.id}`,
      );
      if (!isPathInside(this.removedProfilesRoot, destination)) {
        throw integrationError("MANAGED_PATH_INVALID");
      }
      fs.mkdirSync(destination, { recursive: true });

      const moves = [
        {
          source: this.managedProfilePath(account),
          destination: path.join(destination, "profile"),
        },
        {
          source: this.managedSnapshotPath(account),
          destination: path.join(destination, "snapshot.json"),
        },
        {
          source: `${this.managedSnapshotPath(account)}.lock`,
          destination: path.join(destination, "snapshot.json.lock"),
        },
      ];
      const completedMoves = [];
      try {
        for (const move of moves) {
          if (
            !isPathInside(this.integrationsDirectory, move.source) ||
            !isPathInside(destination, move.destination)
          ) {
            throw integrationError("MANAGED_PATH_INVALID");
          }
          if (!fs.existsSync(move.source)) continue;
          fs.renameSync(move.source, move.destination);
          completedMoves.push(move);
        }
        this.writeManagedAccounts(
          this.readManagedAccounts().filter(
            (candidate) => candidate.id !== account.id,
          ),
        );
      } catch (error) {
        for (const move of completedMoves.reverse()) {
          try {
            fs.mkdirSync(path.dirname(move.source), { recursive: true });
            fs.renameSync(move.destination, move.source);
          } catch {
            // Preserve every file in one of the two app-owned locations.
          }
        }
        throw error;
      }
      return true;
    } finally {
      this.managedAccountsBeingRemoved.delete(account.id);
    }
  }

  async refreshManagedIntegrations() {
    return this.getManagedStatus();
  }

  async refreshCodex() {
    return this.deduplicateRefresh("codex", async () => {
      try {
        const { accountResult, rateLimitResult } =
          await this.readCodexAccountAndRateLimits();
        return normalizeCodexSnapshot(accountResult, rateLimitResult);
      } catch (error) {
        return this.snapshotForError("codex", error);
      }
    });
  }

  async refreshClaude({ requireBridge = true } = {}) {
    const refreshKey = requireBridge
      ? "claude-with-bridge"
      : "claude-auth-only";
    return this.deduplicateRefresh(refreshKey, async () => {
      try {
        if (requireBridge) {
          // Upgrade only a TokenCat-owned legacy bridge. OAuth usage and
          // transcript parsing work without statusLine, so a missing or
          // user-owned command is deliberately left untouched.
          this.maintainClaudeBridgeIfOwned();
        }
        const auth = await this.readClaudeAuth();
        this.lastClaudeAuth = auth;
        this.globalClaudeAuthCache = {
          auth,
          expiresAt: Date.now() + CLAUDE_AUTH_CACHE_MS,
        };
        if (!auth.loggedIn) return normalizeClaudeSnapshot(auth, null);
        const usage = await this.collectClaudeUsageSnapshot(
          auth,
          this.readClaudeRateLimitSnapshot(),
        );
        return normalizeClaudeSnapshot(
          auth,
          usage.storedSnapshot,
          usage.usageState,
        );
      } catch (error) {
        return this.snapshotForError("claude", error);
      }
    });
  }

  async refreshConnectedProvider(provider) {
    if (!PROVIDERS.has(provider)) {
      return errorSnapshot("codex", "error", "INVALID_PROVIDER");
    }
    if (provider === "claude" && this.claudeLoginProcess) {
      return connectingSnapshot("claude");
    }
    if (!this.readConnections()[provider]) {
      return disconnectedSnapshot(provider);
    }

    const snapshot =
      provider === "codex"
        ? await this.refreshCodex()
        : await this.refreshClaude();

    // Do not let a refresh that began before disconnect resurrect a card.
    return this.readConnections()[provider]
      ? snapshot
      : disconnectedSnapshot(provider);
  }

  async getStatus() {
    return Promise.all([
      this.refreshConnectedProvider("codex"),
      this.refreshConnectedProvider("claude"),
    ]);
  }

  async connect(provider) {
    if (!PROVIDERS.has(provider)) {
      return errorSnapshot("codex", "error", "INVALID_PROVIDER");
    }

    if (provider === "codex") {
      const snapshot = await this.refreshCodex();
      if (snapshot.connected) {
        try {
          this.writeConnection("codex", true);
        } catch {
          return errorSnapshot(
            "codex",
            "error",
            "CODEX_STATE_WRITE_FAILED",
          );
        }
      }
      return snapshot;
    }

    try {
      if (this.claudeLoginProcess) {
        return connectingSnapshot("claude");
      }
      const auth = await this.readClaudeAuth();
      if (!auth.loggedIn) {
        return this.startClaudeLogin();
      }
      this.maintainClaudeBridgeIfOwned();
      try {
        this.writeConnection("claude", true);
      } catch {
        throw integrationError("CLAUDE_STATE_WRITE_FAILED");
      }
      this.lastClaudeAuth = auth;
      this.globalClaudeAuthCache = {
        auth,
        expiresAt: Date.now() + CLAUDE_AUTH_CACHE_MS,
      };
      this.startClaudeSnapshotWatcher();
      const usage = await this.collectClaudeUsageSnapshot(
        auth,
        this.readClaudeRateLimitSnapshot(),
      );
      return normalizeClaudeSnapshot(
        auth,
        usage.storedSnapshot,
        usage.usageState,
      );
    } catch (error) {
      return this.snapshotForError("claude", error);
    }
  }

  async disconnect(provider) {
    if (!PROVIDERS.has(provider)) {
      return errorSnapshot("codex", "error", "INVALID_PROVIDER");
    }

    if (provider === "claude") {
      this.stopClaudeLogin();
      try {
        this.writeConnection("claude", false);
      } catch {
        return errorSnapshot(
          "claude",
          "error",
          "CLAUDE_STATE_WRITE_FAILED",
        );
      }
      this.stopClaudeSnapshotWatcher();
      this.lastClaudeAuth = null;
      const removeError = this.removeClaudeBridge();
      if (removeError) {
        return this.snapshotForError(
          "claude",
          integrationError(removeError),
        );
      }
    } else {
      try {
        this.writeConnection("codex", false);
      } catch {
        return errorSnapshot(
          "codex",
          "error",
          "CODEX_STATE_WRITE_FAILED",
        );
      }
    }

    return disconnectedSnapshot(provider);
  }

  async refresh() {
    return this.getStatus();
  }

  shutdown() {
    this.shuttingDown = true;
    this.stopClaudeLogin();
    this.stopClaudeSnapshotWatcher();
    this.stopManagedSnapshotWatcher();
    for (const accountId of [...this.managedLoginProcesses.keys()]) {
      this.stopManagedLogin(accountId);
    }
    for (const child of this.activeChildren) terminateProcessTree(child);
    this.activeChildren.clear();
    this.managedOpenProcesses.clear();
  }
}

function registerIntegrationIpc(
  electronApp,
  ipcMain,
  onSnapshot,
  openExternal,
) {
  const service = new IntegrationService(electronApp);
  service.setSnapshotListener(onSnapshot);
  service.setOpenExternal(openExternal);
  ipcMain.handle("integrations:get-status", () => service.getStatus());
  ipcMain.handle("integrations:connect", (_event, provider) =>
    service.connect(provider),
  );
  ipcMain.handle("integrations:disconnect", (_event, provider) =>
    service.disconnect(provider),
  );
  ipcMain.handle("integrations:refresh-provider", (_event, provider) =>
    service.refreshConnectedProvider(provider),
  );
  ipcMain.handle("integrations:refresh", () => service.refresh());
  ipcMain.handle("managed-integrations:get-status", () =>
    service.getManagedStatus(),
  );
  ipcMain.handle("managed-integrations:create", (_event, input) =>
    service.createManagedIntegration(input),
  );
  ipcMain.handle(
    "managed-integrations:start-login",
    (_event, accountId) =>
      service.startManagedIntegrationLogin(accountId),
  );
  ipcMain.handle("managed-integrations:remove", (_event, accountId) =>
    service.removeManagedIntegration(accountId),
  );
  ipcMain.handle("managed-integrations:open", (_event, accountId) =>
    service.openManagedIntegration(accountId),
  );
  ipcMain.handle(
    "managed-integrations:refresh-account",
    (_event, accountId) =>
      service.refreshManagedIntegration(accountId),
  );
  ipcMain.handle("managed-integrations:refresh", () =>
    service.refreshManagedIntegrations(),
  );
  return service;
}

module.exports = {
  IntegrationService,
  registerIntegrationIpc,
};
