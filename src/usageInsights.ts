export const HISTORY_STORAGE_KEY = "tokencat-usage-history-v1";

export const DEFAULT_HISTORY_RETENTION_DAYS = 84;

const HISTORY_VERSION = 1 as const;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;
const MAX_HISTORY_ACCOUNTS = 16;
const MAX_ACCOUNT_KEY_LENGTH = 160;
const RESET_GRACE_MS = 10 * 60 * 1000;
const ESTIMATED_GAP_MS = 2 * 60 * 60 * 1000;
const PERCENT_EPSILON = 0.0001;

export type UsageProvider = "claude" | "codex";
export type UsageQuotaKey = "fiveHour" | "weekly";
export type UsagePlanVerdictCode =
  | "not-enough-data"
  | "headroom"
  | "good-fit"
  | "tight"
  | "likely-insufficient";
export type UsageInsightConfidence = "low" | "medium" | "high";

export interface LocalizedUsageText {
  ko: string;
  en: string;
}

export interface UsageQuotaInput {
  usedPercent: number;
  resetsAt?: string | null;
}

export interface UsageSnapshotInput {
  provider: UsageProvider | "Claude" | "Codex";
  accountId?: string;
  displayName?: string;
  connected?: boolean;
  plan?: string | null;
  lastUpdatedAt?: string | null;
  quotas?: {
    fiveHour?: UsageQuotaInput;
    weekly?: UsageQuotaInput;
  };
}

export interface UsageAccountInput {
  id: string;
  provider: UsageProvider | "Claude" | "Codex";
  name?: string;
  plan?: string;
  connectionId?: string;
  origin?: "demo" | "manual" | "live" | string;
}

export interface StoredUsageQuota {
  used: number;
  resetsAt: string | null;
}

export interface StoredUsageBaseline {
  capturedAt: string;
  fiveHour?: StoredUsageQuota;
  weekly?: StoredUsageQuota;
}

export interface UsageHourBucket {
  fiveHourDelta?: number;
  weeklyDelta?: number;
  fiveHourPeak?: number;
  weeklyPeak?: number;
  sampleCount: number;
  rolloverCount?: number;
  correctionCount?: number;
  estimated?: boolean;
}

export interface UsageHistoryAccount {
  provider: UsageProvider;
  displayName?: string;
  plan?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  last: StoredUsageBaseline;
  hours: Record<string, UsageHourBucket>;
}

export interface UsageHistoryV1 {
  version: typeof HISTORY_VERSION;
  retentionDays: number;
  accounts: Record<string, UsageHistoryAccount>;
}

export interface RecordUsageOptions {
  now?: string | Date | number;
  retentionDays?: number;
}

export interface RecordUsageResult {
  history: UsageHistoryV1;
  changed: boolean;
  acceptedSamples: number;
}

export interface UsageHeatmapDay {
  date: string;
  weekIndex: number;
  weekday: number;
  future: boolean;
  primaryQuota: UsageQuotaKey | null;
  percentConsumed: number;
  weeklyPercent: number;
  fiveHourPercent: number;
  activeHours: number;
  percentPerActiveHour: number | null;
  estimated: boolean;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface UsagePlanVerdict {
  code: UsagePlanVerdictCode;
  confidence: UsageInsightConfidence;
  label: LocalizedUsageText;
  description: LocalizedUsageText;
}

export interface UsageInsightsMetrics {
  periodDays: 28;
  coverageDays: number;
  activeDays: number;
  activeHours: number;
  weeklyPercentConsumed: number;
  fiveHourPercentConsumed: number;
  primaryQuota: UsageQuotaKey | null;
  percentPerActiveHour: number | null;
  projectedWeeklyPercent: number | null;
  fiveHourPressureDays: number;
  estimatedHours: number;
  verdict: UsagePlanVerdict;
}

export interface UsageInsightsResult {
  accountKey: string;
  provider: UsageProvider | null;
  displayName: string | null;
  plan: string | null;
  hasData: boolean;
  heatmap: UsageHeatmapDay[];
  metrics: UsageInsightsMetrics;
}

export interface BuildUsageInsightsOptions {
  now?: string | Date | number;
  timeZoneOffsetMinutes?: number;
}

export type BuildDailyHourlyUsageOptions = BuildUsageInsightsOptions;

export interface UsageHourlyBarBucket {
  hour: number;
  label: string;
  percentPoints: number;
  peakPercent: number | null;
  sampleCount: number;
  rolloverCount: number;
  correctionCount: number;
  estimated: boolean;
  hasActivity: boolean;
}

export interface UsageDailyHourlyResult {
  accountKey: string;
  provider: UsageProvider | null;
  date: string;
  future: boolean;
  primaryQuota: UsageQuotaKey | null;
  totalPercentPoints: number;
  maxPercentPoints: number;
  activeHours: number;
  sampleCount: number;
  estimatedHours: number;
  buckets: UsageHourlyBarBucket[];
}

type NormalizedQuotaMap = Partial<
  Record<UsageQuotaKey, StoredUsageQuota>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPercent(value: unknown) {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return Math.min(100, Math.max(0, numeric));
}

function roundPercent(value: number) {
  return Math.round(value * 1000) / 1000;
}

function normalizeRetentionDays(value: unknown) {
  const numeric = finiteNumber(value);
  if (numeric === null) return DEFAULT_HISTORY_RETENTION_DAYS;
  return Math.min(
    MAX_RETENTION_DAYS,
    Math.max(MIN_RETENTION_DAYS, Math.round(numeric)),
  );
}

function normalizeProvider(value: unknown): UsageProvider | null {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "claude" || normalized === "codex"
    ? normalized
    : null;
}

function isoTimestamp(value: unknown): string | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    !(value instanceof Date)
  ) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveNow(value?: string | Date | number) {
  return isoTimestamp(value ?? new Date()) ?? new Date().toISOString();
}

function optionalText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, maximumLength);
  return normalized || undefined;
}

function sanitizeStoredQuota(value: unknown): StoredUsageQuota | undefined {
  if (!isRecord(value)) return undefined;
  const used = clampPercent(value.used);
  if (used === null) return undefined;
  return {
    used: roundPercent(used),
    resetsAt:
      value.resetsAt === null ? null : isoTimestamp(value.resetsAt),
  };
}

function sanitizeBaseline(value: unknown): StoredUsageBaseline | null {
  if (!isRecord(value)) return null;
  const capturedAt = isoTimestamp(value.capturedAt);
  if (!capturedAt) return null;
  const fiveHour = sanitizeStoredQuota(value.fiveHour);
  const weekly = sanitizeStoredQuota(value.weekly);
  if (!fiveHour && !weekly) return null;
  return {
    capturedAt,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

function sanitizeHourBucket(value: unknown): UsageHourBucket | null {
  if (!isRecord(value)) return null;
  const sampleCount = finiteNumber(value.sampleCount);
  if (sampleCount === null || sampleCount < 1) return null;

  const percentField = (field: string) => {
    const numeric = finiteNumber(value[field]);
    return numeric === null
      ? undefined
      : roundPercent(Math.min(100, Math.max(0, numeric)));
  };
  const countField = (field: string) => {
    const numeric = finiteNumber(value[field]);
    return numeric === null || numeric <= 0
      ? undefined
      : Math.min(10_000, Math.round(numeric));
  };

  const fiveHourDelta = percentField("fiveHourDelta");
  const weeklyDelta = percentField("weeklyDelta");
  const fiveHourPeak = percentField("fiveHourPeak");
  const weeklyPeak = percentField("weeklyPeak");
  const rolloverCount = countField("rolloverCount");
  const correctionCount = countField("correctionCount");

  return {
    ...(fiveHourDelta !== undefined ? { fiveHourDelta } : {}),
    ...(weeklyDelta !== undefined ? { weeklyDelta } : {}),
    ...(fiveHourPeak !== undefined ? { fiveHourPeak } : {}),
    ...(weeklyPeak !== undefined ? { weeklyPeak } : {}),
    sampleCount: Math.min(10_000, Math.max(1, Math.round(sampleCount))),
    ...(rolloverCount ? { rolloverCount } : {}),
    ...(correctionCount ? { correctionCount } : {}),
    ...(value.estimated === true ? { estimated: true } : {}),
  };
}

function hourKeyTimestamp(key: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key)) return null;
  const timestamp = Date.parse(`${key}:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sanitizeAccount(
  value: unknown,
  retentionDays: number,
  nowTimestamp: number,
): UsageHistoryAccount | null {
  if (!isRecord(value)) return null;
  const provider = normalizeProvider(value.provider);
  const firstSeenAt = isoTimestamp(value.firstSeenAt);
  const lastSeenAt = isoTimestamp(value.lastSeenAt);
  const last = sanitizeBaseline(value.last);
  if (!provider || !firstSeenAt || !lastSeenAt || !last) return null;

  const cutoff = nowTimestamp - retentionDays * 24 * 60 * 60 * 1000;
  const sourceHours = isRecord(value.hours) ? value.hours : {};
  const hours = Object.fromEntries(
    Object.entries(sourceHours)
      .flatMap(([key, bucket]) => {
        const timestamp = hourKeyTimestamp(key);
        const normalized = sanitizeHourBucket(bucket);
        return timestamp !== null && timestamp >= cutoff && normalized
          ? ([[key, normalized]] as const)
          : [];
      })
      .sort(([first], [second]) => first.localeCompare(second))
      .slice(-(retentionDays * 24)),
  );

  return {
    provider,
    ...(optionalText(value.displayName, 80)
      ? { displayName: optionalText(value.displayName, 80) }
      : {}),
    ...(optionalText(value.plan, 80)
      ? { plan: optionalText(value.plan, 80) }
      : {}),
    firstSeenAt,
    lastSeenAt,
    last,
    hours,
  };
}

export function emptyUsageHistory(
  retentionDays = DEFAULT_HISTORY_RETENTION_DAYS,
): UsageHistoryV1 {
  return {
    version: HISTORY_VERSION,
    retentionDays: normalizeRetentionDays(retentionDays),
    accounts: {},
  };
}

export function sanitizeUsageHistory(
  value: unknown,
  now?: string | Date | number,
): UsageHistoryV1 {
  if (!isRecord(value) || value.version !== HISTORY_VERSION) {
    return emptyUsageHistory();
  }
  const retentionDays = normalizeRetentionDays(value.retentionDays);
  const nowTimestamp = Date.parse(resolveNow(now));
  const sourceAccounts = isRecord(value.accounts) ? value.accounts : {};
  const accounts: Record<string, UsageHistoryAccount> = {};

  Object.entries(sourceAccounts)
    .slice(0, MAX_HISTORY_ACCOUNTS)
    .forEach(([key, account]) => {
      const safeKey = optionalText(key, MAX_ACCOUNT_KEY_LENGTH);
      if (!safeKey) return;
      const normalized = sanitizeAccount(
        account,
        retentionDays,
        nowTimestamp,
      );
      if (normalized) accounts[safeKey] = normalized;
    });

  return { version: HISTORY_VERSION, retentionDays, accounts };
}

export function readUsageHistory(
  serialized: string | null | undefined,
  now?: string | Date | number,
): UsageHistoryV1 {
  if (!serialized) return emptyUsageHistory();
  try {
    return sanitizeUsageHistory(JSON.parse(serialized), now);
  } catch {
    return emptyUsageHistory();
  }
}

export function serializeUsageHistory(
  history: unknown,
  now?: string | Date | number,
) {
  return JSON.stringify(sanitizeUsageHistory(history, now));
}

function normalizeSnapshotQuotas(
  snapshot: UsageSnapshotInput,
): NormalizedQuotaMap {
  const result: NormalizedQuotaMap = {};
  (["fiveHour", "weekly"] as UsageQuotaKey[]).forEach((key) => {
    const source = snapshot.quotas?.[key];
    const used = clampPercent(source?.usedPercent);
    if (used === null) return;
    result[key] = {
      used: roundPercent(used),
      resetsAt:
        source?.resetsAt === null ? null : isoTimestamp(source?.resetsAt),
    };
  });
  return result;
}

function historyKeyForSnapshot(
  snapshot: UsageSnapshotInput,
  accounts: UsageAccountInput[],
) {
  const provider = normalizeProvider(snapshot.provider);
  if (!provider) return null;
  const managedId = optionalText(snapshot.accountId, 80);
  if (managedId) return `managed:${provider}:${managedId}`;

  const matchingAccount = accounts.find((account) => {
    if (normalizeProvider(account.provider) !== provider) return false;
    return (
      account.connectionId === `local-${provider}` ||
      account.id === `live-${provider}-local`
    );
  });
  if (matchingAccount?.connectionId?.startsWith("managed-")) {
    return `managed:${provider}:${matchingAccount.connectionId.slice(8)}`;
  }
  return `local:${provider}`;
}

function accountMetadata(
  key: string,
  snapshot: UsageSnapshotInput,
  accounts: UsageAccountInput[],
) {
  const provider = normalizeProvider(snapshot.provider);
  const managedId = optionalText(snapshot.accountId, 80);
  const account = accounts.find((candidate) => {
    if (normalizeProvider(candidate.provider) !== provider) return false;
    if (managedId) {
      return (
        candidate.connectionId === `managed-${managedId}` ||
        candidate.id.endsWith(`-${managedId}`)
      );
    }
    return (
      candidate.connectionId === `local-${provider}` ||
      candidate.id === `live-${provider}-local`
    );
  });
  return {
    displayName:
      optionalText(snapshot.displayName, 80) ??
      optionalText(account?.name, 80),
    plan:
      optionalText(snapshot.plan, 80) ?? optionalText(account?.plan, 80),
    key,
  };
}

function quotasEqual(
  first: StoredUsageQuota | undefined,
  second: StoredUsageQuota | undefined,
) {
  return (
    first?.used === second?.used &&
    (first?.resetsAt ?? null) === (second?.resetsAt ?? null)
  );
}

function utcDayKey(timestamp: string) {
  return timestamp.slice(0, 10);
}

function utcHourKey(timestamp: string) {
  return timestamp.slice(0, 13);
}

function addQuotaObservation(
  bucket: UsageHourBucket,
  key: UsageQuotaKey,
  previous: StoredUsageQuota | undefined,
  current: StoredUsageQuota | undefined,
  previousCapturedAt: string,
  capturedAt: string,
) {
  if (!current) return false;
  const peakKey = key === "weekly" ? "weeklyPeak" : "fiveHourPeak";
  bucket[peakKey] = Math.max(bucket[peakKey] ?? 0, current.used);
  if (!previous) return true;
  if (quotasEqual(previous, current)) return false;

  const observedAt = Date.parse(capturedAt);
  const previousObservedAt = Date.parse(previousCapturedAt);
  let delta = 0;
  let rollover = false;
  let correction = false;

  if (current.used + PERCENT_EPSILON >= previous.used) {
    delta = Math.max(0, current.used - previous.used);
  } else {
    const previousResetAt = previous.resetsAt
      ? Date.parse(previous.resetsAt)
      : Number.NaN;
    const passedExpectedReset =
      Number.isFinite(previousResetAt) &&
      observedAt >= previousResetAt - RESET_GRACE_MS;
    if (
      passedExpectedReset &&
      current.resetsAt !== previous.resetsAt
    ) {
      delta = current.used;
      rollover = true;
    } else {
      correction = true;
    }
  }

  const deltaKey =
    key === "weekly" ? "weeklyDelta" : "fiveHourDelta";
  if (delta > PERCENT_EPSILON) {
    bucket[deltaKey] = roundPercent((bucket[deltaKey] ?? 0) + delta);
  }
  if (rollover) {
    bucket.rolloverCount = (bucket.rolloverCount ?? 0) + 1;
  }
  if (correction) {
    bucket.correctionCount = (bucket.correctionCount ?? 0) + 1;
  }
  if (observedAt - previousObservedAt > ESTIMATED_GAP_MS) {
    bucket.estimated = true;
  }
  return true;
}

function pruneHistory(
  history: UsageHistoryV1,
  nowTimestamp: number,
) {
  let changed = false;
  const cutoff =
    nowTimestamp - history.retentionDays * 24 * 60 * 60 * 1000;
  Object.values(history.accounts).forEach((account) => {
    Object.keys(account.hours).forEach((key) => {
      const timestamp = hourKeyTimestamp(key);
      if (timestamp === null || timestamp < cutoff) {
        delete account.hours[key];
        changed = true;
      }
    });
  });
  return changed;
}

export function recordUsageSnapshots(
  sourceHistory: unknown,
  snapshots: UsageSnapshotInput[],
  accounts: UsageAccountInput[] = [],
  options: RecordUsageOptions = {},
): RecordUsageResult {
  const now = resolveNow(options.now);
  const history = sanitizeUsageHistory(sourceHistory, now);
  let changed = false;
  if (options.retentionDays !== undefined) {
    const nextRetentionDays = normalizeRetentionDays(
      options.retentionDays,
    );
    if (nextRetentionDays !== history.retentionDays) {
      history.retentionDays = nextRetentionDays;
      changed = true;
    }
  }
  let acceptedSamples = 0;

  snapshots.forEach((snapshot) => {
    if (snapshot.connected === false) return;
    const provider = normalizeProvider(snapshot.provider);
    const key = historyKeyForSnapshot(snapshot, accounts);
    const quotas = normalizeSnapshotQuotas(snapshot);
    if (!provider || !key || !Object.keys(quotas).length) return;

    const capturedAt = isoTimestamp(snapshot.lastUpdatedAt) ?? now;
    const capturedTimestamp = Date.parse(capturedAt);
    const metadata = accountMetadata(key, snapshot, accounts);
    let stored = history.accounts[key];

    if (!stored) {
      if (Object.keys(history.accounts).length >= MAX_HISTORY_ACCOUNTS) {
        return;
      }
      stored = {
        provider,
        ...(metadata.displayName
          ? { displayName: metadata.displayName }
          : {}),
        ...(metadata.plan ? { plan: metadata.plan } : {}),
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
        last: { capturedAt, ...quotas },
        hours: {},
      };
      history.accounts[key] = stored;
      changed = true;
      acceptedSamples += 1;
      return;
    }

    const previousTimestamp = Date.parse(stored.last.capturedAt);
    if (capturedTimestamp < previousTimestamp) return;

    const fiveHourChanged = Boolean(
      quotas.fiveHour &&
        !quotasEqual(stored.last.fiveHour, quotas.fiveHour),
    );
    const weeklyChanged = Boolean(
      quotas.weekly &&
        !quotasEqual(stored.last.weekly, quotas.weekly),
    );
    const quotaChanged = fiveHourChanged || weeklyChanged;
    const metadataChanged =
      (metadata.displayName &&
        metadata.displayName !== stored.displayName) ||
      (metadata.plan && metadata.plan !== stored.plan);
    const dayChanged =
      utcDayKey(capturedAt) !== utcDayKey(stored.lastSeenAt);

    if (!quotaChanged && !metadataChanged && !dayChanged) return;

    if (metadata.displayName) stored.displayName = metadata.displayName;
    if (metadata.plan) stored.plan = metadata.plan;
    if (dayChanged || quotaChanged) stored.lastSeenAt = capturedAt;

    if (quotaChanged) {
      const bucketKey = utcHourKey(capturedAt);
      const bucket: UsageHourBucket = {
        ...(stored.hours[bucketKey] ?? { sampleCount: 0 }),
        sampleCount: (stored.hours[bucketKey]?.sampleCount ?? 0) + 1,
      };
      addQuotaObservation(
        bucket,
        "fiveHour",
        stored.last.fiveHour,
        quotas.fiveHour,
        stored.last.capturedAt,
        capturedAt,
      );
      addQuotaObservation(
        bucket,
        "weekly",
        stored.last.weekly,
        quotas.weekly,
        stored.last.capturedAt,
        capturedAt,
      );
      stored.hours[bucketKey] = bucket;
      stored.last = {
        capturedAt,
        ...(stored.last.fiveHour
          ? { fiveHour: stored.last.fiveHour }
          : {}),
        ...(stored.last.weekly ? { weekly: stored.last.weekly } : {}),
        ...quotas,
      };
      acceptedSamples += 1;
    }
    changed = true;
  });

  changed = pruneHistory(history, Date.parse(now)) || changed;
  return { history, changed, acceptedSamples };
}

export function clearUsageHistoryAccount(
  sourceHistory: unknown,
  accountKey: string,
  now?: string | Date | number,
) {
  const history = sanitizeUsageHistory(sourceHistory, now);
  delete history.accounts[accountKey];
  return history;
}

function dateKeyAtOffset(timestamp: number, offsetMinutes: number) {
  return new Date(timestamp + offsetMinutes * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function normalizeTimeZoneOffset(value: unknown) {
  const requestedOffset = finiteNumber(value) ?? 0;
  return Math.min(
    14 * 60,
    Math.max(-12 * 60, Math.round(requestedOffset)),
  );
}

function localMidnightTimestamp(dateKey: string, offsetMinutes: number) {
  return Date.parse(`${dateKey}T00:00:00.000Z`) -
    offsetMinutes * 60 * 1000;
}

function addCalendarDays(
  dateKey: string,
  days: number,
  offsetMinutes: number,
) {
  return dateKeyAtOffset(
    localMidnightTimestamp(dateKey, offsetMinutes) +
      days * 24 * 60 * 60 * 1000,
    offsetMinutes,
  );
}

function weekdayForDate(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

function hoursByLocalDate(
  account: UsageHistoryAccount | undefined,
  offsetMinutes: number,
) {
  const result: Record<
    string,
    Array<{ key: string; bucket: UsageHourBucket }>
  > = {};
  if (!account) return result;
  Object.entries(account.hours).forEach(([key, bucket]) => {
    const timestamp = hourKeyTimestamp(key);
    if (timestamp === null) return;
    const date = dateKeyAtOffset(timestamp, offsetMinutes);
    (result[date] ??= []).push({ key, bucket });
  });
  return result;
}

function primaryQuotaForAccount(
  account: UsageHistoryAccount | undefined,
): UsageQuotaKey | null {
  if (!account) return null;
  const buckets = Object.values(account.hours);
  const hasWeeklyData = Boolean(
    account.last.weekly ||
      buckets.some(
        (bucket) =>
          bucket.weeklyDelta !== undefined ||
          bucket.weeklyPeak !== undefined,
      ),
  );
  if (hasWeeklyData) return "weekly";

  const hasFiveHourData = Boolean(
    account.last.fiveHour ||
      buckets.some(
        (bucket) =>
          bucket.fiveHourDelta !== undefined ||
          bucket.fiveHourPeak !== undefined,
      ),
  );
  return hasFiveHourData ? "fiveHour" : null;
}

function validLocalDateKey(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function sumField(
  buckets: Array<{ bucket: UsageHourBucket }>,
  field: "weeklyDelta" | "fiveHourDelta",
) {
  return roundPercent(
    buckets.reduce((total, { bucket }) => total + (bucket[field] ?? 0), 0),
  );
}

function intensityForRate(rate: number | null): 0 | 1 | 2 | 3 | 4 {
  if (rate === null || rate <= 0) return 0;
  if (rate <= 1) return 1;
  if (rate <= 3) return 2;
  if (rate <= 8) return 3;
  return 4;
}

function confidenceForCoverage(
  coverageDays: number,
  activeDays: number,
): UsageInsightConfidence {
  if (coverageDays >= 21 && activeDays >= 10) return "high";
  if (coverageDays >= 14 && activeDays >= 6) return "medium";
  return "low";
}

const VERDICT_COPY: Record<
  UsagePlanVerdictCode,
  Pick<UsagePlanVerdict, "label" | "description">
> = {
  "not-enough-data": {
    label: { ko: "데이터가 더 필요해요", en: "More data needed" },
    description: {
      ko: "최소 7일과 3일 이상의 사용 기록이 쌓이면 플랜 적합도를 계산합니다.",
      en: "Plan fit is calculated after at least 7 days and 3 active days.",
    },
  },
  headroom: {
    label: { ko: "사용량에 여유가 있어요", en: "Plenty of headroom" },
    description: {
      ko: "현재 추세라면 더 낮은 플랜도 검토할 수 있습니다.",
      en: "At this pace, a lower plan may be worth reviewing.",
    },
  },
  "good-fit": {
    label: { ko: "현재 플랜이 적절해요", en: "Current plan looks suitable" },
    description: {
      ko: "최근 주간 사용 추세가 현재 한도와 균형을 이룹니다.",
      en: "Recent weekly usage is balanced with the current limit.",
    },
  },
  tight: {
    label: { ko: "한도가 다소 빠듯해요", en: "The limit looks tight" },
    description: {
      ko: "사용량이 조금 늘면 한도에 자주 닿을 수 있습니다.",
      en: "A small increase in usage may cause frequent limit pressure.",
    },
  },
  "likely-insufficient": {
    label: { ko: "플랜이 부족할 수 있어요", en: "Plan may be insufficient" },
    description: {
      ko: "현재 추세가 주간 한도를 초과하므로 플랜이나 사용 패턴을 검토해 보세요.",
      en: "The current pace exceeds the weekly limit; review the plan or usage pattern.",
    },
  },
};

function buildVerdict(
  projectedWeeklyPercent: number | null,
  coverageDays: number,
  activeDays: number,
): UsagePlanVerdict {
  const eligible =
    projectedWeeklyPercent !== null &&
    coverageDays >= 7 &&
    activeDays >= 3;
  const confidence = eligible
    ? confidenceForCoverage(coverageDays, activeDays)
    : "low";
  let code: UsagePlanVerdictCode = "not-enough-data";
  if (eligible) {
    code =
      projectedWeeklyPercent < 40
        ? "headroom"
        : projectedWeeklyPercent < 80
          ? "good-fit"
          : projectedWeeklyPercent <= 100
            ? "tight"
            : "likely-insufficient";
  }
  return { code, confidence, ...VERDICT_COPY[code] };
}

export function buildDailyHourlyUsage(
  sourceHistory: unknown,
  accountKey: string,
  selectedDate: string,
  options: BuildDailyHourlyUsageOptions = {},
): UsageDailyHourlyResult {
  const now = resolveNow(options.now);
  const nowTimestamp = Date.parse(now);
  const offsetMinutes = normalizeTimeZoneOffset(
    options.timeZoneOffsetMinutes,
  );
  const today = dateKeyAtOffset(nowTimestamp, offsetMinutes);
  const date = validLocalDateKey(selectedDate) ?? today;
  const history = sanitizeUsageHistory(sourceHistory, now);
  const account = history.accounts[accountKey];
  const primaryQuota = primaryQuotaForAccount(account);
  const groupedHours = hoursByLocalDate(account, offsetMinutes);
  const records = groupedHours[date] ?? [];
  const buckets: UsageHourlyBarBucket[] = Array.from(
    { length: 24 },
    (_, hour) => ({
      hour,
      label: String(hour).padStart(2, "0"),
      percentPoints: 0,
      peakPercent: null,
      sampleCount: 0,
      rolloverCount: 0,
      correctionCount: 0,
      estimated: false,
      hasActivity: false,
    }),
  );

  records.forEach(({ key, bucket }) => {
    const timestamp = hourKeyTimestamp(key);
    if (timestamp === null) return;
    const localHour = new Date(
      timestamp + offsetMinutes * 60 * 1000,
    ).getUTCHours();
    const target = buckets[localHour];
    const delta =
      primaryQuota === "weekly"
        ? bucket.weeklyDelta ?? 0
        : primaryQuota === "fiveHour"
          ? bucket.fiveHourDelta ?? 0
          : 0;
    const peak =
      primaryQuota === "weekly"
        ? bucket.weeklyPeak
        : primaryQuota === "fiveHour"
          ? bucket.fiveHourPeak
          : undefined;

    target.percentPoints += delta;
    if (peak !== undefined) {
      target.peakPercent = Math.max(target.peakPercent ?? 0, peak);
    }
    target.sampleCount += bucket.sampleCount;
    target.rolloverCount += bucket.rolloverCount ?? 0;
    target.correctionCount += bucket.correctionCount ?? 0;
    target.estimated ||= bucket.estimated === true;
  });

  buckets.forEach((bucket) => {
    bucket.percentPoints = roundPercent(bucket.percentPoints);
    bucket.hasActivity = bucket.percentPoints > PERCENT_EPSILON;
  });
  const totalPercentPoints = roundPercent(
    buckets.reduce(
      (total, bucket) => total + bucket.percentPoints,
      0,
    ),
  );

  return {
    accountKey,
    provider: account?.provider ?? null,
    date,
    future: date > today,
    primaryQuota,
    totalPercentPoints,
    maxPercentPoints: Math.max(
      0,
      ...buckets.map((bucket) => bucket.percentPoints),
    ),
    activeHours: buckets.filter((bucket) => bucket.hasActivity).length,
    sampleCount: buckets.reduce(
      (total, bucket) => total + bucket.sampleCount,
      0,
    ),
    estimatedHours: buckets.filter((bucket) => bucket.estimated).length,
    buckets,
  };
}

export function buildUsageInsights(
  sourceHistory: unknown,
  accountKey: string,
  options: BuildUsageInsightsOptions = {},
): UsageInsightsResult {
  const now = resolveNow(options.now);
  const nowTimestamp = Date.parse(now);
  const offsetMinutes = normalizeTimeZoneOffset(
    options.timeZoneOffsetMinutes,
  );
  const history = sanitizeUsageHistory(sourceHistory, now);
  const account = history.accounts[accountKey];
  const groupedHours = hoursByLocalDate(account, offsetMinutes);
  const accountPrimaryQuota = primaryQuotaForAccount(account);
  const today = dateKeyAtOffset(nowTimestamp, offsetMinutes);
  const todayWeekday = weekdayForDate(today);
  const heatmapStart = addCalendarDays(
    today,
    -(todayWeekday + 11 * 7),
    offsetMinutes,
  );
  const heatmap: UsageHeatmapDay[] = [];

  for (let index = 0; index < 84; index += 1) {
    const date = addCalendarDays(heatmapStart, index, offsetMinutes);
    const buckets = groupedHours[date] ?? [];
    const weeklyPercent = sumField(buckets, "weeklyDelta");
    const fiveHourPercent = sumField(buckets, "fiveHourDelta");
    const primaryQuota = accountPrimaryQuota;
    const percentConsumed =
      primaryQuota === "weekly" ? weeklyPercent : fiveHourPercent;
    const activeHours = buckets.filter(({ bucket }) =>
      primaryQuota === "weekly"
        ? (bucket.weeklyDelta ?? 0) > 0
        : primaryQuota === "fiveHour"
          ? (bucket.fiveHourDelta ?? 0) > 0
          : false,
    ).length;
    const percentPerActiveHour =
      activeHours > 0
        ? roundPercent(percentConsumed / activeHours)
        : null;
    heatmap.push({
      date,
      weekIndex: Math.floor(index / 7),
      weekday: weekdayForDate(date),
      future: date > today,
      primaryQuota,
      percentConsumed,
      weeklyPercent,
      fiveHourPercent,
      activeHours,
      percentPerActiveHour,
      estimated: buckets.some(({ bucket }) => bucket.estimated),
      intensity: intensityForRate(percentPerActiveHour),
    });
  }

  const metricStart = addCalendarDays(today, -27, offsetMinutes);
  const metricDays = Array.from({ length: 28 }, (_, index) =>
    addCalendarDays(metricStart, index, offsetMinutes),
  );
  const metricBuckets = metricDays.flatMap(
    (date) => groupedHours[date] ?? [],
  );
  const weeklyPercentConsumed = sumField(metricBuckets, "weeklyDelta");
  const fiveHourPercentConsumed = sumField(
    metricBuckets,
    "fiveHourDelta",
  );
  const primaryQuota = accountPrimaryQuota;
  const activeHours = metricBuckets.filter(({ bucket }) =>
    primaryQuota === "weekly"
      ? (bucket.weeklyDelta ?? 0) > 0
      : primaryQuota === "fiveHour"
        ? (bucket.fiveHourDelta ?? 0) > 0
        : false,
  ).length;
  const activeDays = metricDays.filter((date) => {
    const buckets = groupedHours[date] ?? [];
    return buckets.some(({ bucket }) =>
      primaryQuota === "weekly"
        ? (bucket.weeklyDelta ?? 0) > 0
        : primaryQuota === "fiveHour"
          ? (bucket.fiveHourDelta ?? 0) > 0
          : false,
    );
  }).length;

  let coverageDays = 0;
  if (account) {
    const firstDate = dateKeyAtOffset(
      Math.max(
        Date.parse(account.firstSeenAt),
        localMidnightTimestamp(metricStart, offsetMinutes),
      ),
      offsetMinutes,
    );
    const lastDate = dateKeyAtOffset(
      Math.min(Date.parse(account.lastSeenAt), nowTimestamp),
      offsetMinutes,
    );
    if (lastDate >= firstDate) {
      coverageDays =
        Math.floor(
          (localMidnightTimestamp(lastDate, offsetMinutes) -
            localMidnightTimestamp(firstDate, offsetMinutes)) /
            (24 * 60 * 60 * 1000),
        ) + 1;
    }
  }
  coverageDays = Math.min(28, Math.max(0, coverageDays));

  const percentPerActiveHour =
    activeHours && primaryQuota
      ? roundPercent(
          (primaryQuota === "weekly"
            ? weeklyPercentConsumed
            : fiveHourPercentConsumed) / activeHours,
        )
      : null;
  const projectedWeeklyPercent =
    coverageDays >= 7 &&
    activeDays >= 3 &&
    weeklyPercentConsumed > 0
      ? roundPercent(weeklyPercentConsumed / (coverageDays / 7))
      : null;
  const fiveHourPressureDays = metricDays.filter((date) =>
    (groupedHours[date] ?? []).some(
      ({ bucket }) => (bucket.fiveHourPeak ?? 0) >= 90,
    ),
  ).length;
  const estimatedHours = metricBuckets.filter(
    ({ bucket }) => bucket.estimated,
  ).length;
  const verdict = buildVerdict(
    projectedWeeklyPercent,
    coverageDays,
    activeDays,
  );

  return {
    accountKey,
    provider: account?.provider ?? null,
    displayName: account?.displayName ?? null,
    plan: account?.plan ?? null,
    hasData: Boolean(account && Object.keys(account.hours).length),
    heatmap,
    metrics: {
      periodDays: 28,
      coverageDays,
      activeDays,
      activeHours,
      weeklyPercentConsumed,
      fiveHourPercentConsumed,
      primaryQuota,
      percentPerActiveHour,
      projectedWeeklyPercent,
      fiveHourPressureDays,
      estimatedHours,
      verdict,
    },
  };
}
