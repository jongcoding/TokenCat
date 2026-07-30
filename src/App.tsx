import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  HISTORY_STORAGE_KEY,
  buildDailyHourlyUsage,
  buildUsageInsights,
  clearUsageHistoryAccount,
  readUsageHistory,
  recordUsageSnapshots,
  serializeUsageHistory,
  type UsageDailyHourlyResult,
  type UsageHeatmapDay,
  type UsageInsightsResult,
} from "./usageInsights";
import {
  VERTICAL_MINIMAL_ENTER_WIDTH,
  chooseActiveMinimalOrientationForSize,
  chooseMinimalOrientationForSize,
  shouldExitMinimalForSize,
  type MinimalOrientation,
} from "./minimalLayout";
import {
  ACCOUNT_STORAGE_KEY,
  parseAccountStorage,
  type AccountStorageStatus,
} from "./accountBootstrap";

type Provider = "Claude" | "Codex";
type Filter = "all" | Provider;
type Theme =
  | "light"
  | "dark"
  | "stone"
  | "midnight"
  | "ocean"
  | "forest"
  | "rose";
type Language = "ko" | "en";
type ColorRole = "accent" | "claude" | "codex" | "appBg" | "surface";
type ViewMode = "rings" | "bars";
type MinimalGraphMode = "ring" | "bar" | "none";
type MinimalGraphPreference = "follow" | "none";
type LayoutMode =
  | "vertical"
  | "horizontal"
  | "grid-2x2"
  | "grid-3x3";
type CardSurfaceMode = "separate" | "unified";
type DropPosition = "before" | "after";
type QuotaKey = "fiveHour" | "weekly";
type GraphPaintMode = "solid" | "gradient";
type GraphColorScope = `provider:${Provider}` | `account:${string}`;
type UsageTone = "normal" | "warning" | "danger";
type ProfilePosition = "left" | "right" | "top" | "bottom";
type ProviderIconMode = "pet" | "initial" | "none";
type AccountIconMode = "default" | ProviderIconMode | "custom";
type MascotAction = "idle" | "working" | "success" | "limit-warning";
type AccountOrigin = "demo" | "manual" | "live";
type AccountSyncState = "idle" | "waiting" | "stale" | "error";
type AddAccountMode = "managed" | "manual";
type TokenDisplayMode = "hidden" | "total" | "detail";
type TransparencyMode = "whole-window" | "background-only";
type DisplayScaleKey =
  | "widgetScale"
  | "graphScale"
  | "profileScale"
  | "titleScale"
  | "percentageScale"
  | "secondaryScale";
type SettingsCategory =
  | "general"
  | "dashboard"
  | "accounts"
  | "appearance";
type AppView = "usage" | "insights";
type InsightHeadlineMetric = "rate" | "contextTokens";

const SETTINGS_CATEGORIES: SettingsCategory[] = [
  "general",
  "dashboard",
  "accounts",
  "appearance",
];

function normalizeSettingsCategory(value: string | null): SettingsCategory {
  return SETTINGS_CATEGORIES.includes(value as SettingsCategory)
    ? (value as SettingsCategory)
    : "general";
}

type ManagedSnapshotFields = {
  accountId?: string;
  displayName?: string;
  managed?: boolean;
};

type ManagedIntegrationBridge = {
  getManagedIntegrationStatus?: () => Promise<IntegrationSnapshot[]>;
  createManagedIntegration?: (input: {
    provider: IntegrationProvider;
    label: string;
  }) => Promise<IntegrationSnapshot>;
  startManagedIntegrationLogin?: (
    accountId: string,
  ) => Promise<IntegrationSnapshot>;
  removeManagedIntegration?: (accountId: string) => Promise<boolean>;
  openManagedIntegration?: (accountId: string) => Promise<boolean>;
  refreshManagedIntegration?: (
    accountId: string,
  ) => Promise<IntegrationSnapshot>;
  refreshManagedIntegrations?: () => Promise<IntegrationSnapshot[]>;
};

type Quota = {
  used: number;
  reset: string;
  resetsAt?: string | null;
  visible: boolean;
};

type Account = {
  id: string;
  provider: Provider;
  name: string;
  plan: string;
  quotas: Record<QuotaKey, Quota>;
  iconMode: AccountIconMode;
  customIcon?: string;
  origin: AccountOrigin;
  connectionId?: string;
  syncState?: AccountSyncState;
  lastSyncedAt?: string;
  contextTokens?: IntegrationContextTokens;
};

type ProviderIcons = Record<Provider, ProviderIconMode>;

type ThemeColorOverrides = Partial<Record<ColorRole, string>>;

type ColorPreferences = {
  version: 1;
  themes: Partial<Record<Theme, ThemeColorOverrides>>;
};

type GraphPaint = {
  mode: GraphPaintMode;
  start: string;
  end: string;
  angle: number;
};

type GraphColorTheme = {
  providers?: Partial<Record<Provider, GraphPaint>>;
  accounts?: Record<string, GraphPaint>;
};

type GraphColorPreferences = {
  version: 1;
  themes: Partial<Record<Theme, GraphColorTheme>>;
};

type PercentageToneColors = Partial<Record<UsageTone, string>>;

type PercentageColorTheme = {
  providers?: Partial<Record<Provider, PercentageToneColors>>;
  accounts?: Record<string, PercentageToneColors>;
};

type PercentageColorPreferences = {
  version: 1;
  themes: Partial<Record<Theme, PercentageColorTheme>>;
};

type PercentageGraphPreferences = {
  version: 1;
  providers: Partial<Record<Provider, boolean>>;
  accounts: Record<string, boolean>;
};

type DisplayPreferences = {
  version: 1;
  widgetScale: number;
  graphScale: number;
  profileScale: number;
  titleScale: number;
  percentageScale: number;
  secondaryScale: number;
};

type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex: string }>;
};

const TOKENCAT_PET = "./pets/tokencat-token-eater-512.png";
const CLAUDE_PET_IDLE = "./pets/claude-clawd.svg";
const CLAUDE_PET_ACTIVE = "./pets/claude-clawd.gif";
const CODEX_PET_IDLE = "./pets/codex-companion-idle.png";
const CODEX_PET_ACTIVE = "./pets/codex-companion-active.gif";
const COLOR_STORAGE_KEY = "tokencat-color-palette";
const GRAPH_COLOR_STORAGE_KEY = "tokencat-graph-colors";
const PERCENTAGE_COLOR_STORAGE_KEY = "tokencat-percentage-colors";
const PERCENTAGE_GRAPH_STORAGE_KEY =
  "tokencat-percentage-colors-on-graph";
const CARD_PROFILE_STORAGE_KEY = "tokencat-card-show-profile";
const CARD_TITLE_STORAGE_KEY = "tokencat-card-show-title";
const CARD_PLAN_STORAGE_KEY = "tokencat-card-show-plan";
const CARD_EDIT_STORAGE_KEY = "tokencat-card-show-edit";
const CARD_SURFACE_STORAGE_KEY = "tokencat-card-surface-mode";
const PROFILE_POSITION_STORAGE_KEY = "tokencat-profile-position";
const TITLEBAR_AUTO_HIDE_STORAGE_KEY = "tokencat-titlebar-auto-hide";
const TOKEN_DISPLAY_MODE_STORAGE_KEY = "tokencat-context-token-display";
const MINIMAL_MODE_STORAGE_KEY = "tokencat-minimal-mode";
const MINIMAL_GRAPH_MODE_STORAGE_KEY = "tokencat-minimal-graph-mode";
const AUTO_MINIMAL_STORAGE_KEY = "tokencat-auto-minimal";
const AUTO_MINIMAL_HEIGHT_STORAGE_KEY = "tokencat-auto-minimal-height";
const AUTO_MINIMAL_WIDTH_STORAGE_KEY = "tokencat-auto-minimal-width";
const MINIMAL_ORIENTATION_STORAGE_KEY = "tokencat-minimal-orientation";
const MINIMAL_ORIENTATION_MIGRATION_STORAGE_KEY =
  "tokencat-minimal-orientation-v3-migrated";
const LAYOUT_STORAGE_KEY = "tokencat-account-layout";
const DISPLAY_PREFERENCES_STORAGE_KEY = "tokencat-display-preferences";
const WIDGET_SCALE_STORAGE_KEY = "tokencat-widget-scale";
const FONT_SCALE_STORAGE_KEY = "tokencat-font-scale";
const TITLEBAR_HIDE_DELAY = 2400;
const MINIMAL_CHROME_HIDE_DELAY = 1800;
const DEFAULT_AUTO_MINIMAL_HEIGHT = 320;
const MIN_AUTO_MINIMAL_HEIGHT = 300;
const MAX_AUTO_MINIMAL_HEIGHT = 480;
const DEFAULT_AUTO_MINIMAL_WIDTH = 420;
const MIN_AUTO_MINIMAL_WIDTH = 360;
const MAX_AUTO_MINIMAL_WIDTH = 640;
const RESPONSIVE_RESIZE_THROTTLE_MS = 90;
const WIDGET_POINTER_WAKE_THROTTLE_MS = 180;
const INTEGRATION_POLL_INTERVAL_MS = 60_000;
const MIN_WINDOW_OPACITY = 60;
const MAX_WINDOW_OPACITY = 100;
const GRID_SINGLE_COLUMN_MEDIA = "(max-width: 650px)";
const DEFAULT_WIDGET_SCALE = 100;
const MIN_WIDGET_SCALE = 80;
const MAX_WIDGET_SCALE = 140;
const DEFAULT_GRAPH_SCALE = 100;
const MIN_GRAPH_SCALE = 80;
const MAX_GRAPH_SCALE = 130;
const DEFAULT_PROFILE_SCALE = 100;
const MIN_PROFILE_SCALE = 60;
const MAX_PROFILE_SCALE = 160;
const DEFAULT_TITLE_SCALE = 100;
const MIN_TITLE_SCALE = 80;
const MAX_TITLE_SCALE = 160;
const DEFAULT_PERCENTAGE_SCALE = 100;
const MIN_PERCENTAGE_SCALE = 80;
const MAX_PERCENTAGE_SCALE = 160;
const DEFAULT_SECONDARY_SCALE = 100;
const MIN_SECONDARY_SCALE = 100;
const MAX_SECONDARY_SCALE = 150;
const THEMES: Theme[] = [
  "light",
  "dark",
  "stone",
  "midnight",
  "ocean",
  "forest",
  "rose",
];
const LAYOUT_MODES: LayoutMode[] = [
  "vertical",
  "horizontal",
  "grid-2x2",
  "grid-3x3",
];
const DARK_THEMES = new Set<Theme>(["dark", "midnight", "forest"]);

function isDarkTheme(theme: Theme) {
  return DARK_THEMES.has(theme);
}

const DISPLAY_SCALE_LIMITS: Record<
  DisplayScaleKey,
  { minimum: number; maximum: number; fallback: number }
> = {
  widgetScale: {
    minimum: MIN_WIDGET_SCALE,
    maximum: MAX_WIDGET_SCALE,
    fallback: DEFAULT_WIDGET_SCALE,
  },
  graphScale: {
    minimum: MIN_GRAPH_SCALE,
    maximum: MAX_GRAPH_SCALE,
    fallback: DEFAULT_GRAPH_SCALE,
  },
  profileScale: {
    minimum: MIN_PROFILE_SCALE,
    maximum: MAX_PROFILE_SCALE,
    fallback: DEFAULT_PROFILE_SCALE,
  },
  titleScale: {
    minimum: MIN_TITLE_SCALE,
    maximum: MAX_TITLE_SCALE,
    fallback: DEFAULT_TITLE_SCALE,
  },
  percentageScale: {
    minimum: MIN_PERCENTAGE_SCALE,
    maximum: MAX_PERCENTAGE_SCALE,
    fallback: DEFAULT_PERCENTAGE_SCALE,
  },
  secondaryScale: {
    minimum: MIN_SECONDARY_SCALE,
    maximum: MAX_SECONDARY_SCALE,
    fallback: DEFAULT_SECONDARY_SCALE,
  },
};

const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  version: 1,
  widgetScale: DEFAULT_WIDGET_SCALE,
  graphScale: DEFAULT_GRAPH_SCALE,
  profileScale: DEFAULT_PROFILE_SCALE,
  titleScale: DEFAULT_TITLE_SCALE,
  percentageScale: DEFAULT_PERCENTAGE_SCALE,
  secondaryScale: DEFAULT_SECONDARY_SCALE,
};

function translate(language: Language, korean: string, english: string) {
  return language === "en" ? english : korean;
}

function usageHistoryKeyForAccount(account: Account) {
  if (account.origin !== "live") return null;
  const provider = account.provider.toLowerCase();
  const managedId = account.connectionId?.startsWith("managed-")
    ? account.connectionId.slice("managed-".length)
    : null;
  return managedId
    ? `managed:${provider}:${managedId}`
    : `local:${provider}`;
}

function formatInsightDate(date: string, language: Language) {
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDayKey(dateKey: string, amount: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function usageHeatmapLabel(day: UsageHeatmapDay, language: Language) {
  const date = formatInsightDate(day.date, language);
  if (day.future) {
    return translate(language, `${date} · 아직 기록 없음`, `${date} · No data yet`);
  }
  if (!day.percentConsumed || day.percentPerActiveHour === null) {
    return translate(language, `${date} · 사용 변화 없음`, `${date} · No usage change`);
  }
  const quota =
    day.primaryQuota === "weekly"
      ? translate(language, "주간", "weekly")
      : translate(language, "5시간", "5-hour");
  const estimated = day.estimated
    ? translate(language, " · 추정 포함", " · includes estimate")
    : "";
  return translate(
    language,
    `${date} · ${quota} ${day.percentConsumed.toFixed(1)}%p 소비 · 활동 ${day.activeHours}시간대 · ${day.percentPerActiveHour.toFixed(1)}%p/H${estimated}`,
    `${date} · ${quota} ${day.percentConsumed.toFixed(1)}pp consumed · ${day.activeHours} active hours · ${day.percentPerActiveHour.toFixed(1)}pp/H${estimated}`,
  );
}

function normalizeLayoutMode(value: unknown): LayoutMode {
  return LAYOUT_MODES.includes(value as LayoutMode)
    ? (value as LayoutMode)
    : "vertical";
}

function readLayoutMode(): LayoutMode {
  return normalizeLayoutMode(
    window.localStorage.getItem(LAYOUT_STORAGE_KEY),
  );
}

function normalizeCardSurfaceMode(value: unknown): CardSurfaceMode {
  return value === "unified" ? "unified" : "separate";
}

function normalizeMinimalGraphPreference(
  value: unknown,
): MinimalGraphPreference {
  return value === "none" ? "none" : "follow";
}

function readTokenDisplayMode(): TokenDisplayMode {
  const saved = window.localStorage.getItem(TOKEN_DISPLAY_MODE_STORAGE_KEY);
  return saved === "hidden" || saved === "detail" ? saved : "total";
}

function normalizeMinimalOrientation(value: unknown): MinimalOrientation {
  return value === "medium" || value === "vertical"
    ? value
    : "horizontal";
}

function nextMinimalOrientation(
  orientation: MinimalOrientation,
): MinimalOrientation {
  if (orientation === "horizontal") return "medium";
  if (orientation === "medium") return "vertical";
  return "horizontal";
}

function readMinimalOrientation(): MinimalOrientation {
  const stored = window.localStorage.getItem(
    MINIMAL_ORIENTATION_STORAGE_KEY,
  );
  const migrationComplete =
    window.localStorage.getItem(
      MINIMAL_ORIENTATION_MIGRATION_STORAGE_KEY,
    ) === "true";

  if (!migrationComplete) {
    window.localStorage.setItem(
      MINIMAL_ORIENTATION_MIGRATION_STORAGE_KEY,
      "true",
    );
    // Before the three-layout model, "vertical" named the compact stacked
    // layout that is now called "medium".
    if (stored === "vertical") return "medium";
  }

  return normalizeMinimalOrientation(stored);
}

function normalizeAutoMinimalHeight(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_AUTO_MINIMAL_HEIGHT;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_MINIMAL_HEIGHT;
  return Math.min(
    MAX_AUTO_MINIMAL_HEIGHT,
    Math.max(MIN_AUTO_MINIMAL_HEIGHT, Math.round(numeric / 10) * 10),
  );
}

function normalizeAutoMinimalWidth(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_AUTO_MINIMAL_WIDTH;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_MINIMAL_WIDTH;
  return Math.min(
    MAX_AUTO_MINIMAL_WIDTH,
    Math.max(MIN_AUTO_MINIMAL_WIDTH, Math.round(numeric / 10) * 10),
  );
}

function normalizeWindowOpacity(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(
    MAX_WINDOW_OPACITY,
    Math.max(MIN_WINDOW_OPACITY, Math.round(numeric)),
  );
}

function normalizeTransparencyMode(value: unknown): TransparencyMode {
  return value === "background-only"
    ? "background-only"
    : "whole-window";
}

function readCardSurfaceMode(): CardSurfaceMode {
  return normalizeCardSurfaceMode(
    window.localStorage.getItem(CARD_SURFACE_STORAGE_KEY),
  );
}

function isGridLayoutMode(layout: LayoutMode) {
  return layout === "grid-2x2" || layout === "grid-3x3";
}

function usesHorizontalSequence(
  layout: LayoutMode,
  gridSingleColumn = false,
) {
  return (
    layout !== "vertical" &&
    !(gridSingleColumn && isGridLayoutMode(layout))
  );
}

function gridLayoutCapacity(layout: LayoutMode) {
  if (layout === "grid-2x2") return 4;
  if (layout === "grid-3x3") return 9;
  return null;
}

function readCardElementPreference(key: string) {
  const saved = window.localStorage.getItem(key);
  if (saved !== null) return saved !== "false";
  return window.localStorage.getItem("tokencat-quota-only") !== "true";
}

function readCardPlanPreference() {
  const saved = window.localStorage.getItem(CARD_PLAN_STORAGE_KEY);
  if (saved !== null) return saved !== "false";
  return (
    window.localStorage.getItem("tokencat-usage-only") === "false" &&
    readCardElementPreference(CARD_TITLE_STORAGE_KEY)
  );
}

function readProfilePosition(): ProfilePosition {
  const saved = window.localStorage.getItem(PROFILE_POSITION_STORAGE_KEY);
  return saved === "right" || saved === "top" || saved === "bottom"
    ? saved
    : "left";
}

function normalizeScale(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function readScalePreference(
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return normalizeScale(
    window.localStorage.getItem(key),
    minimum,
    maximum,
    fallback,
  );
}

function normalizeDisplayScale(key: DisplayScaleKey, value: unknown) {
  const limits = DISPLAY_SCALE_LIMITS[key];
  return normalizeScale(
    value,
    limits.minimum,
    limits.maximum,
    limits.fallback,
  );
}

function readDisplayPreferences(): DisplayPreferences {
  let stored: unknown = null;
  try {
    stored = JSON.parse(
      window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY) ??
        "null",
    );
  } catch {
    stored = null;
  }

  const candidate =
    typeof stored === "object" &&
    stored !== null &&
    (stored as { version?: unknown }).version === 1
      ? (stored as Partial<Record<DisplayScaleKey | "version", unknown>>)
      : null;
  const legacyFontScale = readScalePreference(
    FONT_SCALE_STORAGE_KEY,
    MIN_TITLE_SCALE,
    MAX_SECONDARY_SCALE,
    DEFAULT_TITLE_SCALE,
  );

  return {
    version: 1,
    widgetScale: normalizeDisplayScale(
      "widgetScale",
      candidate?.widgetScale ??
        window.localStorage.getItem(WIDGET_SCALE_STORAGE_KEY),
    ),
    graphScale: normalizeDisplayScale(
      "graphScale",
      candidate?.graphScale,
    ),
    profileScale: normalizeDisplayScale(
      "profileScale",
      candidate?.profileScale,
    ),
    titleScale: normalizeDisplayScale(
      "titleScale",
      candidate?.titleScale ?? legacyFontScale,
    ),
    percentageScale: normalizeDisplayScale(
      "percentageScale",
      candidate?.percentageScale ?? legacyFontScale,
    ),
    secondaryScale: normalizeDisplayScale(
      "secondaryScale",
      candidate?.secondaryScale ?? legacyFontScale,
    ),
  };
}

function scaledFontSize(base: number, minimum: number, scale: number) {
  const value = Math.max(minimum, (base * scale) / 100);
  return `${Math.round(value * 10) / 10}px`;
}

function scaledNumber(base: number, minimum: number, scale: number) {
  return Math.round(Math.max(minimum, (base * scale) / 100) * 10) / 10;
}

const COLOR_ROLES: Array<{
  role: ColorRole;
  label: string;
  cssVariable: `--${string}`;
}> = [
  { role: "accent", label: "강조", cssVariable: "--accent" },
  { role: "claude", label: "Claude", cssVariable: "--claude" },
  { role: "codex", label: "Codex", cssVariable: "--codex" },
  { role: "appBg", label: "앱 배경", cssVariable: "--app-bg" },
  { role: "surface", label: "카드", cssVariable: "--surface" },
];

const THEME_COLOR_DEFAULTS: Record<
  Theme,
  Record<ColorRole, string>
> = {
  light: {
    accent: "#343434",
    claude: "#BF6845",
    codex: "#44745E",
    appBg: "#F5F5F4",
    surface: "#FFFFFF",
  },
  dark: {
    accent: "#EDEDED",
    claude: "#DF8964",
    codex: "#6CAB8E",
    appBg: "#18181B",
    surface: "#242427",
  },
  stone: {
    accent: "#44403C",
    claude: "#AD5E3E",
    codex: "#456F5E",
    appBg: "#E7E5E4",
    surface: "#F8F7F5",
  },
  midnight: {
    accent: "#8FB4FF",
    claude: "#E19470",
    codex: "#77C6A3",
    appBg: "#0B1120",
    surface: "#111A2E",
  },
  ocean: {
    accent: "#25637D",
    claude: "#B96549",
    codex: "#327A6A",
    appBg: "#EAF2F7",
    surface: "#F8FBFD",
  },
  forest: {
    accent: "#9AC7AD",
    claude: "#DF8B68",
    codex: "#78B89A",
    appBg: "#101815",
    surface: "#17211D",
  },
  rose: {
    accent: "#7A4E54",
    claude: "#BE674B",
    codex: "#4D7768",
    appBg: "#F4ECEC",
    surface: "#FFF9F8",
  },
};

const THEME_TEXT_COLORS: Record<Theme, string> = {
  light: "#171717",
  dark: "#F5F5F5",
  stone: "#292524",
  midnight: "#F3F7FF",
  ocean: "#163041",
  forest: "#F1F5F2",
  rose: "#352727",
};

const THEME_FOREGROUND_COLORS: Record<Theme, string[]> = {
  light: ["#171717", "#525252", "#686868"],
  dark: ["#F5F5F5", "#D4D4D8", "#A1A1AA"],
  stone: ["#292524", "#57534E", "#625E5A"],
  midnight: ["#F3F7FF", "#C4CEE1", "#96A3BA"],
  ocean: ["#163041", "#476474", "#5B6D7C"],
  forest: ["#F1F5F2", "#C5D0C9", "#98AAA0"],
  rose: ["#352727", "#655153", "#785F63"],
};

const THEME_PERCENTAGE_DEFAULTS: Record<
  Theme,
  Record<Exclude<UsageTone, "normal">, string>
> = {
  light: { warning: "#D97706", danger: "#DC2626" },
  dark: { warning: "#F59E0B", danger: "#F87171" },
  stone: { warning: "#C66A05", danger: "#C83B3B" },
  midnight: { warning: "#F4B64A", danger: "#FF8585" },
  ocean: { warning: "#B76600", danger: "#C23C3C" },
  forest: { warning: "#E7AE50", danger: "#EF7D78" },
  rose: { warning: "#B86D0C", danger: "#BD4148" },
};

const COLOR_PALETTES: Record<
  "light" | "dark",
  Record<ColorRole, string[]>
> = {
  light: {
    accent: ["#343434", "#C2410C", "#B45309", "#6D28D9", "#1D4ED8", "#047857"],
    claude: ["#BF6845", "#C2410C", "#B45309", "#9F3F35", "#7C2D12", "#A13D63"],
    codex: ["#44745E", "#047857", "#0F766E", "#1D4ED8", "#6D28D9", "#9F3F35"],
    appBg: ["#F5F5F4", "#F8F1E7", "#EDF3FF", "#EEF7F2", "#F8EEF2", "#ECEAE6"],
    surface: ["#FFFFFF", "#FFF8F1", "#F7FAFF", "#F4FBF7", "#FFF5F8", "#F8F7F5"],
  },
  dark: {
    accent: ["#EDEDED", "#F59E0B", "#FB923C", "#A78BFA", "#60A5FA", "#34D399"],
    claude: ["#DF8964", "#FB923C", "#F59E0B", "#F87171", "#F0A17C", "#FB7185"],
    codex: ["#6CAB8E", "#34D399", "#2DD4BF", "#60A5FA", "#A78BFA", "#22C55E"],
    appBg: ["#18181B", "#111827", "#13221C", "#211A2B", "#241A17", "#0F172A"],
    surface: ["#242427", "#1F2937", "#1D3028", "#30263A", "#34251F", "#1E293B"],
  },
};

const QUOTA_LABELS: Record<QuotaKey, string> = {
  fiveHour: "5시간",
  weekly: "주간",
};

const MIGRATION_QUOTA_FALLBACKS: Record<
  Provider,
  Record<QuotaKey, Quota>
> = {
  Claude: {
    fiveHour: {
      used: 0,
      reset: "직접 입력",
      visible: true,
    },
    weekly: {
      used: 0,
      reset: "직접 입력",
      visible: true,
    },
  },
  Codex: {
    fiveHour: {
      used: 0,
      reset: "직접 입력",
      visible: false,
    },
    weekly: {
      used: 0,
      reset: "직접 입력",
      visible: true,
    },
  },
};

const DEFAULT_PROVIDER_ICONS: ProviderIcons = {
  Claude: "pet",
  Codex: "pet",
};

const EMPTY_INTEGRATIONS: Record<
  IntegrationProvider,
  IntegrationSnapshot
> = {
  claude: {
    provider: "claude",
    connected: false,
    plan: null,
    status: "disconnected",
    quotas: {},
    contextTokens: null,
    lastUpdatedAt: null,
    authVerifiedAt: null,
    errorCode: null,
  },
  codex: {
    provider: "codex",
    connected: false,
    plan: null,
    status: "disconnected",
    quotas: {},
    contextTokens: null,
    lastUpdatedAt: null,
    authVerifiedAt: null,
    errorCode: null,
  },
};

const EMPTY_UPDATE_STATE: AppUpdateState = {
  status: "disabled",
  distribution: "development",
  supported: false,
  currentVersion: "0.30.0",
  availableVersion: null,
  progressPercent: null,
  transferred: null,
  total: null,
  checkedAt: null,
  downloadedAt: null,
  errorCode: null,
};

function normalizeHex(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null;
}

function readColorPreferences(): ColorPreferences {
  const empty: ColorPreferences = { version: 1, themes: {} };

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(COLOR_STORAGE_KEY) || "null",
    ) as Partial<ColorPreferences> | null;
    if (!parsed || parsed.version !== 1 || !parsed.themes) return empty;

    const themes: ColorPreferences["themes"] = {};
    THEMES.forEach((theme) => {
      const source = parsed.themes?.[theme];
      if (!source || typeof source !== "object") return;
      const next: ThemeColorOverrides = {};

      COLOR_ROLES.forEach(({ role }) => {
        const color = normalizeHex(source[role]);
        if (color) next[role] = color;
      });

      if (Object.keys(next).length) themes[theme] = next;
    });

    return { version: 1, themes };
  } catch {
    return empty;
  }
}

function normalizeGraphPaint(value: unknown): GraphPaint | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<GraphPaint>;
  const start = normalizeHex(source.start);
  const end = normalizeHex(source.end);
  if (!start || !end) return null;

  const rawAngle = Number(source.angle);
  const angle = Number.isFinite(rawAngle)
    ? ((Math.round(rawAngle) % 360) + 360) % 360
    : 90;

  return {
    mode: source.mode === "gradient" ? "gradient" : "solid",
    start,
    end,
    angle,
  };
}

function readGraphColorPreferences(): GraphColorPreferences {
  const empty: GraphColorPreferences = { version: 1, themes: {} };

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(GRAPH_COLOR_STORAGE_KEY) || "null",
    ) as Partial<GraphColorPreferences> | null;
    if (!parsed || parsed.version !== 1 || !parsed.themes) return empty;

    const themes: GraphColorPreferences["themes"] = {};
    THEMES.forEach((theme) => {
      const source = parsed.themes?.[theme];
      if (!source || typeof source !== "object") return;
      const providers: Partial<Record<Provider, GraphPaint>> = {};
      const accounts: Record<string, GraphPaint> = {};

      (["Claude", "Codex"] as Provider[]).forEach((provider) => {
        const paint = normalizeGraphPaint(source.providers?.[provider]);
        if (paint) providers[provider] = paint;
      });

      Object.entries(source.accounts ?? {}).forEach(([accountId, value]) => {
        const paint = normalizeGraphPaint(value);
        if (accountId && paint) accounts[accountId] = paint;
      });

      if (Object.keys(providers).length || Object.keys(accounts).length) {
        themes[theme] = { providers, accounts };
      }
    });

    return { version: 1, themes };
  } catch {
    return empty;
  }
}

function normalizePercentageToneColors(
  value: unknown,
): PercentageToneColors | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<Record<UsageTone, unknown>>;
  const colors: PercentageToneColors = {};

  (["normal", "warning", "danger"] as UsageTone[]).forEach((tone) => {
    const color = normalizeHex(source[tone]);
    if (color) colors[tone] = color;
  });

  return Object.keys(colors).length ? colors : null;
}

function readPercentageColorPreferences(): PercentageColorPreferences {
  const empty: PercentageColorPreferences = { version: 1, themes: {} };

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PERCENTAGE_COLOR_STORAGE_KEY) || "null",
    ) as Partial<PercentageColorPreferences> | null;
    if (!parsed || parsed.version !== 1 || !parsed.themes) return empty;

    const themes: PercentageColorPreferences["themes"] = {};
    THEMES.forEach((theme) => {
      const source = parsed.themes?.[theme];
      if (!source || typeof source !== "object") return;
      const providers: Partial<Record<Provider, PercentageToneColors>> = {};
      const accounts: Record<string, PercentageToneColors> = {};

      (["Claude", "Codex"] as Provider[]).forEach((provider) => {
        const colors = normalizePercentageToneColors(
          source.providers?.[provider],
        );
        if (colors) providers[provider] = colors;
      });

      Object.entries(source.accounts ?? {}).forEach(([accountId, value]) => {
        const colors = normalizePercentageToneColors(value);
        if (accountId && colors) accounts[accountId] = colors;
      });

      if (Object.keys(providers).length || Object.keys(accounts).length) {
        themes[theme] = { providers, accounts };
      }
    });

    return { version: 1, themes };
  } catch {
    return empty;
  }
}

function readPercentageGraphPreferences(): PercentageGraphPreferences {
  const empty: PercentageGraphPreferences = {
    version: 1,
    providers: {},
    accounts: {},
  };

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PERCENTAGE_GRAPH_STORAGE_KEY) || "null",
    ) as Partial<PercentageGraphPreferences> | null;
    if (!parsed || parsed.version !== 1) return empty;

    const providers: Partial<Record<Provider, boolean>> = {};
    (["Claude", "Codex"] as Provider[]).forEach((provider) => {
      const value = parsed.providers?.[provider];
      if (typeof value === "boolean") providers[provider] = value;
    });

    const accounts: Record<string, boolean> = {};
    Object.entries(parsed.accounts ?? {}).forEach(([accountId, value]) => {
      if (accountId && typeof value === "boolean") {
        accounts[accountId] = value;
      }
    });

    return { version: 1, providers, accounts };
  } catch {
    return empty;
  }
}

function graphPaintBackground(paint: GraphPaint) {
  return paint.mode === "gradient"
    ? `linear-gradient(${paint.angle}deg, ${paint.start}, ${paint.end})`
    : paint.start;
}

function graphColorInputId(
  scope: GraphColorScope,
  stop: "start" | "end",
  namespace = "settings",
) {
  return `tokencat-graph-${namespace}-${scope.replace(/[^a-zA-Z0-9_-]/g, "-")}-${stop}`;
}

function percentageColorInputId(
  scope: GraphColorScope,
  tone: UsageTone,
  namespace = "settings",
) {
  return `tokencat-percentage-${namespace}-${scope.replace(/[^a-zA-Z0-9_-]/g, "-")}-${tone}`;
}

function hexToRgb(hex: string) {
  const normalized = normalizeHex(hex);
  if (!normalized) return { r: 0, g: 0, b: 0 };
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(first: string, second: string) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixHex(base: string, overlay: string, amount: number) {
  const first = hexToRgb(base);
  const second = hexToRgb(overlay);
  const mix = (start: number, end: number) =>
    Math.round(start + (end - start) * amount)
      .toString(16)
      .padStart(2, "0");

  return `#${mix(first.r, second.r)}${mix(first.g, second.g)}${mix(first.b, second.b)}`.toUpperCase();
}

function bestContrastColor(color: string) {
  return contrastRatio(color, "#000000") >= contrastRatio(color, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF";
}

function clampPercentage(value: unknown) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function normalizeContextTokens(
  value: Partial<IntegrationContextTokens> | null | undefined,
): IntegrationContextTokens | undefined {
  const inputTokens = Math.floor(Number(value?.inputTokens));
  const outputTokens = Math.floor(Number(value?.outputTokens));
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens <= 0
  ) {
    return undefined;
  }
  const contextWindowSize = Math.floor(Number(value?.contextWindowSize));
  const usedPercent = Number(value?.usedPercent);
  const hasUsedPercent =
    value?.usedPercent !== null && value?.usedPercent !== undefined;
  const observedAt =
    typeof value?.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt))
      ? new Date(value.observedAt).toISOString()
      : null;
  return {
    source: "claude-context-window",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    contextWindowSize:
      Number.isSafeInteger(contextWindowSize) && contextWindowSize > 0
        ? contextWindowSize
        : null,
    usedPercent: hasUsedPercent && Number.isFinite(usedPercent)
      ? clampPercentage(usedPercent)
      : null,
    observedAt,
  };
}

function formatTokenCount(value: number, language: Language) {
  return new Intl.NumberFormat(
    language === "ko" ? "ko-KR" : "en-US",
  ).format(value);
}

function formatObservationTime(value: string | null, language: Language) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function updateStatusCopy(state: AppUpdateState, language: Language) {
  const version = state.availableVersion
    ? `v${state.availableVersion}`
    : translate(language, "새 버전", "a new version");
  const progress =
    state.progressPercent === null
      ? null
      : Math.max(0, Math.min(100, Math.round(state.progressPercent)));

  if (!state.supported) {
    return state.distribution === "portable"
      ? {
          title: translate(
            language,
            "설치형 전환이 필요합니다",
            "Installer migration required",
          ),
          detail: translate(
            language,
            "현재 Portable 버전은 자동 교체할 수 없습니다. 설치형을 한 번 설치하면 다음 버전부터 자동 업데이트됩니다.",
            "The current portable build cannot replace itself. Install the setup build once to receive automatic updates from then on.",
          ),
        }
      : {
          title: translate(language, "개발 실행 중", "Development build"),
          detail: translate(
            language,
            "자동 업데이트는 GitHub에서 배포한 Windows 설치형에서 작동합니다.",
            "Automatic updates run in the Windows setup build published on GitHub.",
          ),
        };
  }

  switch (state.status) {
    case "checking":
      return {
        title: translate(
          language,
          "새 버전을 확인하는 중",
          "Checking for updates",
        ),
        detail: translate(
          language,
          "GitHub Releases에서 최신 버전을 확인하고 있습니다.",
          "Checking GitHub Releases for the latest version.",
        ),
      };
    case "available":
      return {
        title: translate(
          language,
          `${version} 다운로드 준비 중`,
          `Preparing ${version}`,
        ),
        detail: translate(
          language,
          "업데이트를 백그라운드에서 자동으로 받습니다.",
          "The update will download automatically in the background.",
        ),
      };
    case "downloading":
      return {
        title: translate(
          language,
          `${version} 다운로드 중${progress === null ? "" : ` · ${progress}%`}`,
          `Downloading ${version}${progress === null ? "" : ` · ${progress}%`}`,
        ),
        detail: translate(
          language,
          "TokenCat을 계속 사용할 수 있습니다. 완료되면 재시작 설치 버튼이 나타납니다.",
          "You can keep using TokenCat. A restart button appears when the download finishes.",
        ),
      };
    case "ready":
      return {
        title: translate(
          language,
          `${version} 설치 준비 완료`,
          `${version} is ready to install`,
        ),
        detail: translate(
          language,
          "지금 재시작하거나 앱을 완전히 종료할 때 자동으로 설치할 수 있습니다.",
          "Restart now, or let TokenCat install it when the app fully quits.",
        ),
      };
    case "up-to-date":
      return {
        title: translate(
          language,
          `최신 버전 v${state.currentVersion}`,
          `Up to date · v${state.currentVersion}`,
        ),
        detail: translate(
          language,
          "새 업데이트가 없습니다. 실행 중에도 주기적으로 다시 확인합니다.",
          "No update is available. TokenCat will keep checking periodically.",
        ),
      };
    case "error":
      return {
        title:
          state.errorCode === "UPDATE_NOT_PUBLISHED"
            ? translate(
                language,
                "공개된 업데이트가 아직 없습니다",
                "No published update yet",
              )
            : translate(
                language,
                "업데이트를 확인하지 못했습니다",
                "Could not check for updates",
              ),
        detail: translate(
          language,
          "현재 버전은 그대로 사용할 수 있습니다. 네트워크가 복구되면 자동으로 다시 시도합니다.",
          "You can keep using this version. TokenCat retries automatically after the connection recovers.",
        ),
      };
    default:
      return {
        title: translate(
          language,
          `자동 업데이트 사용 중 · v${state.currentVersion}`,
          `Automatic updates enabled · v${state.currentVersion}`,
        ),
        detail: translate(
          language,
          "시작 후와 실행 중에 GitHub Releases를 확인하고 새 버전을 자동으로 받습니다.",
          "TokenCat checks GitHub Releases after launch and while running, then downloads new versions automatically.",
        ),
      };
  }
}

function providerFromIntegration(provider: IntegrationProvider): Provider {
  return provider === "claude" ? "Claude" : "Codex";
}

function integrationFromProvider(provider: Provider): IntegrationProvider {
  return provider === "Claude" ? "claude" : "codex";
}

function formatPlanName(plan: string | null, provider: Provider) {
  if (!plan) return provider === "Claude" ? "Claude.ai" : "ChatGPT";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function integrationStatusLabel(
  snapshot: IntegrationSnapshot,
  busy: boolean,
  language: Language = "ko",
) {
  if (busy) return translate(language, "확인 중", "Checking");
  if (String(snapshot.status) === "connecting") {
    return translate(language, "로그인 중", "Signing in");
  }
  if (snapshot.connected) {
    return snapshot.quotas.fiveHour || snapshot.quotas.weekly
      ? translate(
          language,
          "로그인·사용량 확인",
          "Sign-in and usage verified",
        )
      : translate(language, "로그인 확인됨", "Sign-in verified");
  }
  if (snapshot.status === "conflict") {
    return translate(language, "설정 충돌", "Settings conflict");
  }
  if (snapshot.status === "unavailable") {
    return translate(language, "CLI 없음", "CLI unavailable");
  }
  if (snapshot.errorCode === "CLAUDE_API_MODE_UNSUPPORTED") {
    return translate(language, "API 키 모드", "API key mode");
  }
  if (snapshot.errorCode === "CLAUDE_SUBSCRIPTION_UNSUPPORTED") {
    return translate(language, "Pro·Max 필요", "Pro or Max required");
  }
  if (snapshot.errorCode?.endsWith("_NOT_AUTHENTICATED")) {
    return translate(language, "로그인 필요", "Sign-in required");
  }
  if (snapshot.status === "error") {
    return translate(language, "확인 필요", "Needs attention");
  }
  return translate(language, "연결 안 됨", "Not connected");
}

function getManagedBridge() {
  return window.tokenCat as
    | (NonNullable<Window["tokenCat"]> & ManagedIntegrationBridge)
    | undefined;
}

function managedSnapshotDetails(snapshot: IntegrationSnapshot) {
  return snapshot as IntegrationSnapshot & ManagedSnapshotFields;
}

function managedAccountId(snapshot: IntegrationSnapshot) {
  const accountId = managedSnapshotDetails(snapshot).accountId;
  return typeof accountId === "string" && accountId.trim()
    ? accountId.trim()
    : null;
}

function integrationSnapshotKey(snapshot: IntegrationSnapshot) {
  const accountId = managedAccountId(snapshot);
  return accountId
    ? `managed:${snapshot.provider}:${accountId}`
    : `system:${snapshot.provider}`;
}

function integrationSnapshotSignature(snapshot: IntegrationSnapshot) {
  const {
    lastUpdatedAt,
    authVerifiedAt: _authVerifiedAt,
    ...content
  } = snapshot;
  return JSON.stringify({
    ...content,
    observationDay: lastUpdatedAt?.slice(0, 10) ?? null,
  });
}

function managedAccountIdFromConnection(connectionId?: string) {
  const prefix = "managed-";
  return connectionId?.startsWith(prefix)
    ? connectionId.slice(prefix.length)
    : null;
}

function integrationFailureMessage(
  snapshot: IntegrationSnapshot,
  language: Language = "ko",
) {
  const provider = providerFromIntegration(snapshot.provider);
  if (snapshot.status === "conflict") {
    return translate(
      language,
      "기존 Claude 상태줄이 있어 안전을 위해 변경하지 않았습니다.",
      "An existing Claude status line was left unchanged for safety.",
    );
  }
  if (snapshot.status === "unavailable") {
    return translate(
      language,
      `${provider} CLI를 먼저 설치해 주세요.`,
      `Install the ${provider} CLI first.`,
    );
  }
  if (snapshot.errorCode === "CLAUDE_API_MODE_UNSUPPORTED") {
    return translate(
      language,
      "Claude API 키 모드가 감지됐습니다. Pro·Max Claude.ai 로그인으로 전환해 주세요.",
      "Claude API key mode was detected. Switch to a Pro or Max Claude.ai sign-in.",
    );
  }
  if (snapshot.errorCode === "CLAUDE_SUBSCRIPTION_UNSUPPORTED") {
    return translate(
      language,
      "Claude 실제 한도 연동은 현재 Pro·Max 구독에서 사용할 수 있습니다.",
      "Live Claude limits currently require a Pro or Max subscription.",
    );
  }
  if (snapshot.errorCode?.endsWith("_NOT_AUTHENTICATED")) {
    return translate(
      language,
      `${provider} CLI에서 먼저 로그인해 주세요.`,
      `Sign in with the ${provider} CLI first.`,
    );
  }
  if (
    snapshot.errorCode === "CLAUDE_LOGIN_FAILED" ||
    snapshot.errorCode === "CLAUDE_LOGIN_TIMEOUT" ||
    snapshot.errorCode === "CLAUDE_PROCESS_ERROR"
  ) {
    return translate(
      language,
      "Claude 로그인을 완료하지 못했습니다. 연결을 다시 눌러 로그인해 주세요.",
      "Claude sign-in did not finish. Connect again to retry.",
    );
  }
  return translate(
    language,
    `${provider} 연동을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.`,
    `TokenCat could not verify the ${provider} connection. Try again shortly.`,
  );
}

function formatQuotaReset(
  resetsAt: string | null,
  language: Language = "ko",
) {
  if (!resetsAt) {
    return translate(language, "다음 사용 후 갱신", "Updates after next use");
  }
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) {
    return translate(language, "초기화 시각 확인 중", "Checking reset time");
  }

  const now = Date.now();
  const remainingMinutes = Math.max(
    0,
    Math.ceil((reset.getTime() - now) / 60_000),
  );
  if (remainingMinutes < 1) {
    return translate(language, "곧 초기화", "Resets soon");
  }
  if (remainingMinutes < 60) {
    return translate(
      language,
      `${remainingMinutes}분 후`,
      `in ${remainingMinutes} min`,
    );
  }
  if (remainingMinutes < 24 * 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return minutes
      ? translate(
          language,
          `${hours}시간 ${minutes}분 후`,
          `in ${hours} hr ${minutes} min`,
        )
      : translate(language, `${hours}시간 후`, `in ${hours} hr`);
  }

  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ko-KR", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(reset);
}

function localizeStoredReset(reset: string, language: Language) {
  if (language === "ko") return reset;
  const normalized = reset.trim();
  const hoursMinutes = normalized.match(/^(\d+)시간\s+(\d+)분\s+후$/);
  if (hoursMinutes) {
    return `in ${hoursMinutes[1]} hr ${hoursMinutes[2]} min`;
  }
  const hours = normalized.match(/^(\d+)시간\s+후$/);
  if (hours) return `in ${hours[1]} hr`;
  const minutes = normalized.match(/^(\d+)분\s+후$/);
  if (minutes) return `in ${minutes[1]} min`;

  const known: Record<string, string> = {
    "월요일 오전 9시": "Monday 9:00 AM",
    "다음 사용 후 갱신": "Updates after next use",
    "초기화 시각 확인 중": "Checking reset time",
    "곧 초기화": "Resets soon",
    "직접 입력": "Manual",
    "이 플랜에는 표시되지 않음": "Not available on this plan",
  };
  return known[normalized] ?? reset;
}

function fallbackAccountName(
  provider: Provider,
  language: Language,
  local = false,
) {
  return local
    ? translate(
        language,
        `${provider} · 로컬 계정`,
        `${provider} · Local account`,
      )
    : translate(language, `${provider} 계정`, `${provider} account`);
}

function accountDisplayName(account: Account, language: Language) {
  if (language !== "en") return account.name;
  if (account.origin === "demo") {
    if (account.id === "claude-work") return "Claude · Work";
    if (account.id === "codex-personal") return "Codex · Personal";
    if (account.id === "claude-side") return "Claude · Side";
  }
  if (account.name === `${account.provider} 계정`) {
    return fallbackAccountName(account.provider, language);
  }
  if (account.name === `${account.provider} · 로컬 계정`) {
    return fallbackAccountName(account.provider, language, true);
  }
  return account.name;
}

function accountFromIntegration(
  snapshot: IntegrationSnapshot,
  previous?: Account,
  language: Language = "ko",
): Account {
  const provider = providerFromIntegration(snapshot.provider);
  const accountId = managedAccountId(snapshot);
  const isManaged = Boolean(accountId);
  const managedDetails = managedSnapshotDetails(snapshot);
  const fiveHour = snapshot.quotas.fiveHour;
  const weekly = snapshot.quotas.weekly;
  const previousHasUsage =
    previous?.quotas.fiveHour.visible || previous?.quotas.weekly.visible;
  const hasUsage = Boolean(fiveHour || weekly);
  const isAuthenticationFailure =
    snapshot.errorCode?.endsWith("_NOT_AUTHENTICATED") === true;
  const isTransientFailure =
    Boolean(previousHasUsage) &&
    snapshot.status === "error" &&
    !isAuthenticationFailure;

  return {
    id: accountId
      ? `live-${snapshot.provider}-${accountId}`
      : previous?.id ?? `live-${snapshot.provider}-local`,
    provider,
    name: isManaged
      ? managedDetails.displayName?.trim() ||
        previous?.name ||
        fallbackAccountName(provider, language)
      : previous?.name ?? fallbackAccountName(provider, language, true),
    plan: snapshot.plan
      ? formatPlanName(snapshot.plan, provider)
      : previous?.plan ?? formatPlanName(null, provider),
    quotas: {
      fiveHour: fiveHour
        ? {
            used: clampPercentage(fiveHour.usedPercent),
            reset: formatQuotaReset(fiveHour.resetsAt, language),
            resetsAt: fiveHour.resetsAt,
            visible: true,
          }
        : isTransientFailure && previous
          ? previous.quotas.fiveHour
          : {
            used: 0,
            reset: "이 플랜에는 표시되지 않음",
            visible: false,
          },
      weekly: weekly
        ? {
            used: clampPercentage(weekly.usedPercent),
            reset: formatQuotaReset(weekly.resetsAt, language),
            resetsAt: weekly.resetsAt,
            visible: true,
          }
        : isTransientFailure && previous
          ? previous.quotas.weekly
          : {
            used: 0,
            reset: "다음 사용 후 갱신",
            visible: false,
          },
    },
    iconMode: previous?.iconMode ?? "default",
    customIcon: previous?.customIcon,
    origin: "live",
    connectionId: accountId
      ? `managed-${accountId}`
      : `local-${snapshot.provider}`,
    syncState:
      isTransientFailure
      ? "stale"
      : snapshot.errorCode ||
      String(snapshot.status) === "error" ||
      (isManaged &&
        !snapshot.connected &&
        String(snapshot.status) !== "connecting" &&
        Boolean(snapshot.lastUpdatedAt))
      ? "error"
      : snapshot.connected && hasUsage
        ? "idle"
        : "waiting",
    lastSyncedAt: snapshot.lastUpdatedAt ?? previous?.lastSyncedAt,
    contextTokens:
      normalizeContextTokens(snapshot.contextTokens) ??
      (isTransientFailure ? previous?.contextTokens : undefined),
  };
}

function normalizeQuota(
  quota: unknown,
  fallback: Quota,
  defaultVisible: boolean,
): Quota {
  const candidate =
    quota !== null && typeof quota === "object" && !Array.isArray(quota)
      ? (quota as Partial<Quota>)
      : undefined;
  return {
    used: clampPercentage(candidate?.used ?? fallback.used),
    reset:
      typeof candidate?.reset === "string" && candidate.reset.trim()
        ? candidate.reset
        : fallback.reset,
    resetsAt:
      typeof candidate?.resetsAt === "string" ||
      candidate?.resetsAt === null
        ? candidate.resetsAt
        : fallback.resetsAt,
    visible:
      typeof candidate?.visible === "boolean"
        ? candidate.visible
        : defaultVisible,
  };
}

function migrateAccounts(value: unknown): Account[] {
  if (!Array.isArray(value)) return [];
  if (!value.length) return [];

  return value.flatMap((raw, index) => {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      ((raw as { provider?: unknown }).provider !== "Claude" &&
        (raw as { provider?: unknown }).provider !== "Codex")
    ) {
      return [];
    }
    const legacy = raw as Partial<Account> & {
      usage?: number;
      reset?: string;
      quotas?: Partial<Record<QuotaKey, Partial<Quota>>>;
    };
    const provider = (raw as { provider: Provider }).provider;
    const fallback = MIGRATION_QUOTA_FALLBACKS[provider];
    const legacyUsage = clampPercentage(
      legacy.usage ?? fallback.weekly.used,
    );
    const iconMode: AccountIconMode =
      legacy.iconMode === "default" ||
      legacy.iconMode === "pet" ||
      legacy.iconMode === "initial" ||
      legacy.iconMode === "none" ||
      legacy.iconMode === "custom"
        ? legacy.iconMode
        : "default";

    return [{
      id:
        typeof legacy.id === "string" && legacy.id.trim()
          ? legacy.id
          : `${provider.toLowerCase()}-${index}`,
      provider,
      name:
        typeof legacy.name === "string"
          ? legacy.name
          : `${provider} 계정`,
      plan: typeof legacy.plan === "string" ? legacy.plan : "구독",
      quotas: {
        fiveHour: normalizeQuota(
          legacy.quotas?.fiveHour ??
            (legacy.usage !== undefined
              ? { used: legacyUsage, reset: legacy.reset }
              : undefined),
          fallback.fiveHour,
          provider === "Claude",
        ),
        weekly: normalizeQuota(
          legacy.quotas?.weekly ??
            (legacy.usage !== undefined
              ? { used: Math.round(legacyUsage * 0.7), reset: "직접 입력" }
              : undefined),
          fallback.weekly,
          true,
        ),
      },
      iconMode,
      customIcon:
        typeof legacy.customIcon === "string"
          ? legacy.customIcon
          : undefined,
      origin:
        legacy.origin === "live" ||
        legacy.origin === "manual" ||
        legacy.origin === "demo"
          ? legacy.origin
          : "manual",
      connectionId:
        typeof legacy.connectionId === "string"
          ? legacy.connectionId
          : undefined,
      syncState:
        legacy.syncState === "waiting" ||
        legacy.syncState === "stale" ||
        legacy.syncState === "error"
          ? legacy.syncState
          : "idle",
      lastSyncedAt:
        typeof legacy.lastSyncedAt === "string"
          ? legacy.lastSyncedAt
          : undefined,
      contextTokens: normalizeContextTokens(legacy.contextTokens),
    }];
  });
}

type AccountBootstrap = {
  status: AccountStorageStatus;
  accounts: Account[];
  shouldStartOnboarding: boolean;
};

function readAccountBootstrap(): AccountBootstrap {
  const parsed = parseAccountStorage(
    window.localStorage.getItem(ACCOUNT_STORAGE_KEY),
  );
  return {
    status: parsed.status,
    accounts:
      parsed.status === "valid" ? migrateAccounts(parsed.accounts) : [],
    shouldStartOnboarding: parsed.shouldStartOnboarding,
  };
}

function readProviderIcons(): ProviderIcons {
  try {
    const stored = window.localStorage.getItem("tokencat-provider-icons");
    if (!stored) return DEFAULT_PROVIDER_ICONS;
    const parsed = JSON.parse(stored) as Partial<ProviderIcons>;
    return {
      Claude: parsed.Claude ?? "pet",
      Codex: parsed.Codex ?? "pet",
    };
  } catch {
    return DEFAULT_PROVIDER_ICONS;
  }
}

function resolveIconMode(
  accountMode: AccountIconMode,
  provider: Provider,
  providerIcons: ProviderIcons,
) {
  return accountMode === "default" ? providerIcons[provider] : accountMode;
}

function getQuotaTone(used: number): UsageTone {
  if (used >= 90) return "danger";
  if (used >= 70) return "warning";
  return "normal";
}

function graphPaintForQuota(
  paint: GraphPaint,
  percentageColors: Record<UsageTone, string>,
  used: number,
  graphFollowsUsage: boolean,
): GraphPaint {
  if (!graphFollowsUsage) return paint;
  const color = percentageColors[getQuotaTone(used)];
  return {
    mode: "solid",
    start: color,
    end: color,
    angle: paint.angle,
  };
}

function splitResetLabel(reset: string) {
  const normalized = reset.trim().replace(/\s+/g, " ") || "직접 입력";
  const dayPeriodIndex = normalized.search(/\s(?:오전|오후)\s/);

  if (dayPeriodIndex > 0) {
    const primary = normalized.slice(0, dayPeriodIndex);
    return {
      primary,
      secondary: normalized.slice(dayPeriodIndex + 1),
      dense: primary.replace(/\s/g, "").length > 5,
    };
  }

  const englishTime = normalized.match(
    /^(.+?)\s+(\d{1,2}:\d{2}\s+(?:AM|PM))$/i,
  );
  if (englishTime) {
    return {
      primary: englishTime[1],
      secondary: englishTime[2],
      dense: englishTime[1].replace(/\s/g, "").length > 5,
    };
  }

  const parts = normalized.split(" ");
  if (parts.length === 1) {
    return {
      primary: normalized,
      secondary: "",
      dense: normalized.length > 5,
    };
  }

  const lastPart = parts.at(-1) ?? "";
  const splitIndex =
    lastPart === "후" || lastPart.includes(":")
      ? parts.length - 1
      : Math.ceil(parts.length / 2);
  const primary = parts.slice(0, splitIndex).join(" ");

  return {
    primary,
    secondary: parts.slice(splitIndex).join(" "),
    dense: primary.replace(/\s/g, "").length > 5,
  };
}

function quotaLabel(key: QuotaKey, language: Language = "ko") {
  if (key === "fiveHour") {
    return translate(language, "5시간", "5-hour");
  }
  return translate(language, "주간", "Weekly");
}

function visibleQuotas(account: Account, language: Language = "ko") {
  return (["fiveHour", "weekly"] as QuotaKey[])
    .filter((key) => {
      const quota = account.quotas[key];
      if (!quota.visible) return false;
      if (account.origin !== "live" || !quota.resetsAt) return true;

      const resetsAt = Date.parse(quota.resetsAt);
      return !Number.isFinite(resetsAt) || resetsAt > Date.now();
    })
    .map((key) => ({
      key,
      label: quotaLabel(key, language),
      quota: account.quotas[key],
    }));
}

function highestVisibleUsage(account: Account) {
  const values = visibleQuotas(account).map(({ quota }) => quota.used);
  return values.length ? Math.max(...values) : 0;
}

function PetAvatar({
  provider,
  accountMode = "default",
  providerIcons,
  customIcon,
  size = "medium",
  motion = false,
  working = false,
  usage = 0,
  language = "ko",
}: {
  provider: Provider;
  accountMode?: AccountIconMode;
  providerIcons: ProviderIcons;
  customIcon?: string;
  size?: "small" | "medium" | "large";
  motion?: boolean;
  working?: boolean;
  usage?: number;
  language?: Language;
}) {
  const mode = resolveIconMode(accountMode, provider, providerIcons);
  const activity =
    usage >= 90 ? "alert" : usage >= 70 ? "watch" : "calm";
  const className = [
    "pet-avatar",
    `pet-avatar--${size}`,
    motion ? "pet-avatar--motion" : "",
    working && motion ? "pet-avatar--working" : "",
    `pet-avatar--${activity}`,
  ]
    .filter(Boolean)
    .join(" ");

  if (mode === "none") return null;

  if (mode === "custom" && customIcon) {
    return (
      <span className={className}>
        <img
          src={customIcon}
          alt={translate(
            language,
            `${provider} 계정 펫`,
            `${provider} account pet`,
          )}
        />
        <i aria-hidden="true" />
      </span>
    );
  }

  if (mode === "pet") {
    if (provider === "Claude") {
      return (
        <span
          className={`${className} pet-avatar--official pet-avatar--clawd`}
          role="img"
          aria-label={translate(
            language,
            "Claude 공식 Clawd 펫",
            "Official Claude Clawd pet",
          )}
        >
          {working && motion ? (
            <img
              className="pet-media pet-media--active"
              src={CLAUDE_PET_ACTIVE}
              alt=""
            />
          ) : (
            <img
              className="pet-media pet-media--idle"
              src={CLAUDE_PET_IDLE}
              alt=""
            />
          )}
          <i aria-hidden="true" />
        </span>
      );
    }

    return (
      <span
        className={`${className} pet-avatar--official pet-avatar--codex-pet`}
        role="img"
        aria-label={translate(
          language,
          "Codex 공식 companion 펫",
          "Official Codex companion pet",
        )}
      >
        {working && motion ? (
          <img
            className="pet-media pet-media--active"
            src={CODEX_PET_ACTIVE}
            alt=""
          />
        ) : (
          <img
            className="pet-media pet-media--idle"
            src={CODEX_PET_IDLE}
            alt=""
          />
        )}
        <i aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className={`${className} pet-avatar--initial pet-avatar--${provider.toLowerCase()}`}
      aria-hidden="true"
    >
      {provider === "Claude" ? "C" : "⌘"}
      <i />
    </span>
  );
}

function ContextTokenUsage({
  tokens,
  mode,
  language,
}: {
  tokens: IntegrationContextTokens;
  mode: Exclude<TokenDisplayMode, "hidden">;
  language: Language;
}) {
  const t = (korean: string, english: string) =>
    translate(language, korean, english);
  const input = formatTokenCount(tokens.inputTokens, language);
  const output = formatTokenCount(tokens.outputTokens, language);
  const total = formatTokenCount(tokens.totalTokens, language);
  const observedAt = formatObservationTime(tokens.observedAt, language);
  const description = t(
    `Claude Code 최신 컨텍스트 입력 ${input} + 출력 ${output} = ${total} 토큰${
      observedAt ? ` · ${observedAt} 수신` : ""
    }. 구독 한도에서 사용된 총 토큰은 아닙니다.`,
    `Latest Claude Code context: ${input} input + ${output} output = ${total} tokens${
      observedAt ? ` · received ${observedAt}` : ""
    }. This is not the total token usage against your subscription limit.`,
  );

  return (
    <span
      className={`context-token-usage context-token-usage--${mode}`}
      title={description}
      aria-label={description}
    >
      <span>{t("현재 컨텍스트", "Current context")}</span>
      {mode === "detail" ? (
        <strong>
          {t(`입력 ${input} · 출력 ${output}`, `In ${input} · Out ${output}`)}
        </strong>
      ) : (
        <strong>
          {total} <small>{t("토큰", "tokens")}</small>
        </strong>
      )}
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`toggle ${checked ? "toggle--on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SizeRangeControl({
  id,
  label,
  description,
  value,
  minimum,
  maximum,
  onChange,
  disabled = false,
  unit = "%",
  step = 5,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  minimum: number;
  maximum: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  unit?: string;
  step?: number;
}) {
  return (
    <div className="size-control">
      <label htmlFor={id}>
        <strong>{label}</strong>
        <small>{description}</small>
      </label>
      <div className="size-control__slider">
        <input
          id={id}
          type="range"
          min={minimum}
          max={maximum}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          aria-valuetext={`${value}${unit}`}
        />
        <output htmlFor={id}>
          {value}
          {unit}
        </output>
      </div>
    </div>
  );
}

function QuotaRing({
  label,
  quota,
  paint,
  percentageColors,
  gradientId,
  language,
}: {
  label: string;
  quota: Quota;
  paint: GraphPaint;
  percentageColors: Record<UsageTone, string>;
  gradientId: string;
  language: Language;
}) {
  const radius = 37;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - quota.used / 100);
  const tone = getQuotaTone(quota.used);
  const exhausted = quota.used >= 100;
  const resetText = quota.resetsAt
    ? formatQuotaReset(quota.resetsAt, language)
    : localizeStoredReset(quota.reset, language);
  const resetLabel = splitResetLabel(resetText);
  const resetWord = translate(language, "초기화", "reset");
  const exhaustedLabel = translate(language, "한도 소진", "Limit reached");
  const progressStroke =
    paint.mode === "gradient" ? `url(#${gradientId})` : paint.start;

  return (
    <div
      className={`quota-ring quota-ring--${tone} ${exhausted ? "quota-ring--exhausted" : ""}`}
      title={`${label} ${quota.used}% · ${resetText} ${resetWord}`}
      style={{ color: percentageColors[tone] }}
    >
      <div
        className="quota-ring__visual"
        role="meter"
        aria-label={translate(
          language,
          `${label} 한도 ${quota.used}% 사용${exhausted ? `, ${resetText} 초기화` : ""}`,
          `${label} limit ${quota.used}% used${exhausted ? `, resets ${resetText}` : ""}`,
        )}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={quota.used}
        aria-valuetext={
          exhausted
            ? translate(
                language,
                `한도 소진, ${resetText} 초기화`,
                `Limit reached, resets ${resetText}`,
              )
            : undefined
        }
      >
        <svg viewBox="0 0 88 88" aria-hidden="true">
          {paint.mode === "gradient" && (
            <defs>
              <linearGradient
                id={gradientId}
                x1="0"
                y1="0.5"
                x2="1"
                y2="0.5"
                gradientTransform={`rotate(${paint.angle} 0.5 0.5)`}
              >
                <stop offset="0%" stopColor={paint.start} />
                <stop offset="100%" stopColor={paint.end} />
              </linearGradient>
            </defs>
          )}
          <circle className="quota-ring__track" cx="44" cy="44" r={radius} />
          <circle
            className="quota-ring__progress"
            cx="44"
            cy="44"
            r={radius}
            pathLength={circumference}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ stroke: progressStroke }}
          />
        </svg>
        {exhausted ? (
          <span
            className={`quota-ring__reset-center ${resetLabel.dense ? "quota-ring__reset-center--dense" : ""}`}
            aria-hidden="true"
          >
            <strong>{resetLabel.primary}</strong>
            {resetLabel.secondary ? (
              <small>{resetLabel.secondary}</small>
            ) : null}
          </span>
        ) : (
          <span className="quota-ring__percentage" aria-hidden="true">
            <strong>{quota.used}</strong>
            <small>%</small>
          </span>
        )}
      </div>
      <strong className="quota-ring__label">{label}</strong>
      <small
        className={`quota-ring__reset ${exhausted ? "quota-ring__reset--exhausted" : ""}`}
      >
        {exhausted ? exhaustedLabel : resetText}
      </small>
    </div>
  );
}

function QuotaBar({
  label,
  quota,
  paint,
  percentageColors,
  language,
}: {
  label: string;
  quota: Quota;
  paint: GraphPaint;
  percentageColors: Record<UsageTone, string>;
  language: Language;
}) {
  const tone = getQuotaTone(quota.used);
  const resetText = quota.resetsAt
    ? formatQuotaReset(quota.resetsAt, language)
    : localizeStoredReset(quota.reset, language);

  return (
    <div
      className={`quota-bar quota-bar--${tone}`}
      style={{ color: percentageColors[tone] }}
    >
      <div>
        <strong>{label}</strong>
        <span>{resetText}</span>
        <b>
          {quota.used}
          <small>%</small>
        </b>
      </div>
      <div
        className="quota-bar__track"
        role="meter"
        aria-label={translate(
          language,
          `${label} 한도 ${quota.used}% 사용`,
          `${label} limit ${quota.used}% used`,
        )}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={quota.used}
      >
        <span
          style={{
            width: `${quota.used}%`,
            background: graphPaintBackground(paint),
          }}
        />
      </div>
    </div>
  );
}

function GraphPaintControls({
  scope,
  paint,
  provider,
  language,
  inputNamespace,
  onModeChange,
  onPatch,
  onPick,
}: {
  scope: GraphColorScope;
  paint: GraphPaint;
  provider: Provider;
  language: Language;
  inputNamespace: string;
  onModeChange: (scope: GraphColorScope, mode: GraphPaintMode) => void;
  onPatch: (
    scope: GraphColorScope,
    patch: Partial<GraphPaint>,
  ) => boolean;
  onPick: (
    scope: GraphColorScope,
    stop: "start" | "end",
    inputNamespace: string,
  ) => Promise<void>;
}) {
  const t = (korean: string, english: string) =>
    translate(language, korean, english);

  return (
    <div className="graph-paint-editor">
      <div
        className="graph-paint-preview"
        style={{ background: graphPaintBackground(paint) }}
        aria-label={t(
          `${provider} 그래프 색상 미리보기`,
          `${provider} graph color preview`,
        )}
      >
        <span>{paint.start}</span>
        {paint.mode === "gradient" && <span>{paint.end}</span>}
      </div>

      <div
        className="segmented-control graph-mode-control"
        aria-label={t("색상 방식", "Color mode")}
      >
        {(
          [
            ["solid", t("단색", "Solid")],
            ["gradient", t("그라데이션", "Gradient")],
          ] as Array<[GraphPaintMode, string]>
        ).map(([mode, label]) => (
          <button
            type="button"
            className={paint.mode === mode ? "is-active" : ""}
            onClick={() => onModeChange(scope, mode)}
            aria-pressed={paint.mode === mode}
            key={mode}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="graph-color-stops">
        {(
          [
            ["start", t("시작 색상", "Start color")],
            ["end", t("끝 색상", "End color")],
          ] as Array<["start" | "end", string]>
        )
          .filter(([stop]) => stop === "start" || paint.mode === "gradient")
          .map(([stop, label]) => {
            const value = paint[stop];
            return (
              <div className="graph-color-stop" key={stop}>
                <span>{label}</span>
                <input
                  id={graphColorInputId(scope, stop, inputNamespace)}
                  type="color"
                  value={value}
                  onChange={(event) =>
                    onPatch(scope, { [stop]: event.currentTarget.value })
                  }
                  aria-label={label}
                />
                <code>{value}</code>
                <button
                  type="button"
                  className="eyedropper-button"
                  onClick={() => void onPick(scope, stop, inputNamespace)}
                  title={t(
                    "화면에서 색상 가져오기",
                    "Pick a color from the screen",
                  )}
                >
                  <span aria-hidden="true">⌾</span>
                  {t("스포이트", "Pick")}
                </button>
              </div>
            );
          })}
      </div>

      {paint.mode === "gradient" && (
        <label className="graph-angle-field">
          <span>{t("그라데이션 방향", "Gradient direction")}</span>
          <input
            type="range"
            min="0"
            max="360"
            step="15"
            value={paint.angle}
            onChange={(event) =>
              onPatch(scope, { angle: Number(event.currentTarget.value) })
            }
          />
          <output>{paint.angle}°</output>
        </label>
      )}
    </div>
  );
}

function PercentageToneControls({
  scope,
  colors,
  provider,
  language,
  inputNamespace,
  hasOverride,
  graphFollowsUsage,
  graphModeInherited,
  onChange,
  onGraphModeChange,
  onGraphModeReset,
  onReset,
  onPick,
}: {
  scope: GraphColorScope;
  colors: Record<UsageTone, string>;
  provider: Provider;
  language: Language;
  inputNamespace: string;
  hasOverride: boolean;
  graphFollowsUsage: boolean;
  graphModeInherited: boolean;
  onChange: (
    scope: GraphColorScope,
    tone: UsageTone,
    value: string,
  ) => boolean;
  onGraphModeChange: (
    scope: GraphColorScope,
    enabled: boolean,
  ) => void;
  onGraphModeReset: (scope: GraphColorScope) => void;
  onReset: (scope: GraphColorScope) => void;
  onPick: (
    scope: GraphColorScope,
    tone: UsageTone,
    inputNamespace: string,
  ) => Promise<void>;
}) {
  const t = (korean: string, english: string) =>
    translate(language, korean, english);
  const options: Array<[UsageTone, string, string, string]> = [
    ["normal", t("보통", "Normal"), "0–69%", "50%"],
    ["warning", t("주의", "Warning"), "70–89%", "78%"],
    ["danger", t("위험", "Danger"), "90%+", "95%"],
  ];

  return (
    <section className="percentage-tone-editor">
      <header className="percentage-tone-editor__heading">
        <div>
          <strong>{t("사용량 단계 색상", "Usage level colors")}</strong>
          <span>
            {t(
              "숫자 색상을 지정하고 필요하면 그래프에도 적용합니다",
              "Set number colors and optionally apply them to graphs",
            )}
          </span>
        </div>
        <button
          type="button"
          className="color-reset-all"
          onClick={() => onReset(scope)}
          disabled={!hasOverride}
        >
          {scope.startsWith("account:")
            ? t("모두 상속", "Inherit all")
            : t("기본값 복원", "Restore defaults")}
        </button>
      </header>
      <div className="percentage-tone-editor__graph-toggle">
        <div>
          <strong>
            {t(
              "그래프에도 단계 색상 적용",
              "Apply level colors to graphs",
            )}
          </strong>
          <small>
            {t(
              "원형 진행선과 막대 채움에 적용되며 기존 단색·그라데이션보다 우선합니다",
              "Overrides the existing solid or gradient paint for ring progress and bar fills",
            )}
          </small>
          <span>
            {scope.startsWith("account:")
              ? graphModeInherited
                ? t(
                    `${provider} 전체 설정 상속 중 · 현재 ${graphFollowsUsage ? "켜짐" : "꺼짐"}`,
                    `Inherited from all ${provider} accounts · currently ${graphFollowsUsage ? "on" : "off"}`,
                  )
                : t(
                    `이 계정에서 직접 설정 · ${graphFollowsUsage ? "켜짐" : "꺼짐"}`,
                    `Set for this account · ${graphFollowsUsage ? "on" : "off"}`,
                  )
              : graphModeInherited
                ? t(
                    `앱 기본값 · 현재 꺼짐`,
                    "App default · currently off",
                  )
                : t(
                    `${provider} 전체에 직접 설정 · ${graphFollowsUsage ? "켜짐" : "꺼짐"}`,
                    `Set for all ${provider} accounts · ${graphFollowsUsage ? "on" : "off"}`,
                  )}
          </span>
        </div>
        <div className="percentage-tone-editor__graph-actions">
          {!graphModeInherited && (
            <button
              type="button"
              onClick={() => onGraphModeReset(scope)}
            >
              {scope.startsWith("account:")
                ? t(`${provider} 설정 사용`, `Use ${provider} setting`)
                : t("앱 기본값 사용", "Use app default")}
            </button>
          )}
          <Toggle
            checked={graphFollowsUsage}
            onChange={(enabled) => onGraphModeChange(scope, enabled)}
            label={t(
              "그래프에도 단계 색상 적용",
              "Apply level colors to graphs",
            )}
          />
        </div>
      </div>
      <div className="percentage-tone-list">
        {options.map(([tone, label, range, sample]) => (
          <div className="percentage-tone-row" key={tone}>
            <div className="percentage-tone-row__label">
              <b style={{ color: colors[tone] }}>{sample}</b>
              <span>
                <strong>{label}</strong>
                <small>{range}</small>
              </span>
            </div>
            <input
              id={percentageColorInputId(scope, tone, inputNamespace)}
              type="color"
              value={colors[tone]}
              onChange={(event) =>
                onChange(scope, tone, event.currentTarget.value)
              }
              aria-label={t(
                `${label} ${range} 퍼센트 글자색`,
                `${label} ${range} percentage color`,
              )}
            />
            <code>{colors[tone]}</code>
            <button
              type="button"
              className="eyedropper-button"
              onClick={() =>
                void onPick(scope, tone, inputNamespace)
              }
              title={t(
                "화면에서 색상 가져오기",
                "Pick a color from the screen",
              )}
            >
              <span aria-hidden="true">⌾</span>
              {t("스포이트", "Pick")}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuotaFields({
  prefix,
  label,
  defaultUsed,
  defaultReset = "",
  defaultVisible,
  language,
}: {
  prefix: QuotaKey;
  label: string;
  defaultUsed: number;
  defaultReset?: string;
  defaultVisible: boolean;
  language: Language;
}) {
  const [visible, setVisible] = useState(defaultVisible);

  return (
    <fieldset className="quota-fields">
      <legend>
        <span>{label}</span>
        <label className="quota-enable">
          <input
            name={`${prefix}Visible`}
            type="checkbox"
            checked={visible}
            onChange={(event) => setVisible(event.currentTarget.checked)}
          />
          <span>{translate(language, "표시", "Show")}</span>
        </label>
      </legend>
      <div className="quota-fields__content">
        <label className="field percentage-field">
          <span>{translate(language, "사용량", "Usage")}</span>
          <span>
            <input
              name={prefix}
              type="number"
              min="0"
              max="100"
              defaultValue={defaultUsed}
              required={visible}
            />
            <i>%</i>
          </span>
        </label>
        <label className="field">
          <span>{translate(language, "초기화", "Reset")}</span>
          <input
            name={`${prefix}Reset`}
            defaultValue={defaultReset}
            placeholder={
              prefix === "fiveHour"
                ? translate(language, "2시간 14분 후", "in 2 hr 14 min")
                : translate(language, "월요일 오전 9시", "Monday 9:00 AM")
            }
            required={visible}
          />
        </label>
      </div>
    </fieldset>
  );
}

function AppViewTabs({
  activeView,
  language,
  onChange,
}: {
  activeView: AppView;
  language: Language;
  onChange: (view: AppView) => void;
}) {
  const views: Array<[AppView, string]> = [
    ["usage", translate(language, "사용량", "Usage")],
    ["insights", translate(language, "사용 분석", "Insights")],
  ];

  return (
    <nav
      className="app-view-tabs"
      role="tablist"
      aria-label={translate(language, "화면 선택", "Choose view")}
    >
      {views.map(([view, label]) => (
        <button
          id={`app-view-tab-${view}`}
          type="button"
          role="tab"
          aria-selected={activeView === view}
          aria-controls={`app-view-panel-${view}`}
          tabIndex={activeView === view ? 0 : -1}
          className={activeView === view ? "is-active" : ""}
          onClick={() => onChange(view)}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                event.key,
              )
            ) {
              return;
            }
            event.preventDefault();
            const nextView =
              event.key === "Home" || event.key === "ArrowLeft"
                ? "usage"
                : "insights";
            onChange(nextView);
            window.requestAnimationFrame(() =>
              document.getElementById(`app-view-tab-${nextView}`)?.focus(),
            );
          }}
          key={view}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function MinimalUsageStrip({
  accounts,
  language,
  orientation,
  graphMode,
  providerIcons,
  petMotion,
  syncing,
  getGraphPaint,
  getPercentageColors,
  getPercentageGraphEnabled,
  chromeVisible,
  onRevealTitlebar,
}: {
  accounts: Account[];
  language: Language;
  orientation: MinimalOrientation;
  graphMode: MinimalGraphMode;
  providerIcons: ProviderIcons;
  petMotion: boolean;
  syncing: boolean;
  getGraphPaint: (account: Account) => GraphPaint;
  getPercentageColors: (account: Account) => Record<UsageTone, string>;
  getPercentageGraphEnabled: (account: Account) => boolean;
  chromeVisible: boolean;
  onRevealTitlebar: () => void;
}) {
  const t = (korean: string, english: string) =>
    translate(language, korean, english);

  return (
    <main
      className={`minimal-strip-shell minimal-strip-shell--${orientation} minimal-strip-shell--graph-${graphMode}${
        chromeVisible ? "" : " minimal-strip-shell--chrome-hidden"
      }`}
      aria-label={t("미니멀 사용량 위젯", "Minimal usage widget")}
    >
      <i className="minimal-strip__drag" aria-hidden="true" />
      <div
        className="minimal-strip__viewport"
        tabIndex={accounts.length ? 0 : undefined}
        aria-label={t(
          orientation === "horizontal"
            ? "계정 사용량 가로 목록"
            : orientation === "medium"
              ? "계정 사용량 중간형 목록"
              : "계정 사용량 세로 목록",
          orientation === "horizontal"
            ? "Horizontal account usage"
            : orientation === "medium"
              ? "Medium account usage"
              : "Vertical account usage",
        )}
        onWheel={(event) => {
          if (orientation !== "horizontal") return;
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {accounts.length ? (
          <div
            className="minimal-strip"
            role="list"
            aria-label={t("계정별 사용량", "Usage by account")}
            style={
              {
                "--minimal-account-count": Math.max(1, accounts.length),
                "--minimal-account-basis": `${
                  100 / Math.max(1, accounts.length)
                }%`,
              } as CSSProperties
            }
          >
            {accounts.map((account) => {
              const quotas = visibleQuotas(account, language);
              const graphPaint = getGraphPaint(account);
              const percentageColors = getPercentageColors(account);
              const percentageGraphEnabled =
                getPercentageGraphEnabled(account);
              const displayName = accountDisplayName(account, language);
              const accountLabel = `${displayName} · ${account.provider} · ${account.plan}`;
              const hasPet =
                resolveIconMode(
                  account.iconMode,
                  account.provider,
                  providerIcons,
                ) !== "none";

              return (
                <article
                  className={`minimal-account minimal-account--quota-${Math.min(
                    2,
                    quotas.length,
                  )}${
                    hasPet ? "" : " minimal-account--no-pet"
                  }`}
                  role="listitem"
                  aria-label={accountLabel}
                  title={accountLabel}
                  style={
                    {
                      "--minimal-account-color":
                        graphPaintBackground(graphPaint),
                    } as CSSProperties
                  }
                  key={account.id}
                >
                  <span className="minimal-account__pet" aria-hidden="true">
                    {hasPet && (
                      <PetAvatar
                        provider={account.provider}
                        accountMode={account.iconMode}
                        providerIcons={providerIcons}
                        customIcon={account.customIcon}
                        size="small"
                        motion={petMotion}
                        working={syncing || account.syncState === "waiting"}
                        usage={highestVisibleUsage(account)}
                        language={language}
                      />
                    )}
                    <i className="minimal-account__marker" />
                  </span>
                  {quotas.length ? (
                    <span className="minimal-account__quotas">
                      {quotas.map(({ key, label, quota }) => {
                        const used = clampPercentage(quota.used);
                        const tone = getQuotaTone(used);
                        const quotaPaint = graphPaintForQuota(
                          graphPaint,
                          percentageColors,
                          used,
                          percentageGraphEnabled,
                        );
                        const quotaDescription = t(
                          `${displayName} ${label} 사용량 ${Math.round(
                            used,
                          )}%, 초기화 ${quota.reset}`,
                          `${displayName} ${label} usage ${Math.round(
                            used,
                          )}%, resets ${quota.reset}`,
                        );

                        return (
                          <span
                            className={`minimal-quota minimal-quota--${tone}`}
                            role="meter"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(used)}
                            aria-valuetext={quotaDescription}
                            aria-label={quotaDescription}
                            title={quotaDescription}
                            style={
                              {
                                color: percentageColors[tone],
                                "--minimal-quota-used": used / 100,
                                "--minimal-graph-color": quotaPaint.start,
                                "--minimal-graph-paint":
                                  graphPaintBackground(quotaPaint),
                              } as CSSProperties
                            }
                            key={key}
                          >
                            {graphMode === "ring" ? (
                              <>
                                <span
                                  className="minimal-quota__ring"
                                  aria-hidden="true"
                                >
                                  <i className="minimal-quota__ring-dial" />
                                  <strong className="minimal-quota__ring-value">
                                    {Math.round(used)}
                                    <small>%</small>
                                  </strong>
                                </span>
                                <span
                                  className="minimal-quota__label"
                                  aria-hidden="true"
                                >
                                  {key === "fiveHour" ? "5H" : "W"}
                                </span>
                              </>
                            ) : (
                              <>
                                <span
                                  className="minimal-quota__label"
                                  aria-hidden="true"
                                >
                                  {key === "fiveHour" ? "5H" : "W"}
                                </span>
                                <strong
                                  className="minimal-quota__value"
                                  aria-hidden="true"
                                >
                                  {Math.round(used)}
                                  <small>%</small>
                                </strong>
                                {graphMode === "bar" && (
                                  <i
                                    className="minimal-quota__track"
                                    aria-hidden="true"
                                  >
                                    <i className="minimal-quota__fill" />
                                  </i>
                                )}
                              </>
                            )}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span
                      className="minimal-account__status"
                      title={t(
                        `${displayName} 사용량 수집 대기 중`,
                        `Waiting for ${displayName} usage`,
                      )}
                    >
                      {account.syncState === "error" ? "!" : "…"}
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <span className="minimal-strip__empty">
            {t("등록된 계정 없음", "No accounts")}
          </span>
        )}
      </div>
      <button
        className="minimal-strip__menu"
        type="button"
        title={t("창 메뉴 열기", "Open window menu")}
        aria-label={t("창 메뉴 열기", "Open window menu")}
        onClick={(event) => {
          event.currentTarget.blur();
          onRevealTitlebar();
        }}
      >
        <span aria-hidden="true">•••</span>
      </button>
    </main>
  );
}

function UsageInsightsView({
  accounts,
  selectedAccountId,
  selectedAccount,
  insights,
  daily,
  selectedDate,
  todayDate,
  earliestDate,
  accent,
  gradient,
  language,
  onSelectAccount,
  onSelectDate,
  onClear,
}: {
  accounts: Account[];
  selectedAccountId: string;
  selectedAccount: Account | null;
  insights: UsageInsightsResult | null;
  daily: UsageDailyHourlyResult | null;
  selectedDate: string;
  todayDate: string;
  earliestDate: string;
  accent: string;
  gradient: string;
  language: Language;
  onSelectAccount: (accountId: string) => void;
  onSelectDate: (date: string) => void;
  onClear: () => void;
}) {
  const t = (korean: string, english: string) =>
    translate(language, korean, english);
  const [selectedHour, setSelectedHour] = useState(
    () => new Date().getHours(),
  );
  const [headlineMetric, setHeadlineMetric] =
    useState<InsightHeadlineMetric>("rate");

  useEffect(() => {
    if (!daily) return;
    if (daily.date === todayDate) {
      setSelectedHour(new Date().getHours());
      return;
    }
    const busiest = daily.buckets.reduce(
      (current, bucket) =>
        bucket.percentPoints >
        daily.buckets[current].percentPoints
          ? bucket.hour
          : current,
      0,
    );
    setSelectedHour(busiest);
  }, [daily?.date, todayDate]);

  useEffect(() => {
    if (!selectedAccount?.contextTokens && headlineMetric === "contextTokens") {
      setHeadlineMetric("rate");
    }
  }, [headlineMetric, selectedAccount?.contextTokens]);

  const scaleMaximum = daily
    ? Math.max(5, Math.ceil(daily.maxPercentPoints / 5) * 5)
    : 5;
  const selectedBucket = daily?.buckets[selectedHour] ?? null;
  const primaryQuotaLabel =
    daily?.primaryQuota === "weekly"
      ? t("주간 한도", "Weekly limit")
      : daily?.primaryQuota === "fiveHour"
        ? t("5시간 한도", "5-hour limit")
        : t("수집 중", "Collecting");

  return (
    <section
      id="app-view-panel-insights"
      className="usage-insights-view"
      role="tabpanel"
      aria-labelledby="app-view-tab-insights"
      style={
        {
          "--analytics-accent": accent,
          "--analytics-gradient": gradient,
        } as CSSProperties
      }
    >
      <div className="usage-insights__controls">
        <label>
          <span>{t("분석할 계정", "Account")}</span>
          <select
            className="usage-insights__account"
            value={selectedAccountId}
            onChange={(event) =>
              onSelectAccount(event.currentTarget.value)
            }
            disabled={!accounts.length}
          >
            {!accounts.length && (
              <option value="">
                {t("실시간 연동 계정 없음", "No live connected accounts")}
              </option>
            )}
            {accounts.map((account) => (
              <option value={account.id} key={account.id}>
                {accountDisplayName(account, language)} · {account.provider}{" "}
                {account.plan}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("날짜", "Date")}</span>
          <span className="usage-insights__date-control">
            <button
              type="button"
              onClick={() => onSelectDate(shiftDayKey(selectedDate, -1))}
              disabled={selectedDate <= earliestDate}
              aria-label={t("이전 날짜", "Previous day")}
            >
              ←
            </button>
            <input
              type="date"
              min={earliestDate}
              max={todayDate}
              value={selectedDate}
              onChange={(event) => {
                if (event.currentTarget.value) {
                  onSelectDate(event.currentTarget.value);
                }
              }}
              aria-label={t("분석 날짜", "Analysis date")}
            />
            <button
              type="button"
              onClick={() => onSelectDate(shiftDayKey(selectedDate, 1))}
              disabled={selectedDate >= todayDate}
              aria-label={t("다음 날짜", "Next day")}
            >
              →
            </button>
          </span>
        </label>
        <label>
          <span>{t("대표 수치", "Headline metric")}</span>
          <select
            className="usage-insights__account usage-insights__metric-select"
            value={headlineMetric}
            onChange={(event) =>
              setHeadlineMetric(
                event.currentTarget.value as InsightHeadlineMetric,
              )
            }
          >
            <option value="rate">{t("사용률 %p/H", "Usage rate pp/H")}</option>
            <option
              value="contextTokens"
              disabled={!selectedAccount?.contextTokens}
            >
              {t(
                "토큰 · 현재 컨텍스트",
                "Tokens · current context",
              )}
            </option>
          </select>
        </label>
      </div>

      {insights && selectedAccount && daily ? (
        <>
          <div className="usage-insights__summary">
            <div className="usage-insights__verdict">
              <div className="usage-insights__verdict-copy">
                <strong>{insights.metrics.verdict.label[language]}</strong>
                <span>
                  {insights.metrics.verdict.description[language]}
                  {insights.metrics.fiveHourPressureDays > 0 &&
                    t(
                      ` 최근 28일 중 ${insights.metrics.fiveHourPressureDays}일은 5시간 한도가 90% 이상이었습니다.`,
                      ` The 5-hour limit reached 90% or more on ${insights.metrics.fiveHourPressureDays} of the last 28 days.`,
                    )}
                </span>
              </div>
              <span className="usage-insights__confidence">
                {t("신뢰도", "Confidence")}{" "}
                {insights.metrics.verdict.confidence === "high"
                  ? t("높음", "High")
                  : insights.metrics.verdict.confidence === "medium"
                    ? t("보통", "Medium")
                    : t("낮음", "Low")}
              </span>
            </div>
            <div className="usage-insights__metrics">
              <div className="usage-insights__metric">
                <span>
                  {headlineMetric === "contextTokens" &&
                  selectedAccount.contextTokens
                    ? t(
                        "최신 Claude 컨텍스트",
                        "Latest Claude context",
                      )
                    : t("활성 시간대당 소진", "Usage per active hour")}
                </span>
                <strong>
                  {headlineMetric === "contextTokens" &&
                  selectedAccount.contextTokens
                    ? `${formatTokenCount(
                        selectedAccount.contextTokens.totalTokens,
                        language,
                      )} ${t("토큰", "tokens")}`
                    : insights.metrics.percentPerActiveHour === null
                      ? "—"
                      : `${insights.metrics.percentPerActiveHour.toFixed(1)}%p/H`}
                </strong>
                {headlineMetric === "contextTokens" &&
                  selectedAccount.contextTokens && (
                    <span className="usage-insights__metric-note">
                      {t(
                        `입력 ${formatTokenCount(
                          selectedAccount.contextTokens.inputTokens,
                          language,
                        )} · 출력 ${formatTokenCount(
                          selectedAccount.contextTokens.outputTokens,
                          language,
                        )} · 구독 누적 아님`,
                        `In ${formatTokenCount(
                          selectedAccount.contextTokens.inputTokens,
                          language,
                        )} · out ${formatTokenCount(
                          selectedAccount.contextTokens.outputTokens,
                          language,
                        )} · not subscription cumulative`,
                      )}
                    </span>
                  )}
              </div>
              <div className="usage-insights__metric">
                <span>{t("예상 주간 소진", "Projected weekly")}</span>
                <strong>
                  {insights.metrics.projectedWeeklyPercent === null
                    ? "—"
                    : `${insights.metrics.projectedWeeklyPercent.toFixed(0)}%`}
                </strong>
              </div>
              <div className="usage-insights__metric">
                <span>{t("관측 / 활동일", "Observed / active")}</span>
                <strong>
                  {insights.metrics.coverageDays}
                  {t("일", "d")} · {insights.metrics.activeDays}
                  {t("일", "d")}
                </strong>
              </div>
            </div>
          </div>

          <div className="usage-insights__visuals">
            <figure
              className="usage-hourly-chart"
              aria-labelledby="usage-hourly-chart-title"
            >
              <figcaption className="usage-hourly-chart__heading">
                <div>
                  <strong id="usage-hourly-chart-title">
                    {formatInsightDate(selectedDate, language)} ·{" "}
                    {t("시간대별 사용량", "Usage by hour")}
                  </strong>
                  <span>
                    {primaryQuotaLabel} ·{" "}
                    {t(
                      `총 ${daily.totalPercentPoints.toFixed(1)}%p`,
                      `${daily.totalPercentPoints.toFixed(1)}pp total`,
                    )}
                  </span>
                </div>
                <span>
                  {t(
                    `활동 ${daily.activeHours}시간대`,
                    `${daily.activeHours} active hours`,
                  )}
                </span>
              </figcaption>
              <div className="usage-hourly-chart__plot">
                <div className="usage-hourly-chart__y-axis" aria-hidden="true">
                  <span>{scaleMaximum.toFixed(0)}%p</span>
                  <span>{(scaleMaximum / 2).toFixed(1)}%p</span>
                  <span>0</span>
                </div>
                <ol
                  className="usage-hourly-chart__bars"
                  aria-label={t(
                    "00시부터 23시까지 시간대별 사용량",
                    "Hourly usage from 00:00 through 23:00",
                  )}
                >
                  {daily.buckets.map((bucket) => {
                    const height =
                      bucket.percentPoints > 0
                        ? Math.max(
                            3,
                            (bucket.percentPoints / scaleMaximum) * 100,
                          )
                        : 0;
                    const estimated = bucket.estimated
                      ? t(" · 추정 포함", " · includes estimate")
                      : "";
                    const barLabel = t(
                      `${bucket.label}시 · ${bucket.percentPoints.toFixed(1)}%p${estimated}`,
                      `${bucket.label}:00 · ${bucket.percentPoints.toFixed(1)}pp${estimated}`,
                    );
                    return (
                      <li key={bucket.hour}>
                        <button
                          type="button"
                          className={
                            selectedHour === bucket.hour
                              ? "is-selected"
                              : ""
                          }
                          style={
                            {
                              "--hourly-bar-height": `${height}%`,
                            } as CSSProperties
                          }
                          title={barLabel}
                          aria-label={barLabel}
                          aria-pressed={selectedHour === bucket.hour}
                          onClick={() => setSelectedHour(bucket.hour)}
                          onPointerEnter={() => setSelectedHour(bucket.hour)}
                        >
                          <span aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <div className="usage-hourly-chart__x-axis" aria-hidden="true">
                {["00", "03", "06", "09", "12", "15", "18", "21"].map(
                  (hour) => (
                    <span key={hour}>{hour}</span>
                  ),
                )}
              </div>
              <div className="usage-hourly-chart__selection" aria-live="polite">
                <strong>
                  {String(selectedHour).padStart(2, "0")}:00
                </strong>
                <span>
                  {selectedBucket
                    ? t(
                        `${selectedBucket.percentPoints.toFixed(1)}%p 사용`,
                        `${selectedBucket.percentPoints.toFixed(1)}pp used`,
                      )
                    : t("기록 없음", "No record")}
                  {selectedBucket?.estimated
                    ? t(" · 추정 포함", " · includes estimate")
                    : ""}
                </span>
              </div>
            </figure>

            <div className="usage-insights__heatmap-block">
              <div className="usage-insights__heatmap-heading">
                <strong>{t("최근 12주", "Last 12 weeks")}</strong>
                <span>
                  {insights.metrics.primaryQuota === "weekly"
                    ? t("주간 한도 기준", "Weekly limit")
                    : insights.metrics.primaryQuota === "fiveHour"
                      ? t(
                          "5시간 한도 기준 · 주간 데이터 없음",
                          "5-hour limit · no weekly data",
                        )
                      : t("데이터 수집 중", "Collecting data")}
                </span>
              </div>
              <div
                className="usage-heatmap"
                role="grid"
                aria-rowcount={7}
                aria-colcount={12}
                aria-label={t(
                  "최근 12주 사용량 잔디",
                  "Usage heatmap for the last 12 weeks",
                )}
              >
                {insights.heatmap.map((day) => {
                  const cellLabel = usageHeatmapLabel(day, language);
                  return (
                    <button
                      type="button"
                      role="gridcell"
                      className={`usage-heatmap__cell usage-heatmap__cell--${
                        day.future ? 0 : day.intensity
                      }${day.future ? " is-future" : ""}${
                        selectedDate === day.date ? " is-selected" : ""
                      }`}
                      title={cellLabel}
                      aria-label={cellLabel}
                      aria-rowindex={day.weekday + 1}
                      aria-colindex={day.weekIndex + 1}
                      aria-selected={selectedDate === day.date}
                      disabled={day.future}
                      onClick={() => onSelectDate(day.date)}
                      key={day.date}
                    />
                  );
                })}
              </div>
              <div className="usage-insights__legend" aria-hidden="true">
                <span>{t("낮음", "Less")}</span>
                <span className="usage-insights__legend-squares">
                  {[0, 1, 2, 3, 4].map((level) => (
                    <i
                      className={`usage-heatmap__cell usage-heatmap__cell--${level}`}
                      key={level}
                    />
                  ))}
                </span>
                <span>{t("높음", "More")}</span>
              </div>
            </div>
          </div>

          <div className="usage-insights__footer">
            <span>
              {t(
                "사용 분석에는 실제 작업시간이 아닌 ‘사용이 발생한 시간대당 %p’만 저장합니다. 별도로 최신 Claude 컨텍스트의 입력·출력 토큰 수만 로컬 스냅샷에 저장하며, 프롬프트 내용과 로그인 정보는 저장하지 않습니다.",
                "Usage insights store percentage points per active hour—not actual work time. Separately, only the latest Claude context input/output counts are kept in a local snapshot; prompt contents and login data are never stored.",
              )}
            </span>
            <button
              className="usage-insights__clear"
              type="button"
              onClick={onClear}
              disabled={!insights.provider}
            >
              {t("기록 지우기", "Clear history")}
            </button>
          </div>
        </>
      ) : (
        <div className="usage-insights__empty">
          {t(
            "실시간으로 연결된 Claude 또는 Codex 계정을 선택하면 사용 기록 수집이 시작됩니다.",
            "Select a live Claude or Codex account to start collecting usage history.",
          )}
        </div>
      )}
    </section>
  );
}

function App() {
  const rendererParameters = new URLSearchParams(window.location.search);
  const settingsWindowMode =
    rendererParameters.get("window") === "settings";
  const initialSettingsCategory = normalizeSettingsCategory(
    rendererParameters.get("category"),
  );
  const [language, setLanguage] = useState<Language>(() => {
    const saved = window.localStorage.getItem("tokencat-language");
    return saved === "en" ? "en" : "ko";
  });
  const t = useCallback(
    (korean: string, english: string) =>
      translate(language, korean, english),
    [language],
  );
  const [accountBootstrap] = useState<AccountBootstrap>(
    readAccountBootstrap,
  );
  const [accounts, setAccounts] = useState<Account[]>(
    accountBootstrap.accounts,
  );
  const [usageHistory, setUsageHistory] = useState(() =>
    readUsageHistory(
      window.localStorage.getItem(HISTORY_STORAGE_KEY),
    ),
  );
  const [insightsAccountId, setInsightsAccountId] = useState(
    () =>
      accounts.find((account) => usageHistoryKeyForAccount(account))?.id ??
      "",
  );
  const [insightsDayKey, setInsightsDayKey] = useState(localDayKey);
  const [insightsTodayKey, setInsightsTodayKey] = useState(localDayKey);
  const [providerIcons, setProviderIcons] =
    useState<ProviderIcons>(readProviderIcons);
  const [activeView, setActiveView] = useState<AppView>("usage");
  const [filter, setFilter] = useState<Filter>("all");
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("tokencat-desktop-theme");
    if (saved === "night") return "dark";
    if (saved === "matcha") return "stone";
    return THEMES.includes(saved as Theme) ? (saved as Theme) : "light";
  });
  const [colorPreferences, setColorPreferences] =
    useState<ColorPreferences>(readColorPreferences);
  const [graphColorPreferences, setGraphColorPreferences] =
    useState<GraphColorPreferences>(readGraphColorPreferences);
  const [percentageColorPreferences, setPercentageColorPreferences] =
    useState<PercentageColorPreferences>(readPercentageColorPreferences);
  const [percentageGraphPreferences, setPercentageGraphPreferences] =
    useState<PercentageGraphPreferences>(readPercentageGraphPreferences);
  const [graphColorScope, setGraphColorScope] =
    useState<GraphColorScope>("provider:Claude");
  const [viewMode, setViewMode] = useState<ViewMode>(
    () =>
      (window.localStorage.getItem("tokencat-view-mode") as ViewMode) ||
      "rings",
  );
  const [layoutMode, setLayoutMode] =
    useState<LayoutMode>(readLayoutMode);
  const [cardSurfaceMode, setCardSurfaceMode] =
    useState<CardSurfaceMode>(readCardSurfaceMode);
  const [gridSingleColumn, setGridSingleColumn] = useState(
    () => window.matchMedia(GRID_SINGLE_COLUMN_MEDIA).matches,
  );
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [draggedAccountId, setDraggedAccountId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    accountId: string;
    position: DropPosition;
  } | null>(null);
  const [compact, setCompactState] = useState(
    () => window.localStorage.getItem("tokencat-compact") === "true",
  );
  const [minimal, setMinimal] = useState(
    () => window.localStorage.getItem(MINIMAL_MODE_STORAGE_KEY) === "true",
  );
  const [minimalOrientation, setMinimalOrientation] =
    useState<MinimalOrientation>(readMinimalOrientation);
  const [minimalGraphPreference, setMinimalGraphPreference] =
    useState<MinimalGraphPreference>(() =>
      normalizeMinimalGraphPreference(
        window.localStorage.getItem(MINIMAL_GRAPH_MODE_STORAGE_KEY),
      ),
    );
  const minimalGraphMode: MinimalGraphMode =
    minimalGraphPreference === "none"
      ? "none"
      : viewMode === "rings"
        ? "ring"
        : "bar";
  const [autoMinimal, setAutoMinimal] = useState(
    () => window.localStorage.getItem(AUTO_MINIMAL_STORAGE_KEY) !== "false",
  );
  const [autoMinimalHeight, setAutoMinimalHeight] = useState(() =>
    normalizeAutoMinimalHeight(
      window.localStorage.getItem(AUTO_MINIMAL_HEIGHT_STORAGE_KEY),
    ),
  );
  const [autoMinimalWidth, setAutoMinimalWidth] = useState(() =>
    normalizeAutoMinimalWidth(
      window.localStorage.getItem(AUTO_MINIMAL_WIDTH_STORAGE_KEY),
    ),
  );
  const [displayPreferences, setDisplayPreferences] =
    useState<DisplayPreferences>(readDisplayPreferences);
  const {
    widgetScale,
    graphScale,
    profileScale,
    titleScale,
    percentageScale,
    secondaryScale,
  } = displayPreferences;
  const [usageOnly, setUsageOnly] = useState(
    () => window.localStorage.getItem("tokencat-usage-only") !== "false",
  );
  const [tokenDisplayMode, setTokenDisplayMode] =
    useState<TokenDisplayMode>(readTokenDisplayMode);
  const [showCardProfile, setShowCardProfile] = useState(() =>
    readCardElementPreference(CARD_PROFILE_STORAGE_KEY),
  );
  const [showCardName, setShowCardName] = useState(() =>
    readCardElementPreference(CARD_TITLE_STORAGE_KEY),
  );
  const [showCardPlan, setShowCardPlan] = useState(readCardPlanPreference);
  const [showCardEdit, setShowCardEdit] = useState(() =>
    readCardElementPreference(CARD_EDIT_STORAGE_KEY),
  );
  const [profilePosition, setProfilePosition] =
    useState<ProfilePosition>(readProfilePosition);
  const cardHeaderVisible =
    showCardProfile || showCardName || showCardPlan;
  const headerless = !cardHeaderVisible;
  const quotaOnly = headerless;
  const [titlebarAutoHide, setTitlebarAutoHide] = useState(
    () =>
      window.localStorage.getItem(TITLEBAR_AUTO_HIDE_STORAGE_KEY) === "true",
  );
  const [titlebarHidden, setTitlebarHidden] = useState(false);
  const [minimalChromeVisible, setMinimalChromeVisible] = useState(true);
  const effectiveTitlebarAutoHide = titlebarAutoHide || minimal;
  const [petMotion, setPetMotion] = useState(
    () => window.localStorage.getItem("tokencat-pet-motion") !== "false",
  );
  const [pinned, setPinned] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [windowSizeState, setWindowSizeState] = useState<WindowSizeState>({
    sizeLocked: false,
    currentWindowSize: { width: 0, height: 0 },
    savedWindowSize: null,
    hasSavedWindowSize: false,
  });
  const [responsiveWindowSize, setResponsiveWindowSize] = useState(() =>
    window.tokenCat
      ? {
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
        }
      : { width: 0, height: 0 },
  );
  const [windowSizeBusy, setWindowSizeBusy] = useState<
    "lock" | "save" | "reset" | null
  >(null);
  const [windowOpacity, setWindowOpacityState] = useState(100);
  const [transparencyMode, setTransparencyMode] =
    useState<TransparencyMode>("whole-window");
  const [
    backgroundOnlyTransparencySupported,
    setBackgroundOnlyTransparencySupported,
  ] = useState(true);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [packaged, setPackaged] = useState(false);
  const [version, setVersion] = useState("0.30.0");
  const [updateState, setUpdateState] =
    useState<AppUpdateState>(EMPTY_UPDATE_STATE);
  const [updateActionBusy, setUpdateActionBusy] = useState<
    "check" | "install" | "download-page" | null
  >(null);
  const [integrations, setIntegrations] =
    useState<Record<IntegrationProvider, IntegrationSnapshot>>(
      EMPTY_INTEGRATIONS,
    );
  const [managedIntegrations, setManagedIntegrations] = useState<
    Record<string, IntegrationSnapshot>
  >({});
  const [integrationBusy, setIntegrationBusy] =
    useState<IntegrationProvider | null>(null);
  const [managedIntegrationBusy, setManagedIntegrationBusy] = useState<
    string | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(settingsWindowMode);
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategory>(initialSettingsCategory);
  const [addOpen, setAddOpen] = useState(false);
  const [addProvider, setAddProvider] = useState<Provider>("Claude");
  const [addMode, setAddMode] = useState<AddAccountMode>(() =>
    getManagedBridge()?.createManagedIntegration ? "managed" : "manual",
  );
  const [addBusy, setAddBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingManagedRemoval, setPendingManagedRemoval] = useState<
    string | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [mascotSuccess, setMascotSuccess] = useState(false);
  const [lastSync, setLastSync] = useState("방금 전");
  const [windowModeReady, setWindowModeReady] = useState(!window.tokenCat);
  const petAnimationTimer = useRef<number | null>(null);
  const mascotSuccessTimer = useRef<number | null>(null);
  const wasSyncing = useRef(false);
  const titlebarRef = useRef<HTMLElement | null>(null);
  const titlebarHideTimer = useRef<number | null>(null);
  const minimalChromeHideTimer = useRef<number | null>(null);
  const titlebarHovered = useRef(false);
  const draggedAccountIdRef = useRef<string | null>(null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const manualIntegrationRefresh =
    useRef<Promise<IntegrationSnapshot[]> | null>(null);
  const integrationRefreshInFlight = useRef(false);
  const integrationSnapshotSignaturesRef = useRef(new Map<string, string>());
  const managedMutationEpoch = useRef(0);
  const lastWidgetPointerWakeRef = useRef(0);
  const windowTransparencyRequestRef = useRef(0);
  const autoMinimalSuppressedRef = useRef(false);
  const pendingWindowModeTransitionRef = useRef<
    "manual" | "auto-resize"
  >("manual");
  const settingsWindowLayoutSignatureRef = useRef<string | null>(null);

  const closeSettingsPanel = useCallback(() => {
    if (settingsWindowMode && window.tokenCat?.closeSettings) {
      void window.tokenCat.closeSettings();
      return;
    }
    setSettingsOpen(false);
  }, [settingsWindowMode]);

  const openSettingsPanel = useCallback(
    (category: SettingsCategory = "general") => {
      if (settingsWindowMode) {
        setSettingsCategory(category);
        setSettingsOpen(true);
        return;
      }
      if (window.tokenCat?.openSettings) {
        void window.tokenCat.openSettings(category);
        return;
      }
      setSettingsCategory(category);
      setSettingsOpen(true);
    },
    [settingsWindowMode],
  );

  const clearTitlebarHideTimer = useCallback(() => {
    if (titlebarHideTimer.current === null) return;
    window.clearTimeout(titlebarHideTimer.current);
    titlebarHideTimer.current = null;
  }, []);

  const revealTitlebar = useCallback(() => {
    clearTitlebarHideTimer();
    setTitlebarHidden(false);
  }, [clearTitlebarHideTimer]);

  const scheduleTitlebarHide = useCallback(
    (delay = TITLEBAR_HIDE_DELAY) => {
      clearTitlebarHideTimer();
      if (!effectiveTitlebarAutoHide || draggedAccountIdRef.current) return;
      const attemptHide = () => {
        titlebarHideTimer.current = null;
        const titlebarHasFocus = Boolean(
          titlebarRef.current?.contains(document.activeElement),
        );
        const cardEditHasFocus =
          document.activeElement instanceof Element &&
          Boolean(document.activeElement.closest(".account-card__edit"));
        if (cardEditHasFocus) {
          titlebarHideTimer.current = window.setTimeout(attemptHide, 800);
          return;
        }
        if (titlebarHovered.current || titlebarHasFocus) {
          titlebarHideTimer.current = window.setTimeout(attemptHide, 800);
          return;
        }
        setTitlebarHidden(true);
      };
      titlebarHideTimer.current = window.setTimeout(attemptHide, delay);
    },
    [clearTitlebarHideTimer, effectiveTitlebarAutoHide],
  );

  const wakeTitlebarFromWidget = useCallback(() => {
    if (
      minimal ||
      !effectiveTitlebarAutoHide ||
      !titlebarHidden ||
      draggedAccountIdRef.current
    ) {
      return;
    }

    revealTitlebar();
    scheduleTitlebarHide();
  }, [
    revealTitlebar,
    scheduleTitlebarHide,
    effectiveTitlebarAutoHide,
    minimal,
    titlebarHidden,
  ]);

  const clearMinimalChromeHideTimer = useCallback(() => {
    if (minimalChromeHideTimer.current === null) return;
    window.clearTimeout(minimalChromeHideTimer.current);
    minimalChromeHideTimer.current = null;
  }, []);

  const scheduleMinimalChromeHide = useCallback(
    (delay = MINIMAL_CHROME_HIDE_DELAY) => {
      clearMinimalChromeHideTimer();
      if (!minimal) return;
      const attemptHide = () => {
        minimalChromeHideTimer.current = null;
        const focusedElement = document.activeElement;
        const chromeHasFocus =
          focusedElement instanceof Element &&
          Boolean(
            focusedElement.closest(
              ".minimal-strip__menu, .minimal-orientation-button",
            ),
          );
        if (chromeHasFocus) {
          minimalChromeHideTimer.current = window.setTimeout(
            attemptHide,
            600,
          );
          return;
        }
        setMinimalChromeVisible(false);
      };
      minimalChromeHideTimer.current = window.setTimeout(attemptHide, delay);
    },
    [clearMinimalChromeHideTimer, minimal],
  );

  const wakeMinimalChromeFromWidget = useCallback(() => {
    if (!minimal) return;
    clearMinimalChromeHideTimer();
    setMinimalChromeVisible(true);
    scheduleMinimalChromeHide();
  }, [
    clearMinimalChromeHideTimer,
    minimal,
    scheduleMinimalChromeHide,
  ]);

  const wakeWidgetChrome = useCallback(() => {
    wakeTitlebarFromWidget();
    wakeMinimalChromeFromWidget();
  }, [wakeMinimalChromeFromWidget, wakeTitlebarFromWidget]);

  const wakeWidgetChromeFromPointer = useCallback(() => {
    const now = window.performance.now();
    if (
      now - lastWidgetPointerWakeRef.current <
      WIDGET_POINTER_WAKE_THROTTLE_MS
    ) {
      return;
    }
    lastWidgetPointerWakeRef.current = now;
    wakeWidgetChrome();
  }, [wakeWidgetChrome]);

  useEffect(() => {
    document.documentElement.lang = language;
    window.localStorage.setItem("tokencat-language", language);
    void window.tokenCat?.setLanguage(language);
  }, [language]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tokencat-desktop-theme", theme);
  }, [theme]);

  useEffect(() => {
    const rootStyle = document.documentElement.style;
    const overrideVariables = [
      "--accent",
      "--accent-contrast",
      "--claude",
      "--codex",
      "--app-bg",
      "--app-bg-solid",
      "--surface",
      "--surface-solid",
      "--surface-muted",
      "--surface-muted-solid",
      "--surface-pressed",
      "--surface-pressed-solid",
      "--line",
      "--line-strong",
      "--track",
    ];

    overrideVariables.forEach((variable) => rootStyle.removeProperty(variable));
    const overrides = colorPreferences.themes[theme] ?? {};

    COLOR_ROLES.forEach(({ role, cssVariable }) => {
      const value = overrides[role];
      if (!value) return;
      rootStyle.setProperty(cssVariable, value);
      if (role === "appBg") {
        rootStyle.setProperty("--app-bg-solid", value);
      } else if (role === "surface") {
        rootStyle.setProperty("--surface-solid", value);
      }
    });

    if (overrides.accent) {
      rootStyle.setProperty(
        "--accent-contrast",
        bestContrastColor(overrides.accent),
      );
    }

    if (overrides.surface) {
      const textColor = THEME_TEXT_COLORS[theme];
      const darkTheme = isDarkTheme(theme);
      const mutedSurface = mixHex(
        overrides.surface,
        textColor,
        darkTheme ? 0.04 : 0.025,
      );
      const pressedSurface = mixHex(
        overrides.surface,
        textColor,
        darkTheme ? 0.09 : 0.065,
      );
      rootStyle.setProperty(
        "--surface-muted",
        mutedSurface,
      );
      rootStyle.setProperty("--surface-muted-solid", mutedSurface);
      rootStyle.setProperty(
        "--surface-pressed",
        pressedSurface,
      );
      rootStyle.setProperty("--surface-pressed-solid", pressedSurface);
      rootStyle.setProperty(
        "--line",
        mixHex(overrides.surface, textColor, darkTheme ? 0.12 : 0.1),
      );
      rootStyle.setProperty(
        "--line-strong",
        mixHex(overrides.surface, textColor, darkTheme ? 0.22 : 0.18),
      );
      rootStyle.setProperty(
        "--track",
        mixHex(overrides.surface, textColor, darkTheme ? 0.13 : 0.09),
      );
    }

    window.localStorage.setItem(
      COLOR_STORAGE_KEY,
      JSON.stringify(colorPreferences),
    );
  }, [colorPreferences, theme]);

  useEffect(() => {
    window.localStorage.setItem(
      GRAPH_COLOR_STORAGE_KEY,
      JSON.stringify(graphColorPreferences),
    );
  }, [graphColorPreferences]);

  useEffect(() => {
    window.localStorage.setItem(
      PERCENTAGE_COLOR_STORAGE_KEY,
      JSON.stringify(percentageColorPreferences),
    );
  }, [percentageColorPreferences]);

  useEffect(() => {
    window.localStorage.setItem(
      PERCENTAGE_GRAPH_STORAGE_KEY,
      JSON.stringify(percentageGraphPreferences),
    );
  }, [percentageGraphPreferences]);

  useEffect(() => {
    if (
      accountBootstrap.status === "invalid" &&
      accounts === accountBootstrap.accounts
    ) {
      return;
    }
    window.localStorage.setItem(
      ACCOUNT_STORAGE_KEY,
      JSON.stringify(accounts),
    );
  }, [accountBootstrap, accounts]);

  useEffect(() => {
    if (
      settingsWindowMode ||
      !accountBootstrap.shouldStartOnboarding
    ) {
      return;
    }
    void window.tokenCat?.openOnboarding?.({ firstRun: true });
  }, [
    accountBootstrap.shouldStartOnboarding,
    settingsWindowMode,
  ]);

  useEffect(() => {
    if (
      settingsWindowMode ||
      !accounts.some(
        (account) =>
          account.origin === "manual" ||
          (account.origin === "live" && account.syncState === "idle"),
      )
    ) {
      return;
    }
    void window.tokenCat?.completeOnboarding?.();
  }, [accounts, settingsWindowMode]);

  useEffect(() => {
    if (settingsWindowMode) return;
    try {
      window.localStorage.setItem(
        HISTORY_STORAGE_KEY,
        serializeUsageHistory(usageHistory),
      );
    } catch {
      setToast(
        t(
          "사용 분석 기록을 저장할 공간이 부족합니다. 오래된 기록을 지워 주세요.",
          "There is not enough local storage for usage history. Clear older history and try again.",
        ),
      );
    }
  }, [settingsWindowMode, t, usageHistory]);

  useEffect(() => {
    const liveAccounts = accounts.filter((account) =>
      usageHistoryKeyForAccount(account),
    );
    if (!liveAccounts.length) {
      setInsightsAccountId("");
      return;
    }
    if (
      liveAccounts.some((account) => account.id === insightsAccountId)
    ) {
      return;
    }
    setInsightsAccountId(liveAccounts[0].id);
  }, [accounts, insightsAccountId]);

  useEffect(() => {
    if (settingsWindowMode) return;
    const timer = window.setInterval(() => {
      const nextDay = localDayKey();
      setInsightsTodayKey((currentToday) => {
        if (currentToday === nextDay) return currentToday;
        setInsightsDayKey((currentSelection) =>
          currentSelection === currentToday ? nextDay : currentSelection,
        );
        return nextDay;
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [settingsWindowMode]);

  useEffect(() => {
    const activeAccountIds = new Set(accounts.map((account) => account.id));
    setPercentageColorPreferences((current) => {
      let changed = false;
      const nextThemes = { ...current.themes };

      THEMES.forEach((savedTheme) => {
        const saved = nextThemes[savedTheme];
        if (!saved?.accounts) return;
        const activeOverrides = Object.fromEntries(
          Object.entries(saved.accounts).filter(([accountId]) =>
            activeAccountIds.has(accountId),
          ),
        );
        if (
          Object.keys(activeOverrides).length ===
          Object.keys(saved.accounts).length
        ) {
          return;
        }
        changed = true;
        if (
          Object.keys(saved.providers ?? {}).length ||
          Object.keys(activeOverrides).length
        ) {
          nextThemes[savedTheme] = {
            providers: { ...(saved.providers ?? {}) },
            accounts: activeOverrides,
          };
        } else {
          delete nextThemes[savedTheme];
        }
      });

      return changed ? { version: 1, themes: nextThemes } : current;
    });
    setPercentageGraphPreferences((current) => {
      const activeOverrides = Object.fromEntries(
        Object.entries(current.accounts).filter(([accountId]) =>
          activeAccountIds.has(accountId),
        ),
      );
      return Object.keys(activeOverrides).length ===
        Object.keys(current.accounts).length
        ? current
        : { ...current, accounts: activeOverrides };
    });
  }, [accounts]);

  useEffect(() => {
    window.localStorage.setItem(
      "tokencat-provider-icons",
      JSON.stringify(providerIcons),
    );
  }, [providerIcons]);

  useEffect(() => {
    window.localStorage.setItem("tokencat-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(GRID_SINGLE_COLUMN_MEDIA);
    const syncGridColumnState = () =>
      setGridSingleColumn(mediaQuery.matches);
    syncGridColumnState();
    mediaQuery.addEventListener("change", syncGridColumnState);
    return () =>
      mediaQuery.removeEventListener("change", syncGridColumnState);
  }, []);

  const visibleAccounts = useMemo(
    () =>
      filter === "all"
        ? accounts
        : accounts.filter((account) => account.provider === filter),
    [accounts, filter],
  );
  const windowAccountCount = compact || minimal
    ? accounts.length
    : visibleAccounts.length;

  useEffect(() => {
    if (!windowModeReady) return;
    const transitionSource = pendingWindowModeTransitionRef.current;
    pendingWindowModeTransitionRef.current = "manual";
    window.localStorage.setItem("tokencat-compact", String(compact));
    window.localStorage.setItem(MINIMAL_MODE_STORAGE_KEY, String(minimal));
    window.localStorage.setItem(
      MINIMAL_ORIENTATION_STORAGE_KEY,
      minimalOrientation,
    );
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode);
    window.localStorage.setItem(
      CARD_SURFACE_STORAGE_KEY,
      cardSurfaceMode,
    );
    if (!settingsWindowMode) {
      window.tokenCat?.setWindowLayout(
        layoutMode,
        compact,
        quotaOnly,
        widgetScale,
        windowAccountCount,
        cardSurfaceMode,
        minimal,
        minimalOrientation,
        transitionSource,
      );
    }
  }, [
    layoutMode,
    compact,
    minimal,
    minimalOrientation,
    quotaOnly,
    widgetScale,
    windowAccountCount,
    cardSurfaceMode,
    windowModeReady,
    settingsWindowMode,
  ]);

  useEffect(() => {
    if (!settingsWindowMode || !windowModeReady) return;
    const signature = JSON.stringify([
      layoutMode,
      compact,
      quotaOnly,
      widgetScale,
      cardSurfaceMode,
      minimal,
      minimalOrientation,
    ]);
    if (settingsWindowLayoutSignatureRef.current === null) {
      settingsWindowLayoutSignatureRef.current = signature;
      return;
    }
    if (settingsWindowLayoutSignatureRef.current === signature) return;
    settingsWindowLayoutSignatureRef.current = signature;
    void window.tokenCat?.applyMainWindowLayout(
      layoutMode,
      compact,
      quotaOnly,
      widgetScale,
      cardSurfaceMode,
      minimal,
      minimalOrientation,
    );
  }, [
    cardSurfaceMode,
    compact,
    layoutMode,
    minimal,
    minimalOrientation,
    quotaOnly,
    settingsWindowMode,
    widgetScale,
    windowModeReady,
  ]);

  useEffect(() => {
    window.localStorage.setItem(
      MINIMAL_GRAPH_MODE_STORAGE_KEY,
      minimalGraphPreference,
    );
    window.localStorage.setItem(AUTO_MINIMAL_STORAGE_KEY, String(autoMinimal));
    window.localStorage.setItem(
      AUTO_MINIMAL_HEIGHT_STORAGE_KEY,
      String(autoMinimalHeight),
    );
    window.localStorage.setItem(
      AUTO_MINIMAL_WIDTH_STORAGE_KEY,
      String(autoMinimalWidth),
    );
  }, [
    autoMinimal,
    autoMinimalHeight,
    autoMinimalWidth,
    minimalGraphPreference,
  ]);

  useEffect(() => {
    window.localStorage.setItem(
      DISPLAY_PREFERENCES_STORAGE_KEY,
      JSON.stringify(displayPreferences),
    );
  }, [displayPreferences]);

  useEffect(() => {
    if ((compact || minimal) && filter !== "all") {
      setFilter("all");
    }
  }, [compact, filter, minimal]);

  useEffect(() => {
    window.localStorage.setItem("tokencat-usage-only", String(usageOnly));
  }, [usageOnly]);

  useEffect(() => {
    window.localStorage.setItem(
      TOKEN_DISPLAY_MODE_STORAGE_KEY,
      tokenDisplayMode,
    );
  }, [tokenDisplayMode]);

  useEffect(() => {
    window.localStorage.setItem(
      CARD_PROFILE_STORAGE_KEY,
      String(showCardProfile),
    );
    window.localStorage.setItem(CARD_TITLE_STORAGE_KEY, String(showCardName));
    window.localStorage.setItem(CARD_PLAN_STORAGE_KEY, String(showCardPlan));
    window.localStorage.setItem(CARD_EDIT_STORAGE_KEY, String(showCardEdit));
    window.localStorage.setItem("tokencat-quota-only", String(quotaOnly));
  }, [
    quotaOnly,
    showCardEdit,
    showCardName,
    showCardPlan,
    showCardProfile,
  ]);

  useEffect(() => {
    window.localStorage.setItem(
      PROFILE_POSITION_STORAGE_KEY,
      profilePosition,
    );
  }, [profilePosition]);

  useEffect(() => {
    window.localStorage.setItem(
      TITLEBAR_AUTO_HIDE_STORAGE_KEY,
      String(titlebarAutoHide),
    );
    if (!effectiveTitlebarAutoHide) {
      titlebarHovered.current = false;
      clearTitlebarHideTimer();
      setTitlebarHidden(false);
      return;
    }

    revealTitlebar();
    scheduleTitlebarHide();
    return clearTitlebarHideTimer;
  }, [
    clearTitlebarHideTimer,
    effectiveTitlebarAutoHide,
    revealTitlebar,
    scheduleTitlebarHide,
    titlebarAutoHide,
  ]);

  useEffect(() => {
    if (!minimal) {
      clearMinimalChromeHideTimer();
      setMinimalChromeVisible(true);
      return;
    }

    setMinimalChromeVisible(true);
    scheduleMinimalChromeHide();
    return clearMinimalChromeHideTimer;
  }, [
    clearMinimalChromeHideTimer,
    minimal,
    scheduleMinimalChromeHide,
  ]);

  useEffect(() => {
    const onWindowFocus = () => {
      if (!effectiveTitlebarAutoHide) return;
      revealTitlebar();
      scheduleTitlebarHide();
      if (minimal) {
        setMinimalChromeVisible(true);
        scheduleMinimalChromeHide();
      }
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [
    effectiveTitlebarAutoHide,
    minimal,
    revealTitlebar,
    scheduleMinimalChromeHide,
    scheduleTitlebarHide,
  ]);

  useEffect(() => {
    window.localStorage.setItem("tokencat-pet-motion", String(petMotion));
  }, [petMotion]);

  useEffect(
    () => () => {
      if (petAnimationTimer.current !== null) {
        window.clearTimeout(petAnimationTimer.current);
      }
      if (mascotSuccessTimer.current !== null) {
        window.clearTimeout(mascotSuccessTimer.current);
      }
      clearTitlebarHideTimer();
    },
    [clearTitlebarHideTimer],
  );

  useEffect(() => {
    if (syncing) {
      if (mascotSuccessTimer.current !== null) {
        window.clearTimeout(mascotSuccessTimer.current);
        mascotSuccessTimer.current = null;
      }
      setMascotSuccess(false);
    } else if (wasSyncing.current) {
      setMascotSuccess(true);
      mascotSuccessTimer.current = window.setTimeout(() => {
        setMascotSuccess(false);
        mascotSuccessTimer.current = null;
      }, 760);
    }

    wasSyncing.current = syncing;
  }, [syncing]);

  useEffect(() => {
    const settingsRequest = window.tokenCat?.getSettings();
    settingsRequest
      ?.then((settings) => {
        setPinned(settings.alwaysOnTop);
        setMaximized(settings.maximized);
        setOpenAtLogin(settings.openAtLogin);
        setVersion(settings.version);
        setPackaged(settings.packaged);
        setWindowOpacityState(
          normalizeWindowOpacity(settings.windowOpacity),
        );
        setTransparencyMode(
          normalizeTransparencyMode(settings.transparencyMode),
        );
        setBackgroundOnlyTransparencySupported(
          settings.backgroundOnlyTransparencySupported !== false,
        );
        setWindowSizeState({
          sizeLocked: settings.sizeLocked,
          currentWindowSize: settings.currentWindowSize,
          savedWindowSize: settings.savedWindowSize,
          hasSavedWindowSize: settings.hasSavedWindowSize,
          changeSource: settings.changeSource ?? "initial",
        });
        setLayoutMode(normalizeLayoutMode(settings.layout));
        setCardSurfaceMode(
          normalizeCardSurfaceMode(settings.cardSurfaceMode),
        );
        setCompactState(settings.compact);
        setMinimal(Boolean(settings.minimal));
        setMinimalOrientation(
          normalizeMinimalOrientation(settings.minimalOrientation),
        );
        setDisplayPreferences((current) => ({
          ...current,
          widgetScale: normalizeDisplayScale(
            "widgetScale",
            settings.widgetScale,
          ),
        }));
      })
      .finally(() => setWindowModeReady(true));
    const removePinListener = window.tokenCat?.onPinChanged(setPinned);
    const removeMaximizedListener =
      window.tokenCat?.onMaximizedChanged(setMaximized);
    const removeWindowSizeListener =
      window.tokenCat?.onWindowSizeStateChanged(setWindowSizeState);
    const removeWindowTransparencyListener =
      window.tokenCat?.onWindowTransparencyChanged?.((value) => {
        setWindowOpacityState(normalizeWindowOpacity(value.opacity));
        setTransparencyMode(normalizeTransparencyMode(value.mode));
      });
    return () => {
      removePinListener?.();
      removeMaximizedListener?.();
      removeWindowSizeListener?.();
      removeWindowTransparencyListener?.();
    };
  }, []);

  useEffect(() => {
    const bridge = window.tokenCat;
    if (!bridge?.getUpdateState) return;
    let cancelled = false;
    void bridge
      .getUpdateState()
      .then((state) => {
        if (!cancelled) setUpdateState(state);
      })
      .catch(() => {
        // Automatic retries remain owned by the main process.
      });
    const removeListener = bridge.onUpdateStateChanged?.((state) => {
      if (!cancelled) setUpdateState(state);
    });
    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, []);

  useEffect(() => {
    if (settingsWindowMode || !window.tokenCat) return;
    let reloadTimer: number | null = null;
    const synchronizeSettingsWindowChanges = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== null && !event.key.startsWith("tokencat-"))
      ) {
        return;
      }
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        window.location.reload();
      }, 180);
    };
    window.addEventListener("storage", synchronizeSettingsWindowChanges);
    return () => {
      window.removeEventListener(
        "storage",
        synchronizeSettingsWindowChanges,
      );
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    };
  }, [settingsWindowMode]);

  useEffect(() => {
    if (!window.tokenCat || settingsWindowMode) return;
    let resizeTimer: number | null = null;
    const commitResponsiveWindowSize = () => {
      resizeTimer = null;
      const nextSize = {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
      };
      setResponsiveWindowSize((current) =>
        current.width === nextSize.width &&
        current.height === nextSize.height
          ? current
          : nextSize,
      );
    };
    const updateResponsiveWindowSize = () => {
      if (resizeTimer !== null) return;
      resizeTimer = window.setTimeout(
        commitResponsiveWindowSize,
        RESPONSIVE_RESIZE_THROTTLE_MS,
      );
    };
    commitResponsiveWindowSize();
    window.addEventListener("resize", updateResponsiveWindowSize);
    return () => {
      window.removeEventListener("resize", updateResponsiveWindowSize);
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
    };
  }, [settingsWindowMode]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!layoutEditing) return;
    const stopLayoutEditing = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLayoutEditing(false);
      draggedAccountIdRef.current = null;
      setDraggedAccountId(null);
      setDropTarget(null);
      scheduleTitlebarHide();
    };
    window.addEventListener("keydown", stopLayoutEditing);
    return () => window.removeEventListener("keydown", stopLayoutEditing);
  }, [layoutEditing, scheduleTitlebarHide]);

  useEffect(() => {
    if (!settingsOpen && !addOpen && !editingId && !pendingManagedRemoval) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingManagedRemoval) {
        setPendingManagedRemoval(null);
        return;
      }
      if (addOpen) {
        setAddOpen(false);
        return;
      }
      if (editingId) {
        setEditingId(null);
        return;
      }
      if (settingsOpen) closeSettingsPanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    settingsOpen,
    addOpen,
    closeSettingsPanel,
    editingId,
    pendingManagedRemoval,
  ]);

  useEffect(() => {
    if (!settingsOpen) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]';
    const getFocusable = () =>
      Array.from(
        settingsPanelRef.current?.querySelectorAll<HTMLElement>(
          focusableSelector,
        ) ?? [],
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          element.getClientRects().length > 0 &&
          !element.closest("[hidden], [inert]"),
      );
    const focusFrame = window.requestAnimationFrame(() => {
      getFocusable()[0]?.focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !settingsPanelRef.current) return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (
        event.shiftKey &&
        (!settingsPanelRef.current.contains(document.activeElement) ||
          document.activeElement === first)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (!settingsPanelRef.current.contains(document.activeElement) ||
          document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [settingsOpen]);

  useEffect(
    () =>
      window.tokenCat?.onOpenSettings((category) => {
        setSettingsCategory(category);
        setAddOpen(false);
        setEditingId(null);
        setPendingManagedRemoval(null);
        setSettingsOpen(true);
      }),
    [],
  );

  const activeGridCapacity = gridLayoutCapacity(layoutMode);

  const visibleUsageValues = accounts.flatMap((account) =>
    visibleQuotas(account).map(({ quota }) => quota.used),
  );
  const quotaSummary = {
    total: visibleUsageValues.length,
    warning: visibleUsageValues.filter((value) => value >= 70).length,
  };
  const hasLimitWarning = visibleUsageValues.some((value) => value >= 90);
  const mascotAction: MascotAction = syncing
    ? "working"
    : mascotSuccess
      ? "success"
      : hasLimitWarning
        ? "limit-warning"
        : "idle";

  const editingAccount =
    accounts.find((account) => account.id === editingId) ?? null;
  const editingManagedId = managedAccountIdFromConnection(
    editingAccount?.connectionId,
  );
  const pendingManagedRemovalSnapshot = pendingManagedRemoval
    ? managedIntegrations[pendingManagedRemoval]
    : null;
  const pendingManagedRemovalName = pendingManagedRemovalSnapshot
    ? managedSnapshotDetails(
        pendingManagedRemovalSnapshot,
      ).displayName?.trim() ||
      fallbackAccountName(
        providerFromIntegration(pendingManagedRemovalSnapshot.provider),
        language,
      )
    : t("등록한 계정", "Registered account");
  const managedRegistrationAvailable = Boolean(
    getManagedBridge()?.createManagedIntegration,
  );
  const activeColorPalette =
    COLOR_PALETTES[isDarkTheme(theme) ? "dark" : "light"];
  const activeColorOverrides = colorPreferences.themes[theme] ?? {};
  const insightsAccounts = useMemo(
    () =>
      accounts.filter((account) => usageHistoryKeyForAccount(account)),
    [accounts],
  );
  const insightsAccount =
    insightsAccounts.find((account) => account.id === insightsAccountId) ??
    null;
  const insightsAccountKey = insightsAccount
    ? usageHistoryKeyForAccount(insightsAccount)
    : null;
  const usageInsights = useMemo(
    () =>
      insightsAccountKey
        ? buildUsageInsights(usageHistory, insightsAccountKey, {
            now: new Date(),
            timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
          })
        : null,
    [insightsAccountKey, insightsTodayKey, usageHistory],
  );
  const dailyHourlyUsage = useMemo(
    () =>
      insightsAccountKey
        ? buildDailyHourlyUsage(
            usageHistory,
            insightsAccountKey,
            insightsDayKey,
            {
              now: new Date(),
              timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
            },
          )
        : null,
    [insightsAccountKey, insightsDayKey, insightsTodayKey, usageHistory],
  );

  const applyIntegrationSnapshots = useCallback(
    (snapshots: IntegrationSnapshot[]) => {
      if (!snapshots.length) return;
      if (
        !settingsWindowMode &&
        snapshots.some((snapshot) => snapshot.connected)
      ) {
        void window.tokenCat?.completeOnboarding?.();
      }
      const changedSnapshots = snapshots.filter((snapshot) => {
        const key = integrationSnapshotKey(snapshot);
        const signature = integrationSnapshotSignature(snapshot);
        if (
          integrationSnapshotSignaturesRef.current.get(key) === signature
        ) {
          return false;
        }
        integrationSnapshotSignaturesRef.current.set(key, signature);
        return true;
      });
      if (!changedSnapshots.length) return;

      if (!settingsWindowMode) {
        setUsageHistory((current) => {
          const recorded = recordUsageSnapshots(
            current,
            changedSnapshots,
          );
          return recorded.changed ? recorded.history : current;
        });
      }

      const systemSnapshots = changedSnapshots.filter(
        (snapshot) => !managedAccountId(snapshot),
      );
      const managedSnapshots = changedSnapshots.filter((snapshot) =>
        Boolean(managedAccountId(snapshot)),
      );

      if (systemSnapshots.length) {
        setIntegrations((current) => {
          const next = { ...current };
          systemSnapshots.forEach((snapshot) => {
            next[snapshot.provider] = snapshot;
          });
          return next;
        });
      }

      if (managedSnapshots.length) {
        setManagedIntegrations((current) => {
          const next = { ...current };
          managedSnapshots.forEach((snapshot) => {
            const accountId = managedAccountId(snapshot);
            if (accountId) next[accountId] = snapshot;
          });
          return next;
        });
      }

      const cardSnapshots = [...systemSnapshots, ...managedSnapshots];
      if (!cardSnapshots.length) return;

      setAccounts((current) => {
        let next = [...current];

        cardSnapshots.forEach((snapshot) => {
          const provider = providerFromIntegration(snapshot.provider);
          const accountId = managedAccountId(snapshot);
          const connectionId = accountId
            ? `managed-${accountId}`
            : `local-${snapshot.provider}`;
          const cardId = accountId
            ? `live-${snapshot.provider}-${accountId}`
            : `live-${snapshot.provider}-local`;
          const existingIndex = next.findIndex(
            (account) =>
              account.connectionId === connectionId ||
              account.id === cardId,
          );
          if (
            existingIndex < 0 &&
            !accountId &&
            !snapshot.connected
          ) {
            return;
          }
          const previous =
            existingIndex >= 0 ? next[existingIndex] : undefined;
          const liveAccount = accountFromIntegration(
            snapshot,
            previous,
            language,
          );

          if (existingIndex >= 0) {
            next[existingIndex] = liveAccount;
          } else {
            next = next.filter(
              (account) =>
                !(account.provider === provider && account.origin === "demo"),
            );
            next.push(liveAccount);
          }
        });

        return next;
      });
    },
    [language, settingsWindowMode],
  );

  const replaceManagedIntegrationSnapshots = useCallback(
    (
      snapshots: IntegrationSnapshot[],
      requestEpoch: number = managedMutationEpoch.current,
    ) => {
      if (requestEpoch !== managedMutationEpoch.current) return;
      const managedSnapshots = snapshots.filter((snapshot) =>
        Boolean(managedAccountId(snapshot)),
      );
      const authoritativeIds = new Set(
        managedSnapshots
          .map((snapshot) => managedAccountId(snapshot))
          .filter((accountId): accountId is string => Boolean(accountId)),
      );
      setManagedIntegrations(
        Object.fromEntries(
          managedSnapshots.flatMap((snapshot) => {
            const accountId = managedAccountId(snapshot);
            return accountId ? [[accountId, snapshot]] : [];
          }),
        ),
      );
      setAccounts((current) =>
        current.filter((account) => {
          const accountId = managedAccountIdFromConnection(
            account.connectionId,
          );
          return !accountId || authoritativeIds.has(accountId);
        }),
      );
      applyIntegrationSnapshots(managedSnapshots);
    },
    [applyIntegrationSnapshots],
  );

  useEffect(() => {
    const bridge = getManagedBridge();
    if (!bridge) return;
    if (settingsWindowMode) {
      let cancelled = false;
      const applyStatusOnly = (
        snapshots: IntegrationSnapshot[],
        replaceManaged = false,
      ) => {
        if (cancelled || !snapshots.length) return;
        const systemSnapshots = snapshots.filter(
          (snapshot) => !managedAccountId(snapshot),
        );
        const managedSnapshots = snapshots.filter((snapshot) =>
          Boolean(managedAccountId(snapshot)),
        );
        if (systemSnapshots.length) {
          setIntegrations((current) => {
            const next = { ...current };
            systemSnapshots.forEach((snapshot) => {
              next[snapshot.provider] = snapshot;
            });
            return next;
          });
        }
        if (managedSnapshots.length || replaceManaged) {
          setManagedIntegrations((current) => {
            const next = replaceManaged ? {} : { ...current };
            managedSnapshots.forEach((snapshot) => {
              const accountId = managedAccountId(snapshot);
              if (accountId) next[accountId] = snapshot;
            });
            return next;
          });
        }
      };
      const loadStatuses = async () => {
        const requests: Array<{
          managed: boolean;
          promise: Promise<IntegrationSnapshot[]>;
        }> = [];
        if (bridge.getIntegrationStatus) {
          requests.push({
            managed: false,
            promise: bridge.getIntegrationStatus(),
          });
        }
        if (bridge.getManagedIntegrationStatus) {
          requests.push({
            managed: true,
            promise: bridge.getManagedIntegrationStatus(),
          });
        }
        const results = await Promise.allSettled(
          requests.map((request) => request.promise),
        );
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            applyStatusOnly(result.value, requests[index].managed);
          }
        });
      };
      const removeSnapshotListener = bridge.onIntegrationSnapshot?.(
        (snapshot) => applyStatusOnly([snapshot]),
      );
      void loadStatuses();
      return () => {
        cancelled = true;
        removeSnapshotListener?.();
      };
    }
    let cancelled = false;

    const updateInBackground = async () => {
      if (cancelled || integrationRefreshInFlight.current) return;
      integrationRefreshInFlight.current = true;
      try {
        const requests: Array<{
          kind: "system" | "managed";
          promise: Promise<IntegrationSnapshot[]>;
          epoch?: number;
        }> = [];
        if (bridge.getIntegrationStatus) {
          requests.push({
            kind: "system",
            promise: bridge.getIntegrationStatus(),
          });
        }
        if (bridge.getManagedIntegrationStatus) {
          requests.push({
            kind: "managed",
            promise: bridge.getManagedIntegrationStatus(),
            epoch: managedMutationEpoch.current,
          });
        }
        if (!requests.length) return;

        const results = await Promise.allSettled(
          requests.map((request) => request.promise),
        );
        if (cancelled) return;
        const snapshots: IntegrationSnapshot[] = [];
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") return;
          snapshots.push(...result.value);
          if (requests[index].kind === "managed") {
            replaceManagedIntegrationSnapshots(
              result.value,
              requests[index].epoch,
            );
          } else {
            applyIntegrationSnapshots(result.value);
          }
        });
        if (snapshots.some((snapshot) => snapshot.connected)) {
          setLastSync("방금 전");
        }
      } finally {
        integrationRefreshInFlight.current = false;
      }
    };

    const pollIntegrations = async () => {
      if (
        cancelled ||
        document.hidden ||
        integrationRefreshInFlight.current
      ) {
        return;
      }
      const requests: Array<{
        kind: "system" | "managed";
        promise: Promise<IntegrationSnapshot[]>;
        epoch?: number;
      }> = [];
      if (bridge.refreshIntegration) {
        requests.push({
          kind: "system",
          promise: bridge
            .refreshIntegration("codex")
            .then((snapshot) => [snapshot]),
        });
      }
      if (bridge.refreshManagedIntegrations) {
        requests.push({
          kind: "managed",
          promise: bridge.refreshManagedIntegrations(),
          epoch: managedMutationEpoch.current,
        });
      }
      if (!requests.length) return;

      integrationRefreshInFlight.current = true;
      try {
        const results = await Promise.allSettled(
          requests.map((request) => request.promise),
        );
        if (cancelled) return;
        const snapshots: IntegrationSnapshot[] = [];
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") return;
          snapshots.push(...result.value);
          if (requests[index].kind === "managed") {
            replaceManagedIntegrationSnapshots(
              result.value,
              requests[index].epoch,
            );
          } else {
            applyIntegrationSnapshots(result.value);
          }
        });
        if (snapshots.length) {
          if (snapshots.some((snapshot) => snapshot.connected)) {
            setLastSync("방금 전");
          }
        }
      } finally {
        integrationRefreshInFlight.current = false;
      }
    };

    const removeSnapshotListener = bridge.onIntegrationSnapshot?.(
      (snapshot) => {
        if (cancelled) return;
        applyIntegrationSnapshots([snapshot]);
        if (snapshot.connected) setLastSync("방금 전");
      },
    );

    const refreshWhenVisible = () => {
      if (document.hidden || cancelled) return;
      void updateInBackground();
    };

    if (!document.hidden) void updateInBackground();
    const timer = window.setInterval(() => {
      void pollIntegrations();
    }, INTEGRATION_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener(
        "visibilitychange",
        refreshWhenVisible,
      );
      removeSnapshotListener?.();
    };
  }, [
    applyIntegrationSnapshots,
    replaceManagedIntegrationSnapshots,
    settingsWindowMode,
  ]);

  const animatePets = () => {
    if (petAnimationTimer.current !== null) {
      window.clearTimeout(petAnimationTimer.current);
    }
    setSyncing(true);
    petAnimationTimer.current = window.setTimeout(() => {
      setSyncing(false);
      petAnimationTimer.current = null;
    }, 2200);
  };

  const changeWindowTransparency = (
    nextValue: Partial<{
      mode: TransparencyMode;
      opacity: number;
    }>,
  ) => {
    const previous = {
      mode: transparencyMode,
      opacity: windowOpacity,
    };
    const next = {
      mode: normalizeTransparencyMode(
        nextValue.mode ?? transparencyMode,
      ),
      opacity: normalizeWindowOpacity(
        nextValue.opacity ?? windowOpacity,
      ),
    };
    const requestId = windowTransparencyRequestRef.current + 1;
    windowTransparencyRequestRef.current = requestId;
    setTransparencyMode(next.mode);
    setWindowOpacityState(next.opacity);
    const request = window.tokenCat?.setWindowTransparency?.(next);
    if (!request) return;
    void request
      .then((applied) => {
        if (
          requestId === windowTransparencyRequestRef.current &&
          applied
        ) {
          setTransparencyMode(normalizeTransparencyMode(applied.mode));
          setWindowOpacityState(normalizeWindowOpacity(applied.opacity));
        }
      })
      .catch(() => {
        if (requestId !== windowTransparencyRequestRef.current) return;
        setTransparencyMode(previous.mode);
        setWindowOpacityState(previous.opacity);
        setToast(
          t(
            "투명도 설정을 변경하지 못했습니다.",
            "Could not change transparency settings.",
          ),
        );
      });
  };

  const changeWindowOpacity = (value: number) => {
    changeWindowTransparency({ opacity: value });
  };

  const changeTransparencyMode = (mode: TransparencyMode) => {
    if (
      mode === "background-only" &&
      !backgroundOnlyTransparencySupported
    ) {
      return;
    }
    changeWindowTransparency({ mode });
  };

  const togglePinned = async () => {
    const next = await window.tokenCat?.togglePin();
    if (typeof next === "boolean") {
      setPinned(next);
      setToast(
        next
          ? t("항상 위에 고정했습니다.", "Pinned TokenCat above other windows.")
          : t("항상 위 고정을 해제했습니다.", "Always-on-top was disabled."),
      );
    }
  };

  const changeCompact = (next: boolean) => {
    setCompactState(next);
    setToast(
      next
        ? t("컴팩트 모드로 전환했습니다.", "Switched to compact mode.")
        : t("기본 크기로 전환했습니다.", "Restored the standard size."),
    );
  };

  const changeMinimal = (
    next: boolean,
    requestedOrientation?: MinimalOrientation,
    source: "manual" | "auto" = "manual",
  ) => {
    const nextOrientation =
      requestedOrientation ??
      (source === "manual" && !autoMinimal
        ? minimalOrientation
        : chooseMinimalOrientationForSize(
            responsiveWindowSize.width > 0
              ? responsiveWindowSize
              : windowSizeState.currentWindowSize,
            autoMinimalWidth,
            autoMinimalHeight,
          ));
    if (next === minimal) {
      if (next && nextOrientation !== minimalOrientation) {
        pendingWindowModeTransitionRef.current =
          source === "auto" ? "auto-resize" : "manual";
        setMinimalOrientation(nextOrientation);
        setMinimalChromeVisible(true);
        scheduleMinimalChromeHide();
        setToast(
          nextOrientation === "horizontal"
            ? t(
                "가로 미니멀 모드로 전환했습니다.",
                "Switched to horizontal minimal mode.",
              )
            : nextOrientation === "medium"
              ? t(
                  "중간 미니멀 모드로 전환했습니다.",
                  "Switched to medium minimal mode.",
                )
              : t(
                  "세로 미니멀 모드로 전환했습니다.",
                  "Switched to vertical minimal mode.",
                ),
        );
      }
      return;
    }
    if (next && windowSizeState.sizeLocked) {
      setToast(
        t(
          "미니멀 모드를 사용하려면 먼저 창 크기 고정을 해제해 주세요.",
          "Unlock the window size before entering minimal mode.",
        ),
      );
      return;
    }
    if (next && layoutEditing) {
      setLayoutEditing(false);
      draggedAccountIdRef.current = null;
      setDraggedAccountId(null);
      setDropTarget(null);
    }
    if (next) {
      setActiveView("usage");
      setFilter("all");
      if (!settingsWindowMode) setSettingsOpen(false);
      setAddOpen(false);
      setEditingId(null);
      setPendingManagedRemoval(null);
    }
    if (next) {
      autoMinimalSuppressedRef.current = false;
      setMinimalOrientation(nextOrientation);
    } else {
      autoMinimalSuppressedRef.current = source === "manual";
    }
    pendingWindowModeTransitionRef.current =
      source === "auto" ? "auto-resize" : "manual";
    setMinimal(next);
    setTitlebarHidden(next && source === "auto");
    setToast(
      next
        ? source === "auto"
          ? nextOrientation === "medium"
            ? t(
                `창 폭이 ${autoMinimalWidth}px 이하라 중간 미니멀 모드로 전환했습니다.`,
                `Switched to medium minimal mode below ${autoMinimalWidth}px wide.`,
              )
            : nextOrientation === "vertical"
              ? t(
                  `창 폭이 ${VERTICAL_MINIMAL_ENTER_WIDTH}px 미만이라 세로 미니멀 모드로 전환했습니다.`,
                  `Switched to vertical minimal mode below ${VERTICAL_MINIMAL_ENTER_WIDTH}px wide.`,
                )
              : t(
                  `창 높이가 ${autoMinimalHeight}px 이하라 가로 미니멀 모드로 전환했습니다.`,
                  `Switched to horizontal minimal mode below ${autoMinimalHeight}px tall.`,
                )
          : nextOrientation === "horizontal"
            ? t(
                "가로 미니멀 모드로 전환했습니다.",
                "Switched to horizontal minimal mode.",
              )
            : nextOrientation === "medium"
              ? t(
                  "중간 미니멀 모드로 전환했습니다.",
                  "Switched to medium minimal mode.",
                )
              : t(
                  "세로 미니멀 모드로 전환했습니다.",
                  "Switched to vertical minimal mode.",
                )
        : source === "auto"
          ? t(
              "창을 늘려 기본 모드로 돌아왔습니다.",
              "Expanded back to standard mode.",
            )
          : t(
              "이전 창 크기로 돌아왔습니다.",
              "Restored the previous window size.",
            ),
    );
  };

  useEffect(() => {
    if (!windowModeReady || settingsWindowMode) return;
    const currentSize = responsiveWindowSize;
    if (currentSize.width <= 0 || currentSize.height <= 0) return;
    if (!autoMinimal || windowSizeState.sizeLocked) return;

    if (minimal) {
      if (
        shouldExitMinimalForSize(
          currentSize,
          autoMinimalWidth,
          autoMinimalHeight,
        )
      ) {
        changeMinimal(false, undefined, "auto");
        return;
      }

      const nextOrientation = chooseActiveMinimalOrientationForSize(
        currentSize,
        autoMinimalWidth,
        autoMinimalHeight,
        minimalOrientation,
      );
      if (nextOrientation !== minimalOrientation) {
        changeMinimal(true, nextOrientation, "auto");
      }
      return;
    }

    if (autoMinimalSuppressedRef.current) {
      const safelyExpanded = shouldExitMinimalForSize(
        currentSize,
        autoMinimalWidth,
        autoMinimalHeight,
      );
      if (!safelyExpanded) return;
      autoMinimalSuppressedRef.current = false;
    }

    const widthSmall = currentSize.width <= autoMinimalWidth;
    const heightSmall = currentSize.height <= autoMinimalHeight;
    if (!widthSmall && !heightSmall) return;

    changeMinimal(
      true,
      chooseMinimalOrientationForSize(
        currentSize,
        autoMinimalWidth,
        autoMinimalHeight,
      ),
      "auto",
    );
  }, [
    autoMinimal,
    autoMinimalHeight,
    autoMinimalWidth,
    minimal,
    minimalOrientation,
    responsiveWindowSize,
    settingsWindowMode,
    windowModeReady,
    windowSizeState.sizeLocked,
  ]);

  const changeDisplayScale = (
    key: DisplayScaleKey,
    value: number,
  ) => {
    setDisplayPreferences((current) => ({
      ...current,
      [key]: normalizeDisplayScale(key, value),
    }));
  };

  const changeLayoutEditing = (next: boolean) => {
    setLayoutEditing(next);
    draggedAccountIdRef.current = null;
    setDraggedAccountId(null);
    setDropTarget(null);
    if (!next) scheduleTitlebarHide();
    if (next) setFilter("all");
    setToast(
      next
        ? t(
            "카드 핸들을 끌어 순서를 바꾸고 배치를 선택하세요.",
            "Drag card handles to reorder, then choose a layout.",
          )
        : t("배치 편집을 완료했습니다.", "Finished editing the layout."),
    );
  };

  const changeAppView = (next: AppView) => {
    if (next === activeView) return;
    if (next === "insights" && layoutEditing) {
      changeLayoutEditing(false);
    }
    setActiveView(next);
  };

  const moveAccount = (accountId: string, direction: -1 | 1) => {
    const currentIndex = accounts.findIndex(
      (account) => account.id === accountId,
    );
    const nextIndex = currentIndex + direction;
    if (
      currentIndex < 0 ||
      nextIndex < 0 ||
      nextIndex >= accounts.length
    ) {
      return;
    }

    const movedAccount = accounts[currentIndex];
    setAccounts((current) => {
      const from = current.findIndex((account) => account.id === accountId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
    setToast(
      direction < 0
        ? t(
            `${accountDisplayName(movedAccount, language)} 카드를 이전 순서로 이동했습니다.`,
            `Moved ${accountDisplayName(movedAccount, language)} backward.`,
          )
        : t(
            `${accountDisplayName(movedAccount, language)} 카드를 다음 순서로 이동했습니다.`,
            `Moved ${accountDisplayName(movedAccount, language)} forward.`,
          ),
    );
  };

  const reorderAccount = (
    sourceAccountId: string,
    targetAccountId: string,
    position: DropPosition,
  ) => {
    if (sourceAccountId === targetAccountId) return;
    const movedAccount = accounts.find(
      (account) => account.id === sourceAccountId,
    );
    const targetAccount = accounts.find(
      (account) => account.id === targetAccountId,
    );
    if (!movedAccount || !targetAccount) return;

    setAccounts((current) => {
      const sourceIndex = current.findIndex(
        (account) => account.id === sourceAccountId,
      );
      if (sourceIndex < 0) return current;
      const next = [...current];
      const [source] = next.splice(sourceIndex, 1);
      const targetIndex = next.findIndex(
        (account) => account.id === targetAccountId,
      );
      if (targetIndex < 0) return current;
      const insertIndex = targetIndex + (position === "after" ? 1 : 0);
      next.splice(insertIndex, 0, source);
      return next;
    });
    setToast(
      t(
        `${accountDisplayName(movedAccount, language)} 카드를 ${accountDisplayName(targetAccount, language)} ${
          position === "before" ? "앞" : "뒤"
        }으로 옮겼습니다.`,
        `Moved ${accountDisplayName(movedAccount, language)} ${
          position === "before" ? "before" : "after"
        } ${accountDisplayName(targetAccount, language)}.`,
      ),
    );
  };

  const startAccountDrag = (
    event: DragEvent<HTMLButtonElement>,
    accountId: string,
  ) => {
    if (!layoutEditing) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", accountId);
    const card = event.currentTarget.closest<HTMLElement>(".account-card");
    if (card) {
      const bounds = card.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        card,
        Math.max(0, Math.min(event.clientX - bounds.left, bounds.width)),
        Math.max(0, Math.min(event.clientY - bounds.top, bounds.height)),
      );
    }
    draggedAccountIdRef.current = accountId;
    clearTitlebarHideTimer();
    setDraggedAccountId(accountId);
    setDropTarget(null);
  };

  const dragAccountOver = (
    event: DragEvent<HTMLElement>,
    accountId: string,
  ) => {
    const sourceAccountId = draggedAccountIdRef.current;
    if (!layoutEditing || !sourceAccountId || sourceAccountId === accountId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: DropPosition =
      usesHorizontalSequence(layoutMode, gridSingleColumn)
        ? event.clientX < bounds.left + bounds.width / 2
          ? "before"
          : "after"
        : event.clientY < bounds.top + bounds.height / 2
          ? "before"
          : "after";
    setDropTarget((current) =>
      current?.accountId === accountId && current.position === position
        ? current
        : { accountId, position },
    );
  };

  const dropAccount = (
    event: DragEvent<HTMLElement>,
    targetAccountId: string,
  ) => {
    if (!layoutEditing) return;
    event.preventDefault();
    const sourceAccountId =
      draggedAccountIdRef.current ||
      event.dataTransfer.getData("text/plain");
    if (sourceAccountId && sourceAccountId !== targetAccountId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const position: DropPosition =
        usesHorizontalSequence(layoutMode, gridSingleColumn)
          ? event.clientX < bounds.left + bounds.width / 2
            ? "before"
            : "after"
          : event.clientY < bounds.top + bounds.height / 2
            ? "before"
            : "after";
      reorderAccount(sourceAccountId, targetAccountId, position);
    }
    finishAccountDrag();
  };

  const finishAccountDrag = () => {
    draggedAccountIdRef.current = null;
    setDraggedAccountId(null);
    setDropTarget(null);
    scheduleTitlebarHide();
  };

  const toggleMaximized = async () => {
    if (windowSizeState.sizeLocked) return;
    const next = await window.tokenCat?.toggleMaximize();
    if (typeof next === "boolean") setMaximized(next);
  };

  const changeWindowSizeLocked = async (next: boolean) => {
    if (!window.tokenCat || windowSizeBusy) return;
    setWindowSizeBusy("lock");
    try {
      const state = await window.tokenCat.setWindowSizeLocked(next);
      setWindowSizeState(state);
      setMaximized(false);
      setToast(
        next
          ? t(
              "현재 배치의 창 크기를 고정했습니다.",
              "Locked the window size for this layout.",
            )
          : t(
              "창 크기 고정을 해제했습니다.",
              "Window size is unlocked.",
            ),
      );
    } catch {
      setToast(
        t(
          "창 크기 고정 설정을 적용하지 못했습니다.",
          "Could not update the window size lock.",
        ),
      );
    } finally {
      setWindowSizeBusy(null);
    }
  };

  const saveCurrentWindowSize = async () => {
    if (!window.tokenCat || windowSizeBusy || maximized) return;
    setWindowSizeBusy("save");
    try {
      const state = await window.tokenCat.saveCurrentWindowSize();
      setWindowSizeState(state);
      setToast(
        t(
          "현재 창 크기를 이 배치에 저장했습니다.",
          "Saved the current size for this layout.",
        ),
      );
    } catch {
      setToast(
        t(
          "현재 창 크기를 저장하지 못했습니다.",
          "Could not save the current window size.",
        ),
      );
    } finally {
      setWindowSizeBusy(null);
    }
  };

  const resetSavedWindowSize = async () => {
    if (!window.tokenCat || windowSizeBusy) return;
    setWindowSizeBusy("reset");
    try {
      const state = await window.tokenCat.resetSavedWindowSize();
      setWindowSizeState(state);
      setMaximized(false);
      setToast(
        t(
          "현재 배치를 기본 창 크기로 복원했습니다.",
          "Restored the default size for this layout.",
        ),
      );
    } catch {
      setToast(
        t(
          "기본 창 크기로 복원하지 못했습니다.",
          "Could not restore the default window size.",
        ),
      );
    } finally {
      setWindowSizeBusy(null);
    }
  };

  const getCurrentColor = (role: ColorRole) =>
    colorPreferences.themes[theme]?.[role] ??
    THEME_COLOR_DEFAULTS[theme][role];

  const getDefaultGraphPaint = (provider: Provider): GraphPaint => {
    const start = getCurrentColor(provider === "Claude" ? "claude" : "codex");
    return {
      mode: "solid",
      start,
      end: mixHex(
        start,
        isDarkTheme(theme) ? "#FFFFFF" : "#000000",
        isDarkTheme(theme) ? 0.26 : 0.18,
      ),
      angle: 90,
    };
  };

  const getProviderGraphPaint = (provider: Provider) =>
    graphColorPreferences.themes[theme]?.providers?.[provider] ??
    getDefaultGraphPaint(provider);

  const getAccountGraphPaint = (account: Account) =>
    graphColorPreferences.themes[theme]?.accounts?.[account.id] ??
    getProviderGraphPaint(account.provider);

  const getGraphScopePaint = (scope: GraphColorScope) => {
    if (scope.startsWith("provider:")) {
      return getProviderGraphPaint(scope.slice("provider:".length) as Provider);
    }
    const accountId = scope.slice("account:".length);
    const account = accounts.find((item) => item.id === accountId);
    return account
      ? getAccountGraphPaint(account)
      : getProviderGraphPaint("Claude");
  };

  const graphScopeHasOverride = (scope: GraphColorScope) => {
    if (scope.startsWith("provider:")) {
      const provider = scope.slice("provider:".length) as Provider;
      return Boolean(
        graphColorPreferences.themes[theme]?.providers?.[provider],
      );
    }
    return Boolean(
      graphColorPreferences.themes[theme]?.accounts?.[
        scope.slice("account:".length)
      ],
    );
  };

  const resolvePercentageColors = (
    provider: Provider,
    normalColor: string,
    accountId?: string,
  ): Record<UsageTone, string> => {
    const currentTheme = percentageColorPreferences.themes[theme];
    const providerColors = currentTheme?.providers?.[provider] ?? {};
    const accountColors =
      (accountId ? currentTheme?.accounts?.[accountId] : undefined) ?? {};
    const surface = getCurrentColor("surface");
    const readable = (color: string) => {
      if (contrastRatio(color, surface) >= 4.5) return color;
      const contrastTarget = bestContrastColor(surface);
      for (let step = 1; step <= 8; step += 1) {
        const adjusted = mixHex(color, contrastTarget, step * 0.08);
        if (contrastRatio(adjusted, surface) >= 4.5) return adjusted;
      }
      return contrastTarget;
    };

    return {
      normal: readable(
        accountColors.normal ?? providerColors.normal ?? normalColor,
      ),
      warning: readable(
        accountColors.warning ??
          providerColors.warning ??
          THEME_PERCENTAGE_DEFAULTS[theme].warning,
      ),
      danger: readable(
        accountColors.danger ??
          providerColors.danger ??
          THEME_PERCENTAGE_DEFAULTS[theme].danger,
      ),
    };
  };

  const getAccountPercentageColors = (account: Account) =>
    resolvePercentageColors(
      account.provider,
      getAccountGraphPaint(account).start,
      account.id,
    );

  const getPercentageScopeColors = (
    scope: GraphColorScope,
  ): Record<UsageTone, string> => {
    if (scope.startsWith("provider:")) {
      const provider = scope.slice("provider:".length) as Provider;
      return resolvePercentageColors(
        provider,
        getProviderGraphPaint(provider).start,
      );
    }

    const account = accounts.find(
      (item) => item.id === scope.slice("account:".length),
    );
    return account
      ? getAccountPercentageColors(account)
      : resolvePercentageColors(
          "Claude",
          getProviderGraphPaint("Claude").start,
        );
  };

  const resolvePercentageGraphEnabled = (
    provider: Provider,
    accountId?: string,
  ) => {
    if (
      accountId &&
      typeof percentageGraphPreferences.accounts[accountId] === "boolean"
    ) {
      return percentageGraphPreferences.accounts[accountId];
    }
    const providerValue = percentageGraphPreferences.providers[provider];
    return typeof providerValue === "boolean" ? providerValue : false;
  };

  const getAccountPercentageGraphEnabled = (account: Account) =>
    resolvePercentageGraphEnabled(account.provider, account.id);

  const getPercentageGraphScopeEnabled = (scope: GraphColorScope) => {
    if (scope.startsWith("provider:")) {
      return resolvePercentageGraphEnabled(
        scope.slice("provider:".length) as Provider,
      );
    }
    const account = accounts.find(
      (item) => item.id === scope.slice("account:".length),
    );
    return account ? getAccountPercentageGraphEnabled(account) : false;
  };

  const percentageGraphScopeHasOverride = (scope: GraphColorScope) => {
    if (scope.startsWith("provider:")) {
      const provider = scope.slice("provider:".length) as Provider;
      return (
        typeof percentageGraphPreferences.providers[provider] === "boolean"
      );
    }
    return (
      typeof percentageGraphPreferences.accounts[
        scope.slice("account:".length)
      ] === "boolean"
    );
  };

  const percentageScopeHasOverride = (scope: GraphColorScope) => {
    if (scope.startsWith("provider:")) {
      const provider = scope.slice("provider:".length) as Provider;
      return (
        Boolean(
          percentageColorPreferences.themes[theme]?.providers?.[provider],
        ) || percentageGraphScopeHasOverride(scope)
      );
    }
    return (
      Boolean(
        percentageColorPreferences.themes[theme]?.accounts?.[
          scope.slice("account:".length)
        ],
      ) || percentageGraphScopeHasOverride(scope)
    );
  };

  const updatePercentageScopeColor = (
    scope: GraphColorScope,
    tone: UsageTone,
    value: string,
  ) => {
    const color = normalizeHex(value);
    if (!color) return false;
    if (contrastRatio(color, getCurrentColor("surface")) < 4.5) {
      setToast(
        t(
          "카드에서 퍼센트가 잘 보이지 않는 색상입니다.",
          "That color would make percentages difficult to read.",
        ),
      );
      return false;
    }

    setPercentageColorPreferences((current) => {
      const currentTheme = current.themes[theme] ?? {};
      const providers = { ...(currentTheme.providers ?? {}) };
      const accountColors = { ...(currentTheme.accounts ?? {}) };

      if (scope.startsWith("provider:")) {
        const provider = scope.slice("provider:".length) as Provider;
        providers[provider] = {
          ...(providers[provider] ?? {}),
          [tone]: color,
        };
      } else {
        const accountId = scope.slice("account:".length);
        accountColors[accountId] = {
          ...(accountColors[accountId] ?? {}),
          [tone]: color,
        };
      }

      return {
        version: 1,
        themes: {
          ...current.themes,
          [theme]: { providers, accounts: accountColors },
        },
      };
    });
    return true;
  };

  const updatePercentageGraphScope = (
    scope: GraphColorScope,
    enabled: boolean,
  ) => {
    setPercentageGraphPreferences((current) => {
      if (scope.startsWith("provider:")) {
        const provider = scope.slice("provider:".length) as Provider;
        return {
          ...current,
          providers: { ...current.providers, [provider]: enabled },
        };
      }
      const accountId = scope.slice("account:".length);
      return {
        ...current,
        accounts: { ...current.accounts, [accountId]: enabled },
      };
    });
  };

  const resetPercentageGraphScope = (scope: GraphColorScope) => {
    setPercentageGraphPreferences((current) => {
      if (scope.startsWith("provider:")) {
        const provider = scope.slice("provider:".length) as Provider;
        if (typeof current.providers[provider] !== "boolean") return current;
        const providers = { ...current.providers };
        delete providers[provider];
        return { ...current, providers };
      }
      const accountId = scope.slice("account:".length);
      if (typeof current.accounts[accountId] !== "boolean") return current;
      const accountOverrides = { ...current.accounts };
      delete accountOverrides[accountId];
      return { ...current, accounts: accountOverrides };
    });
  };

  const resetPercentageScopeColors = (scope: GraphColorScope) => {
    setPercentageColorPreferences((current) => {
      const currentTheme = current.themes[theme];
      if (!currentTheme) return current;
      const providers = { ...(currentTheme.providers ?? {}) };
      const accountColors = { ...(currentTheme.accounts ?? {}) };

      if (scope.startsWith("provider:")) {
        delete providers[scope.slice("provider:".length) as Provider];
      } else {
        delete accountColors[scope.slice("account:".length)];
      }

      const nextThemes = { ...current.themes };
      if (Object.keys(providers).length || Object.keys(accountColors).length) {
        nextThemes[theme] = { providers, accounts: accountColors };
      } else {
        delete nextThemes[theme];
      }
      return { version: 1, themes: nextThemes };
    });
    resetPercentageGraphScope(scope);
    setToast(
      t(
        "사용량 단계 색상과 그래프 적용 방식을 상위 기본값으로 되돌렸습니다.",
        "Usage colors and graph behavior now use their inherited defaults.",
      ),
    );
  };

  const removePercentageAccountOverride = (accountId: string) => {
    setPercentageColorPreferences((current) => {
      let changed = false;
      const nextThemes = { ...current.themes };

      THEMES.forEach((savedTheme) => {
        const saved = nextThemes[savedTheme];
        if (!saved?.accounts?.[accountId]) return;
        const accountsWithoutRemoved = { ...saved.accounts };
        delete accountsWithoutRemoved[accountId];
        changed = true;
        if (
          Object.keys(saved.providers ?? {}).length ||
          Object.keys(accountsWithoutRemoved).length
        ) {
          nextThemes[savedTheme] = {
            providers: { ...(saved.providers ?? {}) },
            accounts: accountsWithoutRemoved,
          };
        } else {
          delete nextThemes[savedTheme];
        }
      });

      return changed ? { version: 1, themes: nextThemes } : current;
    });
    setPercentageGraphPreferences((current) => {
      if (typeof current.accounts[accountId] !== "boolean") return current;
      const accountOverrides = { ...current.accounts };
      delete accountOverrides[accountId];
      return { ...current, accounts: accountOverrides };
    });
  };

  const setGraphScopePaint = (
    scope: GraphColorScope,
    paint: GraphPaint,
  ) => {
    setGraphColorPreferences((current) => {
      const currentTheme = current.themes[theme] ?? {};
      const providers = { ...(currentTheme.providers ?? {}) };
      const accountColors = { ...(currentTheme.accounts ?? {}) };

      if (scope.startsWith("provider:")) {
        providers[scope.slice("provider:".length) as Provider] = paint;
      } else {
        accountColors[scope.slice("account:".length)] = paint;
      }

      return {
        version: 1,
        themes: {
          ...current.themes,
          [theme]: {
            providers,
            accounts: accountColors,
          },
        },
      };
    });
  };

  const updateGraphScopePaint = (
    scope: GraphColorScope,
    patch: Partial<GraphPaint>,
  ) => {
    const current = getGraphScopePaint(scope);
    const next = normalizeGraphPaint({ ...current, ...patch });
    if (!next) return false;
    const surface = getCurrentColor("surface");
    const stops =
      next.mode === "gradient" ? [next.start, next.end] : [next.start];
    if (stops.some((color) => contrastRatio(color, surface) < 1.6)) {
      setToast(
        t(
          "카드 배경과 너무 비슷한 그래프 색상입니다.",
          "That graph color is too close to the card background.",
        ),
      );
      return false;
    }
    setGraphScopePaint(scope, next);
    return true;
  };

  const removeGraphAccountOverride = (
    accountId: string,
    provider: Provider,
  ) => {
    setGraphColorPreferences((current) => {
      let changed = false;
      const nextThemes = { ...current.themes };

      THEMES.forEach((savedTheme) => {
        const saved = nextThemes[savedTheme];
        if (!saved?.accounts?.[accountId]) return;
        const accountsWithoutRemoved = { ...saved.accounts };
        delete accountsWithoutRemoved[accountId];
        changed = true;
        if (
          Object.keys(saved.providers ?? {}).length ||
          Object.keys(accountsWithoutRemoved).length
        ) {
          nextThemes[savedTheme] = {
            providers: { ...(saved.providers ?? {}) },
            accounts: accountsWithoutRemoved,
          };
        } else {
          delete nextThemes[savedTheme];
        }
      });

      return changed ? { version: 1, themes: nextThemes } : current;
    });
    setGraphColorScope((current) =>
      current === `account:${accountId}` ? `provider:${provider}` : current,
    );
  };

  const resetGraphScopePaint = (scope: GraphColorScope) => {
    setGraphColorPreferences((current) => {
      const currentTheme = current.themes[theme];
      if (!currentTheme) return current;
      const providers = { ...(currentTheme.providers ?? {}) };
      const accountColors = { ...(currentTheme.accounts ?? {}) };

      if (scope.startsWith("provider:")) {
        delete providers[scope.slice("provider:".length) as Provider];
      } else {
        delete accountColors[scope.slice("account:".length)];
      }

      const nextThemes = { ...current.themes };
      if (Object.keys(providers).length || Object.keys(accountColors).length) {
        nextThemes[theme] = { providers, accounts: accountColors };
      } else {
        delete nextThemes[theme];
      }
      return { version: 1, themes: nextThemes };
    });
    setToast(
      t(
        "선택한 범위를 전역 기본 색상으로 되돌렸습니다.",
        "The selected scope now uses its global default.",
      ),
    );
  };

  const changeGraphPaintMode = (
    scope: GraphColorScope,
    mode: GraphPaintMode,
  ) => {
    const current = getGraphScopePaint(scope);
    if (current.mode === mode) return;
    updateGraphScopePaint(scope, {
      mode,
      end:
        mode === "gradient" && current.end === current.start
          ? mixHex(
              current.start,
              isDarkTheme(theme) ? "#FFFFFF" : "#000000",
              isDarkTheme(theme) ? 0.26 : 0.18,
            )
          : current.end,
    });
  };

  const applyColor = (
    role: ColorRole,
    value: string,
    announce = false,
  ) => {
    const color = normalizeHex(value);
    if (!color) {
      setToast(
        t(
          "6자리 HEX 색상만 사용할 수 있습니다.",
          "Use a six-digit HEX color.",
        ),
      );
      return false;
    }

    const surfaceColor =
      role === "surface" ? color : getCurrentColor("surface");

    if (
      (role === "appBg" || role === "surface") &&
      THEME_FOREGROUND_COLORS[theme].some(
        (foreground) => contrastRatio(color, foreground) < 4.5,
      )
    ) {
      setToast(
        t(
          "작은 보조 글자가 흐려지는 색이라 적용하지 않았습니다.",
          "That color would make small secondary text difficult to read.",
        ),
      );
      return false;
    }

    if (
      (role === "accent" || role === "claude" || role === "codex") &&
      contrastRatio(color, surfaceColor) < 3
    ) {
      setToast(
        t(
          "카드에서 잘 보이지 않는 색이라 적용하지 않았습니다.",
          "That color would be difficult to see on cards.",
        ),
      );
      return false;
    }

    if (role === "surface") {
      const providerColors = [
        getCurrentColor("accent"),
        getCurrentColor("claude"),
        getCurrentColor("codex"),
      ];
      if (
        providerColors.some(
          (providerColor) => contrastRatio(providerColor, color) < 3,
        )
      ) {
        setToast(
          t(
            "현재 그래프 색과 구분되지 않는 카드 색입니다.",
            "That card color is too close to the current graph colors.",
          ),
        );
        return false;
      }
    }

    setColorPreferences((current) => ({
      version: 1,
      themes: {
        ...current.themes,
        [theme]: {
          ...current.themes[theme],
          [role]: color,
        },
      },
    }));
    if (announce) {
      setToast(
        t(`${color} 색상을 적용했습니다.`, `Applied the color ${color}.`),
      );
    }
    return true;
  };

  const resetColor = (role: ColorRole) => {
    setColorPreferences((current) => {
      const nextThemes = { ...current.themes };
      const nextTheme = { ...nextThemes[theme] };
      delete nextTheme[role];
      if (Object.keys(nextTheme).length) {
        nextThemes[theme] = nextTheme;
      } else {
        delete nextThemes[theme];
      }
      return { version: 1, themes: nextThemes };
    });
    setToast(
      t(
        "선택한 색상을 기본값으로 되돌렸습니다.",
        "Restored the selected color to its default.",
      ),
    );
  };

  const resetThemeColors = () => {
    setColorPreferences((current) => {
      const nextThemes = { ...current.themes };
      delete nextThemes[theme];
      return { version: 1, themes: nextThemes };
    });
    setToast(
      t(
        "현재 테마 색상을 모두 초기화했습니다.",
        "Reset all colors for the current theme.",
      ),
    );
  };

  const pickColorFromScreen = async (role: ColorRole) => {
    const openNativeColorPicker = () =>
      (
        document.getElementById(
          `tokencat-color-${role}`,
        ) as HTMLInputElement | null
      )?.click();
    const EyeDropperApi = (
      window as Window & { EyeDropper?: EyeDropperConstructor }
    ).EyeDropper;

    if (!EyeDropperApi) {
      openNativeColorPicker();
      setToast(t("색상 선택창을 열었습니다.", "Opened the color picker."));
      return;
    }

    try {
      const result = await new EyeDropperApi().open();
      applyColor(role, result.sRGBHex, true);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        openNativeColorPicker();
        setToast(
          t(
            "스포이트 대신 색상 선택창을 열었습니다.",
            "Opened the color picker instead of the eyedropper.",
          ),
        );
      }
    }
  };

  const pickGraphColorFromScreen = async (
    scope: GraphColorScope,
    stop: "start" | "end",
    inputNamespace = "settings",
  ) => {
    const openNativeColorPicker = () =>
      (
        document.getElementById(
          graphColorInputId(scope, stop, inputNamespace),
        ) as HTMLInputElement | null
      )?.click();
    const EyeDropperApi = (
      window as Window & { EyeDropper?: EyeDropperConstructor }
    ).EyeDropper;

    if (!EyeDropperApi) {
      openNativeColorPicker();
      setToast(t("색상 선택창을 열었습니다.", "Opened the color picker."));
      return;
    }

    try {
      const result = await new EyeDropperApi().open();
      if (updateGraphScopePaint(scope, { [stop]: result.sRGBHex })) {
        setToast(
          t(
            `${result.sRGBHex} 그래프 색상을 적용했습니다.`,
            `Applied ${result.sRGBHex} to the graph.`,
          ),
        );
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        openNativeColorPicker();
        setToast(
          t(
            "스포이트 대신 색상 선택창을 열었습니다.",
            "Opened the color picker instead of the eyedropper.",
          ),
        );
      }
    }
  };

  const pickPercentageColorFromScreen = async (
    scope: GraphColorScope,
    tone: UsageTone,
    inputNamespace = "settings",
  ) => {
    const openNativeColorPicker = () =>
      (
        document.getElementById(
          percentageColorInputId(scope, tone, inputNamespace),
        ) as HTMLInputElement | null
      )?.click();
    const EyeDropperApi = (
      window as Window & { EyeDropper?: EyeDropperConstructor }
    ).EyeDropper;

    if (!EyeDropperApi) {
      openNativeColorPicker();
      setToast(t("색상 선택창을 열었습니다.", "Opened the color picker."));
      return;
    }

    try {
      const result = await new EyeDropperApi().open();
      if (updatePercentageScopeColor(scope, tone, result.sRGBHex)) {
        setToast(
          t(
            `${result.sRGBHex} 퍼센트 글자색을 적용했습니다.`,
            `Applied ${result.sRGBHex} to percentage text.`,
          ),
        );
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        openNativeColorPicker();
        setToast(
          t(
            "스포이트 대신 색상 선택창을 열었습니다.",
            "Opened the color picker instead of the eyedropper.",
          ),
        );
      }
    }
  };

  const refresh = async () => {
    if (
      syncing ||
      manualIntegrationRefresh.current ||
      integrationRefreshInFlight.current
    ) {
      setToast(
        t(
          "이미 사용량을 동기화하고 있습니다.",
          "Usage is already being synchronized.",
        ),
      );
      return;
    }
    const bridge = getManagedBridge();
    const refreshRequests: Array<{
      kind: "system" | "managed";
      promise: Promise<IntegrationSnapshot[]>;
      epoch?: number;
    }> = [];
    if (bridge?.refreshIntegrations) {
      refreshRequests.push({
        kind: "system",
        promise: bridge.refreshIntegrations(),
      });
    }
    if (bridge?.refreshManagedIntegrations) {
      refreshRequests.push({
        kind: "managed",
        promise: bridge.refreshManagedIntegrations(),
        epoch: managedMutationEpoch.current,
      });
    }

    if (!refreshRequests.length) {
      animatePets();
      window.setTimeout(() => {
        setLastSync("방금 전");
        setToast(
          t("저장된 사용량을 다시 불러왔습니다.", "Reloaded saved usage."),
        );
      }, 650);
      return;
    }

    setSyncing(true);
    integrationRefreshInFlight.current = true;
    const refreshRequest = Promise.allSettled(
      refreshRequests.map((request) => request.promise),
    ).then((results) => {
      const snapshots: IntegrationSnapshot[] = [];
      let fulfilledCount = 0;
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        fulfilledCount += 1;
        snapshots.push(...result.value);
        if (refreshRequests[index].kind === "managed") {
          replaceManagedIntegrationSnapshots(
            result.value,
            refreshRequests[index].epoch,
          );
        } else {
          applyIntegrationSnapshots(result.value);
        }
      });
      if (!fulfilledCount) {
        throw new Error("All integration refreshes failed");
      }
      return snapshots;
    });
    manualIntegrationRefresh.current = refreshRequest;
    try {
      const snapshots = await refreshRequest;
      setLastSync("방금 전");
      const usageCount = snapshots.filter(
        (snapshot) =>
          snapshot.connected &&
          (snapshot.quotas.fiveHour ||
            snapshot.quotas.weekly ||
            snapshot.contextTokens),
      ).length;
      const authenticatedCount = snapshots.filter(
        (snapshot) => snapshot.connected,
      ).length;
      setToast(
        usageCount
          ? t(
              `${usageCount}개 AI 계정의 최신 사용량 데이터를 동기화했습니다.`,
              `Synchronized fresh usage data for ${usageCount} AI accounts.`,
            )
          : authenticatedCount
            ? t(
                `${authenticatedCount}개 AI 계정의 공식 로그인을 확인했습니다. 사용량 조회는 자동으로 다시 시도합니다.`,
                `Verified official sign-in for ${authenticatedCount} AI accounts. Usage refresh will retry automatically.`,
              )
          : Object.keys(managedIntegrations).length
            ? t(
                "등록한 계정의 로그인 또는 첫 사용을 기다리고 있습니다.",
                "Waiting for sign-in or first use on a registered account.",
              )
            : t(
                "연동된 계정이 없습니다. 계정 추가에서 연결해 주세요.",
                "No connected accounts. Connect one from Add account.",
              ),
      );
    } catch {
      setToast(
        t(
          "사용량을 불러오지 못했습니다. 연동 상태를 확인해 주세요.",
          "Could not load usage. Check the connection status.",
        ),
      );
    } finally {
      if (manualIntegrationRefresh.current === refreshRequest) {
        manualIntegrationRefresh.current = null;
      }
      integrationRefreshInFlight.current = false;
      setSyncing(false);
    }
  };

  const changeIntegration = async (provider: IntegrationProvider) => {
    const bridge = window.tokenCat;
    if (
      !bridge?.connectIntegration ||
      !bridge?.disconnectIntegration ||
      integrationBusy
    ) {
      return;
    }

    const current = integrations[provider];
    setIntegrationBusy(provider);
    try {
      const snapshot = current.connected
        ? await bridge.disconnectIntegration(provider)
        : await bridge.connectIntegration(provider);
      applyIntegrationSnapshots([snapshot]);

      if (snapshot.status === "connecting") {
        setToast(
          t(
            "Claude 공식 로그인 페이지를 열었습니다. 완료하면 자동으로 연결됩니다.",
            "Opened the official Claude sign-in. TokenCat will connect automatically when it finishes.",
          ),
        );
      } else if (!snapshot.connected && current.connected) {
        setAccounts((accounts) =>
          accounts.filter(
            (account) =>
              account.connectionId !== `local-${provider}` &&
              account.id !== `live-${provider}-local`,
          ),
        );
        setToast(
          t(
            `${providerFromIntegration(provider)} 연동을 해제했습니다. 기존 로그인은 유지됩니다.`,
            `Disconnected ${providerFromIntegration(provider)}. The existing sign-in is unchanged.`,
          ),
        );
      } else if (snapshot.connected) {
        setToast(
          snapshot.quotas.fiveHour || snapshot.quotas.weekly
            ? t(
                `${providerFromIntegration(provider)} 실제 사용량을 연결했습니다.`,
                `Connected live ${providerFromIntegration(provider)} usage.`,
              )
            : t(
                provider === "claude"
                  ? "Claude 공식 로그인을 확인했습니다. 공식 계정 사용량을 자동으로 확인합니다."
                  : `${providerFromIntegration(provider)}를 연결했습니다. 다음 사용 후 한도가 표시됩니다.`,
                provider === "claude"
                  ? "Verified the official Claude sign-in. Official account usage will refresh automatically."
                  : `Connected ${providerFromIntegration(provider)}. Limits will appear after the next use.`,
              ),
        );
      } else {
        setToast(integrationFailureMessage(snapshot, language));
      }
    } catch {
      setToast(
        t(
          "연동 상태를 변경하지 못했습니다.",
          "Could not change the connection status.",
        ),
      );
    } finally {
      setIntegrationBusy(null);
    }
  };

  const startManagedLogin = async (accountId: string) => {
    const bridge = getManagedBridge();
    if (!bridge?.startManagedIntegrationLogin || managedIntegrationBusy) {
      return false;
    }

    setManagedIntegrationBusy(accountId);
    try {
      const snapshot = await bridge.startManagedIntegrationLogin(accountId);
      applyIntegrationSnapshots([snapshot]);
      const provider = providerFromIntegration(snapshot.provider);
      const loginStarted =
        String(snapshot.status) === "connecting" || snapshot.connected;
      setToast(
        loginStarted
          ? t(
              `${provider} 공식 로그인을 열었습니다. 로그인을 마치면 사용량이 자동으로 갱신됩니다.`,
              `Opened the official ${provider} sign-in. Usage updates automatically after sign-in.`,
            )
          : integrationFailureMessage(snapshot, language),
      );
      return loginStarted;
    } catch {
      setToast(
        t(
          "공식 로그인 창을 열지 못했습니다. 잠시 후 다시 시도해 주세요.",
          "Could not open the official sign-in window. Try again shortly.",
        ),
      );
      return false;
    } finally {
      setManagedIntegrationBusy(null);
    }
  };

  const openManagedAccount = async (accountId: string) => {
    const bridge = getManagedBridge();
    const snapshot = managedIntegrations[accountId];
    if (!bridge?.openManagedIntegration || !snapshot || managedIntegrationBusy) {
      return;
    }

    setManagedIntegrationBusy(accountId);
    try {
      const opened = await bridge.openManagedIntegration(accountId);
      if (!opened) throw new Error("Managed account did not open");
      const provider = providerFromIntegration(snapshot.provider);
      setToast(
        provider === "Claude"
          ? t(
              "이 창에서 Claude를 사용하면 해당 계정의 최신 컨텍스트 토큰이 구분되어 갱신됩니다. 5시간·주간 한도는 자동 갱신됩니다.",
              "Using Claude in this window updates context tokens for this account. Its 5-hour and weekly limits refresh automatically.",
            )
          : t(
              "선택한 Codex 계정으로 새 창을 열었습니다.",
              "Opened a new window for the selected Codex account.",
            ),
      );
    } catch (error) {
      setToast(
        error instanceof Error &&
          error.message.includes("MANAGED_ACCOUNT_IN_USE")
          ? t(
              "이 계정으로 연 창이 이미 있습니다. 기존 창을 먼저 확인해 주세요.",
              "A window for this account is already open. Check that window first.",
            )
          : t(
              "선택한 계정으로 앱을 열지 못했습니다.",
              "Could not open the app for the selected account.",
            ),
      );
    } finally {
      setManagedIntegrationBusy(null);
    }
  };

  const removeManagedAccount = async (
    accountId: string,
    confirmed = false,
  ) => {
    const bridge = getManagedBridge();
    const snapshot = managedIntegrations[accountId];
    if (!bridge?.removeManagedIntegration || !snapshot || managedIntegrationBusy) {
      return false;
    }

    const displayName =
      managedSnapshotDetails(snapshot).displayName?.trim() ||
      fallbackAccountName(
        providerFromIntegration(snapshot.provider),
        language,
      );
    if (!confirmed) {
      setPendingManagedRemoval(accountId);
      return false;
    }

    setManagedIntegrationBusy(accountId);
    try {
      const removed = await bridge.removeManagedIntegration(accountId);
      if (!removed) throw new Error("Managed account was not removed");
      managedMutationEpoch.current += 1;
      setManagedIntegrations((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      setAccounts((current) =>
        current.filter(
          (account) =>
            account.connectionId !== `managed-${accountId}` &&
            account.id !== `live-${snapshot.provider}-${accountId}`,
        ),
      );
      setUsageHistory((current) =>
        clearUsageHistoryAccount(
          current,
          `managed:${snapshot.provider}:${accountId}`,
        ),
      );
      removeGraphAccountOverride(
        `live-${snapshot.provider}-${accountId}`,
        providerFromIntegration(snapshot.provider),
      );
      removePercentageAccountOverride(
        `live-${snapshot.provider}-${accountId}`,
      );
      setEditingId((current) =>
        current === `live-${snapshot.provider}-${accountId}` ? null : current,
      );
      setPendingManagedRemoval(null);
      setToast(
        t(
          `${displayName} 등록과 해당 사용량 카드를 제거했습니다.`,
          `Removed ${displayName} and its usage card.`,
        ),
      );
      return true;
    } catch (error) {
      setToast(
        error instanceof Error &&
          error.message.includes("MANAGED_ACCOUNT_IN_USE")
          ? t(
              "이 계정으로 연 Claude/Codex 창을 닫은 뒤 다시 제거해 주세요.",
              "Close the Claude or Codex window opened for this account, then remove it again.",
            )
          : t(
              "등록한 계정을 제거하지 못했습니다.",
              "Could not remove the registered account.",
            ),
      );
      return false;
    } finally {
      setManagedIntegrationBusy(null);
    }
  };

  const addAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = data.get("provider") as Provider;

    if (addMode === "managed") {
      const label = String(data.get("managedLabel") || "").trim();
      const bridge = getManagedBridge();
      if (
        !label ||
        !bridge?.createManagedIntegration ||
        !bridge.startManagedIntegrationLogin ||
        addBusy
      ) {
        if (!bridge?.createManagedIntegration) {
          setToast(
            t(
              "설치된 TokenCat 앱에서 실제 계정을 연결할 수 있습니다.",
              "Real accounts can be connected in the installed TokenCat app.",
            ),
          );
        }
        return;
      }

      setAddBusy(true);
      try {
        const created = await bridge.createManagedIntegration({
          provider: integrationFromProvider(provider),
          label,
        });
        const accountId = managedAccountId(created);
        if (!accountId) throw new Error("Managed account ID is missing");

        managedMutationEpoch.current += 1;
        applyIntegrationSnapshots([created]);
        setFilter("all");
        setAddOpen(false);
        form.reset();
        setToast(
          t(
            `${label} 계정을 등록했습니다. 공식 로그인을 여는 중입니다.`,
            `Registered ${label}. Opening the official sign-in.`,
          ),
        );
        animatePets();

        setManagedIntegrationBusy(accountId);
        try {
          const connecting =
            await bridge.startManagedIntegrationLogin(accountId);
          applyIntegrationSnapshots([connecting]);
          const loginStarted =
            String(connecting.status) === "connecting" ||
            connecting.connected;
          setToast(
            loginStarted
              ? t(
                  `${provider} 공식 로그인을 열었습니다. 완료 후 사용량이 자동으로 표시됩니다.`,
                  `Opened the official ${provider} sign-in. Usage will appear automatically when it is complete.`,
                )
              : integrationFailureMessage(connecting, language),
          );
        } catch {
          setToast(
            t(
              `${label} 계정은 등록했지만 공식 로그인 창을 열지 못했습니다. 설정에서 다시 로그인해 주세요.`,
              `${label} was registered, but the official sign-in could not be opened. Try signing in again from Settings.`,
            ),
          );
        } finally {
          setManagedIntegrationBusy(null);
        }
      } catch {
        setToast(
          t("계정을 등록하지 못했습니다.", "Could not register the account."),
        );
      } finally {
        setAddBusy(false);
      }
      return;
    }

    const name = String(data.get("name") || "").trim();
    const plan = String(data.get("plan") || "").trim();
    if (!name || !plan) return;

    const fiveHourVisible = data.has("fiveHourVisible");
    const weeklyVisible = data.has("weeklyVisible");

    setAccounts((current) => [
      ...current,
      {
        id: `${provider.toLowerCase()}-${Date.now()}`,
        provider,
        name,
        plan,
        quotas: {
          fiveHour: {
            used: clampPercentage(data.get("fiveHour")),
            reset: String(
              data.get("fiveHourReset") || t("직접 입력", "Manual"),
            ),
            visible: fiveHourVisible,
          },
          weekly: {
            used: clampPercentage(data.get("weekly")),
            reset: String(data.get("weeklyReset") || t("직접 입력", "Manual")),
            visible: weeklyVisible || !fiveHourVisible,
          },
        },
        iconMode: "default",
        origin: "manual",
      },
    ]);
    setFilter("all");
    setAddOpen(false);
    setAddProvider("Claude");
    setToast(
      t(`${name} 계정을 추가했습니다.`, `Added the account ${name}.`),
    );
    animatePets();
    form.reset();
  };

  const updateAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingAccount) return;
    const data = new FormData(event.currentTarget);
    const fiveHourVisible = data.has("fiveHourVisible");
    const weeklyVisible = data.has("weeklyVisible");

    setAccounts((current) =>
      current.map((account) =>
        account.id === editingAccount.id
          ? account.origin === "live"
            ? managedAccountIdFromConnection(account.connectionId)
              ? account
              : {
                  ...account,
                  name: String(data.get("name") || account.name).trim(),
                }
            : {
                ...account,
                name: String(data.get("name") || account.name).trim(),
                plan: String(data.get("plan") || account.plan).trim(),
                quotas: {
                  fiveHour: {
                    used: clampPercentage(data.get("fiveHour")),
                    reset: String(
                      data.get("fiveHourReset") || t("직접 입력", "Manual"),
                    ),
                    visible: fiveHourVisible,
                  },
                  weekly: {
                    used: clampPercentage(data.get("weekly")),
                    reset: String(
                      data.get("weeklyReset") || t("직접 입력", "Manual"),
                    ),
                    visible: weeklyVisible || !fiveHourVisible,
                  },
                },
                origin:
                  account.origin === "demo" ? "manual" : account.origin,
              }
          : account,
      ),
    );
    setEditingId(null);
    setLastSync("방금 전");
    setToast(
      t(
        `${editingAccount.name} 정보를 저장했습니다.`,
        `Saved changes to ${editingAccount.name}.`,
      ),
    );
    animatePets();
  };

  const setAccountIcon = (
    id: string,
    iconMode: AccountIconMode,
    customIcon?: string,
  ) => {
    setAccounts((current) =>
      current.map((account) =>
        account.id === id
          ? {
              ...account,
              iconMode,
              customIcon: customIcon ?? account.customIcon,
            }
          : account,
      ),
    );
  };

  const importCustomIcon = (id: string, file?: File) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setToast(
        t(
          "이미지는 4MB 이하로 선택해 주세요.",
          "Choose an image no larger than 4 MB.",
        ),
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const context = canvas.getContext("2d");
        if (!context) return;
        const cropSize = Math.min(image.width, image.height);
        const sx = (image.width - cropSize) / 2;
        const sy = (image.height - cropSize) / 2;
        context.drawImage(image, sx, sy, cropSize, cropSize, 0, 0, 256, 256);
        setAccountIcon(id, "custom", canvas.toDataURL("image/jpeg", 0.86));
        setToast(
          t(
            "내 이미지를 계정 아이콘으로 설정했습니다.",
            "Set your image as the account icon.",
          ),
        );
        animatePets();
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const removeAccount = async () => {
    if (!editingAccount) return;

    if (editingAccount.origin === "live") {
      const managedId = managedAccountIdFromConnection(
        editingAccount.connectionId,
      );
      if (managedId) {
        await removeManagedAccount(managedId);
        return;
      }

      const provider = integrationFromProvider(editingAccount.provider);
      const bridge = window.tokenCat;
      if (!bridge?.disconnectIntegration || integrationBusy) return;
      setIntegrationBusy(provider);
      try {
        const snapshot = await bridge.disconnectIntegration(provider);
        applyIntegrationSnapshots([snapshot]);
      } catch {
        setToast(
          t(
            "연동을 해제하지 못했습니다.",
            "Could not disconnect the integration.",
          ),
        );
        setIntegrationBusy(null);
        return;
      }
      setIntegrationBusy(null);
    }

    const removedHistoryKey = usageHistoryKeyForAccount(editingAccount);
    if (removedHistoryKey) {
      setUsageHistory((current) =>
        clearUsageHistoryAccount(current, removedHistoryKey),
      );
    }
    setAccounts((current) =>
      current.filter((account) => account.id !== editingAccount.id),
    );
    removeGraphAccountOverride(editingAccount.id, editingAccount.provider);
    removePercentageAccountOverride(editingAccount.id);
    setEditingId(null);
    setToast(
      editingAccount.origin === "live"
        ? t(
            `${editingAccount.provider} 연동을 해제했습니다. 기존 로그인은 유지됩니다.`,
            `Disconnected ${editingAccount.provider}. Your existing sign-in remains active.`,
          )
        : t(
            `${editingAccount.name} 계정을 제거했습니다.`,
            `Removed the account ${editingAccount.name}.`,
          ),
    );
  };

  const changeOpenAtLogin = async (next: boolean) => {
    if (!packaged) {
      setToast(
        t(
          "설치된 앱에서 사용할 수 있는 설정입니다.",
          "This setting is available in the installed app.",
        ),
      );
      return;
    }
    const applied = await window.tokenCat?.setOpenAtLogin(next);
    setOpenAtLogin(Boolean(applied));
  };

  const runUpdateAction = async (
    action: "check" | "install" | "download-page",
  ) => {
    const bridge = window.tokenCat;
    if (!bridge || updateActionBusy) return;
    setUpdateActionBusy(action);
    try {
      if (action === "check") {
        const state = await bridge.checkForUpdates();
        if (state) setUpdateState(state);
      } else if (action === "install") {
        const started = await bridge.installUpdate();
        if (!started) {
          setToast(
            t(
              "업데이트 설치 준비가 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.",
              "The update is not ready to install yet. Try again shortly.",
            ),
          );
        }
      } else {
        const opened = await bridge.openUpdateDownloadPage();
        if (!opened) {
          setToast(
            t(
              "설치형 다운로드 페이지를 열지 못했습니다.",
              "Could not open the setup download page.",
            ),
          );
        }
      }
    } catch {
      setToast(
        t(
          "업데이트 작업을 완료하지 못했습니다.",
          "Could not complete the update action.",
        ),
      );
    } finally {
      setUpdateActionBusy(null);
    }
  };

  const requestedGraphAccountId = graphColorScope.startsWith("account:")
    ? graphColorScope.slice("account:".length)
    : null;
  const selectedGraphAccount =
    accounts.find((account) => account.id === requestedGraphAccountId) ?? null;
  const resolvedGraphColorScope: GraphColorScope =
    requestedGraphAccountId && !selectedGraphAccount
      ? "provider:Claude"
      : graphColorScope;
  const selectedGraphPaint = getGraphScopePaint(resolvedGraphColorScope);
  const selectedGraphHasOverride = graphScopeHasOverride(
    resolvedGraphColorScope,
  );
  const selectedPercentageColors = getPercentageScopeColors(
    resolvedGraphColorScope,
  );
  const selectedPercentageHasOverride = percentageScopeHasOverride(
    resolvedGraphColorScope,
  );
  const selectedPercentageGraphEnabled =
    getPercentageGraphScopeEnabled(resolvedGraphColorScope);
  const selectedPercentageGraphInherited =
    !percentageGraphScopeHasOverride(resolvedGraphColorScope);
  const selectedGraphProvider = resolvedGraphColorScope.startsWith("provider:")
    ? (resolvedGraphColorScope.slice("provider:".length) as Provider)
    : selectedGraphAccount?.provider ?? "Claude";
  const editingGraphScope = editingAccount
    ? (`account:${editingAccount.id}` as GraphColorScope)
    : null;
  const editingGraphPaint = editingGraphScope
    ? getGraphScopePaint(editingGraphScope)
    : null;
  const editingGraphHasOverride = editingGraphScope
    ? graphScopeHasOverride(editingGraphScope)
    : false;
  const editingPercentageColors = editingGraphScope
    ? getPercentageScopeColors(editingGraphScope)
    : null;
  const editingPercentageHasOverride = editingGraphScope
    ? percentageScopeHasOverride(editingGraphScope)
    : false;
  const editingPercentageGraphEnabled = editingGraphScope
    ? getPercentageGraphScopeEnabled(editingGraphScope)
    : false;
  const editingPercentageGraphInherited = editingGraphScope
    ? !percentageGraphScopeHasOverride(editingGraphScope)
    : true;
  const lastSyncDisplay =
    lastSync === "방금 전" ? t("방금 전", "just now") : lastSync;
  const dashboardFontVariables = {
    "--window-background-opacity": `${windowOpacity}%`,
    "--dashboard-graph-scale": graphScale / 100,
    "--dashboard-profile-scale": profileScale / 100,
    "--dashboard-profile-size-min": scaledFontSize(
      42,
      26,
      profileScale,
    ),
    "--dashboard-profile-size-max": scaledFontSize(
      56,
      34,
      profileScale,
    ),
    "--dashboard-profile-large-size-min": scaledFontSize(
      44,
      28,
      profileScale,
    ),
    "--dashboard-profile-large-size-max": scaledFontSize(
      82,
      48,
      profileScale,
    ),
    "--dashboard-ring-width-min": scaledFontSize(68, 54, graphScale),
    "--dashboard-ring-width-max": scaledFontSize(91, 72, graphScale),
    "--dashboard-ring-size-min": scaledFontSize(58, 46, graphScale),
    "--dashboard-ring-size-max": scaledFontSize(78, 62, graphScale),
    "--dashboard-ring-large-width-min": scaledFontSize(86, 68, graphScale),
    "--dashboard-ring-large-width-max": scaledFontSize(150, 118, graphScale),
    "--dashboard-ring-large-size-min": scaledFontSize(66, 52, graphScale),
    "--dashboard-ring-large-size-max": scaledFontSize(110, 86, graphScale),
    "--dashboard-ring-center-min": scaledFontSize(48, 40, graphScale),
    "--dashboard-ring-center-max": scaledFontSize(64, 51, graphScale),
    "--dashboard-ring-center-large-min": scaledFontSize(52, 42, graphScale),
    "--dashboard-ring-center-large-max": scaledFontSize(82, 65, graphScale),
    "--dashboard-ring-stroke": String(
      scaledNumber(7.5, 6, graphScale),
    ),
    "--dashboard-bar-height": scaledFontSize(10, 8, graphScale),
    "--dashboard-bar-height-min": scaledFontSize(12, 9.5, graphScale),
    "--dashboard-bar-height-max": scaledFontSize(15, 12, graphScale),
    "--dashboard-bar-height-horizontal": scaledFontSize(
      12,
      9,
      graphScale,
    ),
    "--dashboard-bar-height-large": scaledFontSize(14, 10.5, graphScale),
    "--dashboard-font-small": scaledFontSize(12, 12, secondaryScale),
    "--dashboard-font-medium": scaledFontSize(13, 12, secondaryScale),
    "--dashboard-font-toolbar": scaledFontSize(14, 13, titleScale),
    "--dashboard-font-page-title": scaledFontSize(26, 22, titleScale),
    "--dashboard-font-card-title": scaledFontSize(15, 14, titleScale),
    "--dashboard-font-card-title-large": scaledFontSize(
      23,
      16,
      titleScale,
    ),
    "--dashboard-font-ring-value": scaledFontSize(
      25,
      20,
      percentageScale,
    ),
    "--dashboard-font-ring-value-large": scaledFontSize(
      34,
      24,
      percentageScale,
    ),
    "--dashboard-font-bar-label": scaledFontSize(
      13,
      12,
      secondaryScale,
    ),
    "--dashboard-font-bar-label-vertical": scaledFontSize(
      14,
      12,
      secondaryScale,
    ),
    "--dashboard-font-bar-value": scaledFontSize(
      22,
      20,
      percentageScale,
    ),
    "--dashboard-font-bar-value-horizontal": scaledFontSize(
      23,
      20,
      percentageScale,
    ),
    "--dashboard-font-bar-value-large": scaledFontSize(
      26,
      20,
      percentageScale,
    ),
  } as CSSProperties;

  const openAddPanel = (provider: Provider = "Claude") => {
    setAddProvider(provider);
    setAddMode(
      getManagedBridge()?.createManagedIntegration ? "managed" : "manual",
    );
    setAddOpen(true);
  };

  useEffect(
    () =>
      window.tokenCat?.onOnboardingAccountRequested?.((provider) => {
        if (settingsWindowMode) return;
        setFilter("all");
        setSettingsOpen(false);
        setEditingId(null);
        setPendingManagedRemoval(null);
        openAddPanel(provider);
      }),
    [settingsWindowMode],
  );

  const clearSelectedUsageHistory = () => {
    if (!insightsAccountKey || !insightsAccount) return;
    if (
      !window.confirm(
        t(
          `${accountDisplayName(insightsAccount, language)}의 사용 분석 기록을 지울까요?`,
          `Clear usage history for ${accountDisplayName(insightsAccount, language)}?`,
        ),
      )
    ) {
      return;
    }
    setUsageHistory((current) =>
      clearUsageHistoryAccount(current, insightsAccountKey),
    );
    setToast(
      t(
        "이 계정의 로컬 사용 기록을 삭제했습니다.",
        "Local usage history for this account was cleared.",
      ),
    );
  };
  const insightsGraphPaint = insightsAccount
    ? getAccountGraphPaint(insightsAccount)
    : getProviderGraphPaint("Claude");
  const appUpdateCopy = updateStatusCopy(updateState, language);
  const lastUpdateCheck = formatObservationTime(
    updateState.checkedAt,
    language,
  );
  const updateIsBusy =
    updateActionBusy !== null ||
    ["checking", "available", "downloading"].includes(updateState.status);

  return (
    <div
      className={[
        "desktop-app",
        settingsWindowMode ? "desktop-app--settings-window" : "",
        !settingsWindowMode && transparencyMode === "background-only"
          ? "desktop-app--transparency-background"
          : "",
        `desktop-app--${viewMode}`,
        `desktop-app--view-${activeView}`,
        `desktop-app--layout-${layoutMode}`,
        `desktop-app--cards-${cardSurfaceMode}`,
        `desktop-app--profile-${profilePosition}`,
        minimal ? "desktop-app--minimal" : "",
        minimal ? `desktop-app--minimal-${minimalOrientation}` : "",
        compact ? "desktop-app--compact" : "",
        usageOnly ? "desktop-app--usage-only" : "",
        quotaOnly ? "desktop-app--quota-only" : "",
        !showCardProfile ? "desktop-app--card-profile-hidden" : "",
        !showCardName ? "desktop-app--card-name-hidden" : "",
        !showCardPlan ? "desktop-app--card-plan-hidden" : "",
        !showCardEdit ? "desktop-app--card-edit-hidden" : "",
        layoutEditing ? "desktop-app--layout-editing" : "",
        draggedAccountId ? "desktop-app--card-dragging" : "",
        effectiveTitlebarAutoHide ? "desktop-app--titlebar-auto-hide" : "",
        effectiveTitlebarAutoHide && titlebarHidden
          ? "desktop-app--titlebar-hidden"
          : "",
        petMotion ? "desktop-app--pet-motion" : "",
        syncing ? "desktop-app--working" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={dashboardFontVariables}
      onPointerMoveCapture={wakeWidgetChromeFromPointer}
      onPointerDownCapture={wakeWidgetChrome}
      onWheelCapture={wakeWidgetChrome}
      onFocusCapture={wakeWidgetChrome}
      onKeyDownCapture={wakeWidgetChrome}
    >
      <header
        className="titlebar"
        ref={titlebarRef}
        onPointerEnter={() => {
          if (draggedAccountIdRef.current) return;
          titlebarHovered.current = true;
          revealTitlebar();
        }}
        onPointerLeave={() => {
          if (draggedAccountIdRef.current) return;
          titlebarHovered.current = false;
          const focusedElement = document.activeElement;
          if (
            focusedElement instanceof HTMLElement &&
            titlebarRef.current?.contains(focusedElement) &&
            !focusedElement.matches(":focus-visible")
          ) {
            focusedElement.blur();
          }
          scheduleTitlebarHide(minimal ? 1200 : TITLEBAR_HIDE_DELAY);
        }}
        onFocusCapture={revealTitlebar}
        onBlurCapture={() => {
          window.setTimeout(() => scheduleTitlebarHide(), 0);
        }}
      >
        <div className="titlebar__brand">
          <img
            className={`titlebar__mascot titlebar__mascot--${mascotAction}`}
            src={TOKENCAT_PET}
            alt={t(
              "토큰을 먹는 TokenCat 고양이 펫",
              "TokenCat token-eating cat companion",
            )}
            data-action={mascotAction}
            draggable={false}
          />
          <strong>TokenCat</strong>
        </div>
        <div className="window-actions">
          <button
            type="button"
            className={pinned ? "is-active" : ""}
            title={t("항상 위에 표시", "Always on top")}
            aria-label={t("항상 위에 표시", "Always on top")}
            aria-pressed={pinned}
            onClick={togglePinned}
          >
            <svg
              className="pin-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M9 3.5h6" />
              <path d="M9.8 3.5v4.2L7 11v1.7h10V11l-2.8-3.3V3.5" />
              <path d="M12 12.7v7.8" />
            </svg>
          </button>
          <button
            type="button"
            className={`minimal-titlebar-button${
              minimal ? " is-active" : ""
            }`}
            title={t(
              minimal ? "미니멀 모드 종료" : "미니멀 모드",
              minimal ? "Exit minimal mode" : "Minimal mode",
            )}
            aria-label={t(
              minimal ? "미니멀 모드 종료" : "미니멀 모드",
              minimal ? "Exit minimal mode" : "Minimal mode",
            )}
            aria-pressed={minimal}
            onClick={(event) => {
              event.currentTarget.blur();
              changeMinimal(!minimal);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3.5" y="7" width="17" height="10" rx="2" />
              <path d="M7 12h4" />
              <path d="M15 12h2" />
            </svg>
          </button>
          {minimal && (
            <button
              type="button"
              className="minimal-orientation-button"
              title={t(
                `미니멀 배치 변경: ${
                  nextMinimalOrientation(minimalOrientation) === "horizontal"
                    ? "가로"
                    : nextMinimalOrientation(minimalOrientation) === "medium"
                      ? "중간"
                      : "세로"
                }`,
                `Change minimal layout: ${
                  nextMinimalOrientation(minimalOrientation) === "horizontal"
                    ? "horizontal"
                    : nextMinimalOrientation(minimalOrientation) === "medium"
                      ? "medium"
                      : "vertical"
                }`,
              )}
              aria-label={t(
                `미니멀 배치를 ${
                  nextMinimalOrientation(minimalOrientation) === "horizontal"
                    ? "가로"
                    : nextMinimalOrientation(minimalOrientation) === "medium"
                      ? "중간"
                      : "세로"
                }형으로 변경`,
                `Change minimal layout to ${nextMinimalOrientation(
                  minimalOrientation,
                )}`,
              )}
              onClick={(event) => {
                event.currentTarget.blur();
                changeMinimal(
                  true,
                  nextMinimalOrientation(minimalOrientation),
                );
                scheduleTitlebarHide(1800);
              }}
            >
              <span aria-hidden="true">
                {minimalOrientation === "horizontal"
                  ? "↔"
                  : minimalOrientation === "medium"
                    ? "▦"
                    : "↕"}
              </span>
            </button>
          )}
          {!minimal && (
            <button
              type="button"
              className={`view-titlebar-button${
                activeView === "insights" ? " is-active" : ""
              }`}
              title={
                activeView === "usage"
                  ? t("사용 분석 열기", "Open usage insights")
                  : t("사용량으로 돌아가기", "Back to usage")
              }
              aria-label={
                activeView === "usage"
                  ? t("사용 분석 열기", "Open usage insights")
                  : t("사용량으로 돌아가기", "Back to usage")
              }
              aria-pressed={activeView === "insights"}
              onClick={() =>
                changeAppView(
                  activeView === "usage" ? "insights" : "usage",
                )
              }
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M5 19V11" />
                <path d="M12 19V5" />
                <path d="M19 19V8" />
              </svg>
            </button>
          )}
          {!minimal && activeView === "usage" && (
            <button
              type="button"
              className={`layout-titlebar-button${
                layoutEditing ? " is-active" : ""
              }`}
              title={t("배치 편집", "Edit layout")}
              aria-label={t("배치 편집", "Edit layout")}
              aria-pressed={layoutEditing}
              onClick={() => changeLayoutEditing(!layoutEditing)}
            >
              <span aria-hidden="true">{layoutEditing ? "✓" : "▦"}</span>
            </button>
          )}
          {!minimal && (
            <button
              type="button"
              className={compact ? "is-active" : ""}
              title={t("컴팩트 모드", "Compact mode")}
              aria-label={t("컴팩트 모드", "Compact mode")}
              onClick={(event) => {
                event.currentTarget.blur();
                changeCompact(!compact);
                scheduleTitlebarHide(1200);
              }}
            >
              <span aria-hidden="true">{compact ? "▣" : "▤"}</span>
            </button>
          )}
          <button
            type="button"
            title={t("최소화", "Minimize")}
            aria-label={t("최소화", "Minimize")}
            onClick={() => window.tokenCat?.minimize()}
          >
            <span aria-hidden="true">—</span>
          </button>
          {!minimal && (
            <button
              type="button"
              disabled={windowSizeState.sizeLocked}
              title={
                windowSizeState.sizeLocked
                  ? t("창 크기 고정됨", "Window size locked")
                  : maximized
                  ? t("이전 크기로 복원", "Restore")
                  : t("최대화", "Maximize")
              }
              aria-label={
                windowSizeState.sizeLocked
                  ? t("창 크기 고정됨", "Window size locked")
                  : maximized
                  ? t("이전 크기로 복원", "Restore")
                  : t("최대화", "Maximize")
              }
              onClick={toggleMaximized}
            >
              <span aria-hidden="true">{maximized ? "❐" : "□"}</span>
            </button>
          )}
          <button
            type="button"
            className="window-close"
            title={t("트레이로 숨기기", "Hide to tray")}
            aria-label={t("트레이로 숨기기", "Hide to tray")}
            onClick={() => window.tokenCat?.hide()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      {minimal ? (
        <MinimalUsageStrip
          accounts={accounts}
          language={language}
          orientation={minimalOrientation}
          graphMode={minimalGraphMode}
          providerIcons={providerIcons}
          petMotion={petMotion}
          syncing={syncing}
          getGraphPaint={getAccountGraphPaint}
          getPercentageColors={getAccountPercentageColors}
          getPercentageGraphEnabled={getAccountPercentageGraphEnabled}
          chromeVisible={minimalChromeVisible}
          onRevealTitlebar={() => {
            setMinimalChromeVisible(true);
            scheduleMinimalChromeHide();
            revealTitlebar();
            scheduleTitlebarHide(2200);
          }}
        />
      ) : (
      <main className="dashboard-scroll">
        {activeView === "usage" ? (
        <div
          id="app-view-panel-usage"
          className="dashboard"
          role="tabpanel"
          aria-labelledby="app-view-tab-usage"
        >
          <section className="page-header">
            <div className="page-header__copy">
              <AppViewTabs
                activeView={activeView}
                language={language}
                onChange={changeAppView}
              />
              <p className="usage-secondary">
                {t(
                  `${accounts.length}개 계정 · ${quotaSummary.total}개 한도`,
                  `${accounts.length} accounts · ${quotaSummary.total} limits`,
                )}
                {quotaSummary.warning > 0 &&
                  t(
                    ` · 주의 ${quotaSummary.warning}`,
                    ` · ${quotaSummary.warning} warnings`,
                  )}
              </p>
            </div>
            <div className="page-actions">
              <button
                type="button"
                className={syncing ? "is-syncing" : ""}
                onClick={refresh}
                title={t(
                  `마지막 동기화 ${lastSyncDisplay}`,
                  `Last synced ${lastSyncDisplay}`,
                )}
                aria-label={t("사용량 새로고침", "Refresh usage")}
              >
                <span aria-hidden="true">↻</span>
              </button>
              <button
                type="button"
                onClick={() => openAddPanel()}
                title={t("계정 추가", "Add account")}
                aria-label={t("계정 추가", "Add account")}
              >
                <span aria-hidden="true">＋</span>
              </button>
              <button
                type="button"
                className={layoutEditing ? "is-active" : ""}
                onClick={() => changeLayoutEditing(!layoutEditing)}
                title={t("배치 편집", "Edit layout")}
                aria-label={t("배치 편집", "Edit layout")}
                aria-pressed={layoutEditing}
              >
                <span aria-hidden="true">{layoutEditing ? "✓" : "▦"}</span>
              </button>
              <button
                type="button"
                onClick={() => openSettingsPanel()}
                title={t("설정", "Settings")}
                aria-label={t("설정", "Settings")}
              >
                <span aria-hidden="true">•••</span>
              </button>
            </div>
          </section>

          {layoutEditing && (
            <section
              className="layout-editor"
              aria-label={t("대시보드 배치 편집", "Dashboard layout editor")}
            >
              <div className="layout-editor__copy">
                <strong>{t("배치 편집", "Edit layout")}</strong>
                <span id="layout-editor-instructions">
                  {activeGridCapacity
                    ? t(
                        "카드를 끌어 왼쪽→오른쪽, 위→아래 셀 순서를 바꾸세요",
                        "Drag cards to reorder cells left to right, then top to bottom",
                      )
                    : t(
                        "카드의 핸들을 끌거나 화살표로 순서를 바꾸세요",
                        "Drag a card handle or use its arrows to reorder",
                      )}
                </span>
              </div>
              <div className="layout-editor__actions">
                <div
                  className="layout-axis-switch"
                  role="group"
                  aria-label={t("카드 배치 방식", "Card layout")}
                >
                  <button
                    type="button"
                    className={layoutMode === "vertical" ? "is-active" : ""}
                    onClick={() => setLayoutMode("vertical")}
                    aria-pressed={layoutMode === "vertical"}
                  >
                    <span aria-hidden="true">☰</span>
                    {t("세로", "Vertical")}
                  </button>
                  <button
                    type="button"
                    className={layoutMode === "horizontal" ? "is-active" : ""}
                    onClick={() => setLayoutMode("horizontal")}
                    aria-pressed={layoutMode === "horizontal"}
                  >
                    <span aria-hidden="true">▥</span>
                    {t("가로", "Horizontal")}
                  </button>
                  <button
                    type="button"
                    className={layoutMode === "grid-2x2" ? "is-active" : ""}
                    onClick={() => setLayoutMode("grid-2x2")}
                    aria-pressed={layoutMode === "grid-2x2"}
                  >
                    <span aria-hidden="true">⊞</span>
                    2×2
                  </button>
                  <button
                    type="button"
                    className={layoutMode === "grid-3x3" ? "is-active" : ""}
                    onClick={() => setLayoutMode("grid-3x3")}
                    aria-pressed={layoutMode === "grid-3x3"}
                  >
                    <span aria-hidden="true">▦</span>
                    3×3
                  </button>
                </div>
                <button
                  type="button"
                  className="layout-editor__done"
                  onClick={() => changeLayoutEditing(false)}
                >
                  {t("완료", "Done")}
                </button>
              </div>
            </section>
          )}

          <div
            className="filter-tabs"
            aria-label={t("AI 서비스 필터", "AI service filter")}
          >
            {(["all", "Claude", "Codex"] as Filter[]).map((item) => (
              <button
                key={item}
                type="button"
                className={filter === item ? "is-active" : ""}
                onClick={() => setFilter(item)}
                disabled={layoutEditing}
                aria-pressed={filter === item}
              >
                {item === "all" ? t("전체", "All") : item}
                <span>
                  {item === "all"
                    ? accounts.length
                    : accounts.filter((account) => account.provider === item)
                        .length}
                </span>
              </button>
            ))}
          </div>

          <section
            className="account-list"
            aria-label={t("계정 사용량 카드", "Account usage cards")}
            role="list"
            tabIndex={layoutMode === "horizontal" ? 0 : undefined}
          >
            {visibleAccounts.map((account, visibleIndex) => {
              const quotas = visibleQuotas(account, language);
              const graphPaint = getAccountGraphPaint(account);
              const percentageColors =
                getAccountPercentageColors(account);
              const percentageGraphEnabled =
                getAccountPercentageGraphEnabled(account);
              const displayName = accountDisplayName(account, language);
              const managedId = managedAccountIdFromConnection(
                account.connectionId,
              );
              const contextTokens =
                tokenDisplayMode !== "hidden" &&
                account.provider === "Claude" &&
                account.contextTokens
                  ? account.contextTokens
                  : null;
              const tokenInHeader = Boolean(showCardName || showCardPlan);
              return (
                <article
                  className={[
                    "account-card",
                    headerless ? "account-card--headerless" : "",
                    draggedAccountId === account.id
                      ? "account-card--dragging"
                      : "",
                    dropTarget?.accountId === account.id
                      ? `account-card--drop-${dropTarget.position}`
                      : "",
                    contextTokens && !tokenInHeader
                      ? "account-card--has-context-tokens"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={account.id}
                  role="listitem"
                  aria-posinset={visibleIndex + 1}
                  aria-setsize={visibleAccounts.length}
                  aria-label={t(
                    `${displayName} ${account.provider} 사용량`,
                    `${displayName} ${account.provider} usage`,
                  )}
                  style={
                    {
                      "--provider-accent": graphPaint.start,
                      "--provider-gradient":
                        graphPaintBackground(graphPaint),
                    } as CSSProperties
                  }
                  onDragOver={(event) => dragAccountOver(event, account.id)}
                  onDrop={(event) => dropAccount(event, account.id)}
                >
                  {layoutEditing && (
                    <div
                      className="account-card__layout-controls"
                      aria-label={t(
                        `${displayName} 카드 배치`,
                        `${displayName} card placement`,
                      )}
                    >
                      {activeGridCapacity && (
                        <span
                          className="account-card__slot"
                          title={t(
                            `${visibleIndex + 1}번 배치 순서`,
                            `Position ${visibleIndex + 1}`,
                          )}
                        >
                          {visibleIndex + 1}
                        </span>
                      )}
                      <button
                        type="button"
                        className="account-card__drag-handle"
                        draggable
                        onDragStart={(event) =>
                          startAccountDrag(event, account.id)
                        }
                        onDragEnd={finishAccountDrag}
                        aria-label={t(
                          `${displayName} 카드 끌어서 이동`,
                          `Drag to move ${displayName}`,
                        )}
                        aria-describedby="layout-editor-instructions"
                        title={t("끌어서 이동", "Drag to move")}
                      >
                        <span aria-hidden="true">⠿</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveAccount(account.id, -1)}
                        disabled={visibleIndex === 0}
                        aria-label={t(
                          `${displayName} 이전 위치로 이동`,
                          `Move ${displayName} backward`,
                        )}
                        title={t("이전 위치", "Move backward")}
                      >
                        <span aria-hidden="true">
                          {usesHorizontalSequence(
                            layoutMode,
                            gridSingleColumn,
                          )
                            ? "←"
                            : "↑"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveAccount(account.id, 1)}
                        disabled={visibleIndex === visibleAccounts.length - 1}
                        aria-label={t(
                          `${displayName} 다음 위치로 이동`,
                          `Move ${displayName} forward`,
                        )}
                        title={t("다음 위치", "Move forward")}
                      >
                        <span aria-hidden="true">
                          {usesHorizontalSequence(
                            layoutMode,
                            gridSingleColumn,
                          )
                            ? "→"
                            : "↓"}
                        </span>
                      </button>
                    </div>
                  )}
                  {showCardEdit && (
                    <button
                      type="button"
                      className="account-card__edit"
                      onClick={() => setEditingId(account.id)}
                      aria-label={t(
                        `${displayName} 편집`,
                        `Edit ${displayName}`,
                      )}
                    >
                      {t("편집", "Edit")}
                    </button>
                  )}
                  {cardHeaderVisible && (
                    <div
                      className={[
                        "account-profile",
                        showCardProfile && !showCardName && !showCardPlan
                          ? "account-profile--profile-only"
                          : "",
                        !showCardProfile
                          ? "account-profile--without-profile"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {showCardProfile && (
                        <PetAvatar
                          provider={account.provider}
                          accountMode={account.iconMode}
                          providerIcons={providerIcons}
                          customIcon={account.customIcon}
                          size="large"
                          motion={petMotion}
                          working={syncing}
                          usage={highestVisibleUsage(account)}
                          language={language}
                        />
                      )}
                      {(showCardName || showCardPlan) && (
                        <div className="account-identity">
                          {showCardName && <h2>{displayName}</h2>}
                          {showCardPlan && (
                            <span className="account-plan">
                              {account.provider} · {account.plan}
                            </span>
                          )}
                          {(showCardName || showCardPlan) &&
                            account.origin === "live" && (
                              <span
                                className={`usage-secondary live-account-status${
                                  account.syncState === "stale"
                                    ? " live-account-status--stale"
                                    : ""
                                }`}
                              >
                                <i aria-hidden="true" />
                                {account.syncState === "waiting"
                                  ? t("활동 대기", "Waiting")
                                  : account.syncState === "error"
                                    ? t("확인 필요", "Check")
                                    : account.syncState === "stale"
                                      ? t(
                                          "최근 동기화 값",
                                          "Recent value",
                                        )
                                      : t("실시간 연동", "Live")}
                              </span>
                            )}
                          {contextTokens && tokenInHeader && (
                            <ContextTokenUsage
                              tokens={contextTokens}
                              mode={
                                tokenDisplayMode === "detail"
                                  ? "detail"
                                  : "total"
                              }
                              language={language}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {account.origin === "live" &&
                  account.syncState === "waiting" ? (
                    <div className="live-account-message">
                      <strong>
                        {t("사용량 수집 대기 중", "Waiting for usage data")}
                      </strong>
                      <span>
                        {managedId && account.provider === "Claude"
                          ? t(
                              "공식 사용량을 다시 확인하는 중입니다. 다른 계정의 컨텍스트 토큰은 설정에서 해당 계정으로 Claude를 열어 사용해 주세요.",
                              "Retrying official usage. For a different account's context tokens, open Claude for that account from Settings.",
                            )
                          : account.provider === "Claude"
                          ? t(
                              "공식 Claude 계정 사용량을 자동으로 다시 확인합니다.",
                              "Official Claude account usage will retry automatically.",
                            )
                          : t(
                              "Codex에서 한도를 확인한 뒤 자동 갱신됩니다.",
                              "It updates after Codex checks your limits.",
                            )}
                      </span>
                    </div>
                  ) : account.origin === "live" &&
                    account.syncState === "error" ? (
                    <div className="live-account-message live-account-message--error">
                      <strong>
                        {t("연동 확인 필요", "Connection needs attention")}
                      </strong>
                      <span>
                        {t(
                          "설정에서 연결 상태를 다시 확인해 주세요.",
                          "Check the connection again in Settings.",
                        )}
                      </span>
                    </div>
                  ) : quotas.length > 0 ? (
                    <div className="account-stats">
                      {viewMode === "rings"
                        ? quotas.map(({ key, label, quota }) => (
                            <QuotaRing
                              key={key}
                              label={label}
                              quota={quota}
                              paint={graphPaintForQuota(
                                graphPaint,
                                percentageColors,
                                quota.used,
                                percentageGraphEnabled,
                              )}
                              percentageColors={percentageColors}
                              gradientId={`quota-gradient-${account.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${key}`}
                              language={language}
                            />
                          ))
                        : quotas.map(({ key, label, quota }) => (
                            <QuotaBar
                              key={key}
                              label={label}
                              quota={quota}
                              paint={graphPaintForQuota(
                                graphPaint,
                                percentageColors,
                                quota.used,
                                percentageGraphEnabled,
                              )}
                              percentageColors={percentageColors}
                              language={language}
                            />
                          ))}
                    </div>
                  ) : (
                    <button
                      className="no-quota"
                      type="button"
                      onClick={() => setEditingId(account.id)}
                    >
                      {t("표시할 한도 선택", "Choose visible limits")}
                    </button>
                  )}
                  {contextTokens && !tokenInHeader && (
                    <ContextTokenUsage
                      tokens={contextTokens}
                      mode={
                        tokenDisplayMode === "detail" ? "detail" : "total"
                      }
                      language={language}
                    />
                  )}
                </article>
              );
            })}
            {!visibleAccounts.length && (
              <div className="empty-state">
                <strong>
                  {t("표시할 계정이 없습니다.", "No accounts to show.")}
                </strong>
                <span>
                  {t(
                    "실제 Claude 또는 Codex 계정을 연결하면 사용량이 여기에 표시됩니다.",
                    "Connect a real Claude or Codex account to see usage here.",
                  )}
                </span>
                <div className="empty-state__actions">
                  <button type="button" onClick={() => openAddPanel()}>
                    {t("계정 추가", "Add account")}
                  </button>
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={() =>
                      void window.tokenCat?.openOnboarding?.({
                        firstRun: false,
                      })
                    }
                  >
                    {t("시작 가이드", "Getting started")}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
        ) : (
          <div className="analytics-page">
            <section className="page-header">
              <div className="page-header__copy">
                <AppViewTabs
                  activeView={activeView}
                  language={language}
                  onChange={changeAppView}
                />
                <p>
                  {t(
                    "시간대별 사용 습관과 현재 플랜의 적합도를 확인합니다",
                    "Review hourly usage patterns and plan suitability",
                  )}
                </p>
              </div>
              <div className="page-actions">
                <button
                  type="button"
                  className={syncing ? "is-syncing" : ""}
                  onClick={refresh}
                  title={t(
                    `마지막 동기화 ${lastSyncDisplay}`,
                    `Last synced ${lastSyncDisplay}`,
                  )}
                  aria-label={t("사용량 새로고침", "Refresh usage")}
                >
                  <span aria-hidden="true">↻</span>
                </button>
                <button
                  type="button"
                  onClick={() => openSettingsPanel()}
                  title={t("설정", "Settings")}
                  aria-label={t("설정", "Settings")}
                >
                  <span aria-hidden="true">•••</span>
                </button>
              </div>
            </section>
            <UsageInsightsView
              accounts={insightsAccounts}
              selectedAccountId={insightsAccountId}
              selectedAccount={insightsAccount}
              insights={usageInsights}
              daily={dailyHourlyUsage}
              selectedDate={insightsDayKey}
              todayDate={insightsTodayKey}
              earliestDate={shiftDayKey(insightsTodayKey, -83)}
              accent={insightsGraphPaint.start}
              gradient={graphPaintBackground(insightsGraphPaint)}
              language={language}
              onSelectAccount={setInsightsAccountId}
              onSelectDate={setInsightsDayKey}
              onClear={clearSelectedUsageHistory}
            />
          </div>
        )}
      </main>
      )}

      {settingsOpen && (
        <div
          className={
            settingsWindowMode
              ? "overlay overlay--settings-window"
              : "overlay"
          }
          onMouseDown={
            settingsWindowMode ? undefined : closeSettingsPanel
          }
        >
          <section
            className={`panel settings-panel settings-panel--${settingsCategory}`}
            ref={settingsPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="panel-heading">
              <div>
                <span>SETTINGS</span>
                <h2 id="settings-title">{t("설정", "Settings")}</h2>
              </div>
              <button
                type="button"
                onClick={closeSettingsPanel}
                aria-label={t("닫기", "Close")}
              >
                ×
              </button>
            </header>

            <nav
              className="settings-categories"
              role="tablist"
              aria-label={t("설정 카테고리", "Settings categories")}
            >
              {(
                [
                  ["general", t("일반", "General")],
                  ["dashboard", t("대시보드", "Dashboard")],
                  ["accounts", t("계정", "Accounts")],
                  ["appearance", t("디자인", "Appearance")],
                ] as Array<[SettingsCategory, string]>
              ).map(([category, label]) => (
                <button
                  id={`settings-tab-${category}`}
                  type="button"
                  role="tab"
                  aria-selected={settingsCategory === category}
                  aria-controls="settings-category-content"
                  tabIndex={settingsCategory === category ? 0 : -1}
                  className={
                    settingsCategory === category ? "is-active" : ""
                  }
                  onClick={() => {
                    setSettingsCategory(category);
                    if (settingsPanelRef.current) {
                      settingsPanelRef.current.scrollTop = 0;
                    }
                  }}
                  onKeyDown={(event) => {
                    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                    if (!keys.includes(event.key)) return;
                    event.preventDefault();
                    const categories: SettingsCategory[] = [
                      "general",
                      "dashboard",
                      "accounts",
                      "appearance",
                    ];
                    const currentIndex = categories.indexOf(category);
                    const nextIndex =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? categories.length - 1
                          : (currentIndex +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              categories.length) %
                            categories.length;
                    const nextCategory = categories[nextIndex];
                    setSettingsCategory(nextCategory);
                    settingsPanelRef.current?.scrollTo({ top: 0 });
                    window.requestAnimationFrame(() =>
                      document
                        .getElementById(`settings-tab-${nextCategory}`)
                        ?.focus(),
                    );
                  }}
                  key={category}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div
              id="settings-category-content"
              className="settings-category-content"
              role="tabpanel"
              aria-labelledby={`settings-tab-${settingsCategory}`}
            >
            <div className="settings-section settings-section--first settings-category settings-category--general">
              <div className="settings-section__heading">
                <strong>{t("언어", "Language")}</strong>
                <span>
                  {t(
                    "앱 표시 언어를 선택합니다",
                    "Choose the app display language",
                  )}
                </span>
              </div>
              <div
                className="segmented-control language-control"
                aria-label={t("언어 선택", "Language selection")}
              >
                <button
                  type="button"
                  className={language === "ko" ? "is-active" : ""}
                  onClick={() => setLanguage("ko")}
                  aria-pressed={language === "ko"}
                >
                  한국어
                </button>
                <button
                  type="button"
                  className={language === "en" ? "is-active" : ""}
                  onClick={() => setLanguage("en")}
                  aria-pressed={language === "en"}
                >
                  English
                </button>
              </div>
            </div>

            <div className="settings-section getting-started-settings settings-category settings-category--general">
              <div className="settings-section__heading">
                <strong>{t("시작 가이드", "Getting started")}</strong>
                <span>
                  {t(
                    "계정 연결과 기본 사용법을 다시 확인합니다",
                    "Review account connection and the basics",
                  )}
                </span>
              </div>
              <div className="getting-started-card">
                <img src={TOKENCAT_PET} alt="" draggable={false} />
                <div>
                  <strong>
                    {t(
                      "처음부터 차근차근 보기",
                      "Walk through TokenCat again",
                    )}
                  </strong>
                  <small>
                    {t(
                      "별도 창에서 열리므로 현재 위젯 크기와 배치는 바뀌지 않습니다.",
                      "It opens separately, so your current widget size and layout stay unchanged.",
                    )}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void window.tokenCat?.openOnboarding?.({
                      firstRun: false,
                    })
                  }
                >
                  {t("가이드 열기", "Open guide")}
                </button>
              </div>
            </div>

            <div className="settings-section app-update-settings settings-category settings-category--general">
              <div className="settings-section__heading">
                <strong>{t("자동 업데이트", "Automatic updates")}</strong>
                <span>
                  {t(
                    "GitHub Releases에서 안전하게 받습니다",
                    "Delivered securely through GitHub Releases",
                  )}
                </span>
              </div>
              <div
                className={`app-update-card app-update-card--${updateState.status}`}
                aria-live="polite"
              >
                <div className="app-update-card__status">
                  <i aria-hidden="true" />
                  <div>
                    <strong>{appUpdateCopy.title}</strong>
                    <small>{appUpdateCopy.detail}</small>
                  </div>
                </div>
                <div className="app-update-card__meta">
                  <span>
                    {t("현재", "Current")} v{updateState.currentVersion}
                  </span>
                  {updateState.availableVersion && (
                    <span>
                      {t("새 버전", "Available")} v
                      {updateState.availableVersion}
                    </span>
                  )}
                  {lastUpdateCheck && (
                    <span>
                      {t("마지막 확인", "Last checked")} {lastUpdateCheck}
                    </span>
                  )}
                </div>
                {updateState.status === "downloading" &&
                  updateState.progressPercent !== null && (
                    <div className="app-update-progress">
                      <span
                        style={{
                          width: `${Math.max(
                            0,
                            Math.min(100, updateState.progressPercent),
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                <div className="app-update-card__actions">
                  {updateState.supported ? (
                    updateState.status === "ready" ? (
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() => void runUpdateAction("install")}
                        disabled={updateActionBusy !== null}
                      >
                        {updateActionBusy === "install"
                          ? t("재시작 중…", "Restarting…")
                          : t(
                              "재시작하여 업데이트",
                              "Restart and update",
                            )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void runUpdateAction("check")}
                        disabled={updateIsBusy}
                      >
                        {updateState.status === "downloading" ||
                        updateState.status === "available"
                          ? t("자동 다운로드 중…", "Downloading automatically…")
                          : updateState.status === "checking" ||
                              updateActionBusy === "check"
                            ? t("확인 중…", "Checking…")
                            : t("지금 확인", "Check now")}
                      </button>
                    )
                  ) : updateState.distribution === "portable" ? (
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => void runUpdateAction("download-page")}
                      disabled={updateActionBusy !== null}
                    >
                      {updateActionBusy === "download-page"
                        ? t("여는 중…", "Opening…")
                        : t(
                            "자동 업데이트 설치형 받기",
                            "Get the auto-updating installer",
                          )}
                    </button>
                  ) : (
                    <button type="button" disabled>
                      {t("배포 버전에서 사용", "Available in release builds")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="settings-section settings-category settings-category--dashboard settings-category--first">
              <div className="settings-section__heading">
                <strong>{t("통계 보기", "Chart style")}</strong>
                <span>
                  {t("기본 화면의 표시 방식", "How usage is displayed")}
                </span>
              </div>
              <div
                className="view-mode-options"
                aria-label={t("통계 보기 방식", "Chart style")}
              >
                <button
                  type="button"
                  className={viewMode === "rings" ? "is-active" : ""}
                  onClick={() => setViewMode("rings")}
                  aria-pressed={viewMode === "rings"}
                >
                  <i className="view-preview view-preview--rings">
                    <b />
                    <b />
                  </i>
                  <span>
                    <strong>{t("원형", "Rings")}</strong>
                    <small>{t("오른쪽에 나란히", "Side by side")}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={viewMode === "bars" ? "is-active" : ""}
                  onClick={() => setViewMode("bars")}
                  aria-pressed={viewMode === "bars"}
                >
                  <i className="view-preview view-preview--bars">
                    <b />
                    <b />
                  </i>
                  <span>
                    <strong>{t("막대", "Bars")}</strong>
                    <small>{t("숫자와 진행률", "Value and progress")}</small>
                  </span>
                </button>
              </div>
            </div>

            <div className="settings-section settings-category settings-category--dashboard">
              <div className="settings-section__heading">
                <strong>{t("계정 카드 배치", "Card layout")}</strong>
                <span>
                  {t(
                    "한 줄 또는 2×2·3×3 셀로 배치합니다",
                    "Arrange cards in a row or 2×2 and 3×3 cells",
                  )}
                </span>
              </div>
              <div
                className="view-mode-options"
                aria-label={t("계정 카드 배치", "Card layout")}
              >
                <button
                  type="button"
                  className={layoutMode === "vertical" ? "is-active" : ""}
                  onClick={() => setLayoutMode("vertical")}
                  aria-pressed={layoutMode === "vertical"}
                >
                  <i className="view-preview layout-preview layout-preview--vertical">
                    <b />
                    <b />
                    <b />
                  </i>
                  <span>
                    <strong>{t("세로 목록", "Vertical list")}</strong>
                    <small>{t("위에서 아래로", "Top to bottom")}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={layoutMode === "horizontal" ? "is-active" : ""}
                  onClick={() => setLayoutMode("horizontal")}
                  aria-pressed={layoutMode === "horizontal"}
                >
                  <i className="view-preview layout-preview layout-preview--horizontal">
                    <b />
                    <b />
                    <b />
                  </i>
                  <span>
                    <strong>{t("가로 한 줄", "Horizontal row")}</strong>
                    <small>
                      {t("왼쪽에서 오른쪽으로", "Left to right")}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className={layoutMode === "grid-2x2" ? "is-active" : ""}
                  onClick={() => setLayoutMode("grid-2x2")}
                  aria-pressed={layoutMode === "grid-2x2"}
                >
                  <i className="view-preview layout-preview layout-preview--grid-2x2">
                    {Array.from({ length: 4 }, (_, index) => (
                      <b key={index} />
                    ))}
                  </i>
                  <span>
                    <strong>{t("2×2 그리드", "2×2 grid")}</strong>
                    <small>{t("기본 창 4칸", "4 cells at default size")}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={layoutMode === "grid-3x3" ? "is-active" : ""}
                  onClick={() => setLayoutMode("grid-3x3")}
                  aria-pressed={layoutMode === "grid-3x3"}
                >
                  <i className="view-preview layout-preview layout-preview--grid-3x3">
                    {Array.from({ length: 9 }, (_, index) => (
                      <b key={index} />
                    ))}
                  </i>
                  <span>
                    <strong>{t("3×3 그리드", "3×3 grid")}</strong>
                    <small>{t("기본 창 9칸", "9 cells at default size")}</small>
                  </span>
                </button>
              </div>
            </div>

            <div className="settings-section settings-category settings-category--dashboard">
              <div className="settings-section__heading">
                <strong>{t("카드 묶음", "Card grouping")}</strong>
                <span>
                  {t(
                    "계정을 분리하거나 하나의 패널로 밀착합니다",
                    "Keep accounts separate or join them into one dense panel",
                  )}
                </span>
              </div>
              <div
                className="view-mode-options panel-style-options"
                role="group"
                aria-label={t("카드 묶음", "Card grouping")}
              >
                <button
                  type="button"
                  className={
                    cardSurfaceMode === "separate" ? "is-active" : ""
                  }
                  onClick={() => setCardSurfaceMode("separate")}
                  aria-pressed={cardSurfaceMode === "separate"}
                >
                  <i className="view-preview surface-preview surface-preview--separate">
                    <b />
                    <b />
                    <b />
                  </i>
                  <span>
                    <strong>{t("분리 카드", "Separate cards")}</strong>
                    <small>{t("카드마다 여백과 그림자", "Individual spacing")}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={
                    cardSurfaceMode === "unified" ? "is-active" : ""
                  }
                  onClick={() => setCardSurfaceMode("unified")}
                  aria-pressed={cardSurfaceMode === "unified"}
                >
                  <i className="view-preview surface-preview surface-preview--unified">
                    <b />
                    <b />
                    <b />
                  </i>
                  <span>
                    <strong>{t("통합 패널", "Unified panel")}</strong>
                    <small>{t("구분선만 남겨 밀착", "Dense with dividers")}</small>
                  </span>
                </button>
              </div>
            </div>

            <div className="settings-section profile-layout-settings settings-category settings-category--dashboard">
              <div className="settings-section__heading">
                <strong>{t("프로필 위치", "Profile position")}</strong>
                <span>
                  {t(
                    "계정 이름을 기준으로 프로필을 배치합니다",
                    "Place the profile relative to the account name",
                  )}
                </span>
              </div>
              <div
                className="profile-position-options"
                role="group"
                aria-label={t("프로필 위치", "Profile position")}
              >
                {(
                  [
                    ["left", t("왼쪽", "Left")],
                    ["right", t("오른쪽", "Right")],
                    ["top", t("위", "Top")],
                    ["bottom", t("아래", "Bottom")],
                  ] as Array<[ProfilePosition, string]>
                ).map(([position, label]) => (
                  <button
                    type="button"
                    className={profilePosition === position ? "is-active" : ""}
                    onClick={() => setProfilePosition(position)}
                    aria-pressed={profilePosition === position}
                    key={position}
                  >
                    <i
                      className={`profile-position-preview profile-position-preview--${position}`}
                      aria-hidden="true"
                    >
                      <b />
                      <span />
                    </i>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section size-settings settings-category settings-category--dashboard">
              <div className="settings-section__heading">
                <div>
                  <strong>{t("위젯 크기", "Widget sizing")}</strong>
                  <span>
                    {t(
                      "창·그래프·프로필·글자 크기를 각각 조절합니다",
                      "Adjust the window, graph, profile, and text sizes independently",
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="size-settings__reset"
                  onClick={() =>
                    setDisplayPreferences((current) => ({
                      ...DEFAULT_DISPLAY_PREFERENCES,
                      widgetScale: windowSizeState.sizeLocked
                        ? current.widgetScale
                        : DEFAULT_DISPLAY_PREFERENCES.widgetScale,
                    }))
                  }
                  disabled={(
                    Object.keys(DISPLAY_SCALE_LIMITS) as DisplayScaleKey[]
                  ).every(
                    (key) =>
                      (key === "widgetScale" &&
                        windowSizeState.sizeLocked) ||
                      displayPreferences[key] ===
                      DEFAULT_DISPLAY_PREFERENCES[key],
                  )}
                >
                  {t("기본값", "Reset")}
                </button>
              </div>
              <div className="size-control-list">
                <SizeRangeControl
                  id="auto-minimal-width"
                  label={t(
                    "중간 미니멀 전환 폭",
                    "Medium minimal width",
                  )}
                  description={t(
                    `이 값 이하는 중간형, ${VERTICAL_MINIMAL_ENTER_WIDTH}px 미만은 세로형으로 정렬합니다`,
                    `Uses medium at or below this width and vertical below ${VERTICAL_MINIMAL_ENTER_WIDTH}px`,
                  )}
                  value={autoMinimalWidth}
                  minimum={MIN_AUTO_MINIMAL_WIDTH}
                  maximum={MAX_AUTO_MINIMAL_WIDTH}
                  unit="px"
                  step={10}
                  disabled={!autoMinimal}
                  onChange={(value) =>
                    setAutoMinimalWidth(normalizeAutoMinimalWidth(value))
                  }
                />
                <SizeRangeControl
                  id="auto-minimal-height"
                  label={t(
                    "가로 미니멀 전환 높이",
                    "Horizontal minimal height",
                  )}
                  description={t(
                    "창 높이가 이 값 이하가 되면 계정을 가로로 정렬합니다",
                    "Places accounts horizontally at or below this height",
                  )}
                  value={autoMinimalHeight}
                  minimum={MIN_AUTO_MINIMAL_HEIGHT}
                  maximum={MAX_AUTO_MINIMAL_HEIGHT}
                  unit="px"
                  step={10}
                  disabled={!autoMinimal}
                  onChange={(value) =>
                    setAutoMinimalHeight(normalizeAutoMinimalHeight(value))
                  }
                />
                <SizeRangeControl
                  id="widget-scale"
                  label={t("전체 위젯", "Widget size")}
                  description={t(
                    "현재 배치를 유지하며 Windows 창 크기를 바꿉니다",
                    "Resizes the Windows widget while keeping the layout",
                  )}
                  value={widgetScale}
                  minimum={MIN_WIDGET_SCALE}
                  maximum={MAX_WIDGET_SCALE}
                  disabled={windowSizeState.sizeLocked}
                  onChange={(value) =>
                    changeDisplayScale("widgetScale", value)
                  }
                />
                <SizeRangeControl
                  id="graph-scale"
                  label={t("그래프 크기", "Graph size")}
                  description={t(
                    "원형 지름과 선 굵기·막대 두께",
                    "Ring diameter, stroke, and bar thickness",
                  )}
                  value={graphScale}
                  minimum={MIN_GRAPH_SCALE}
                  maximum={MAX_GRAPH_SCALE}
                  onChange={(value) =>
                    changeDisplayScale("graphScale", value)
                  }
                />
                <SizeRangeControl
                  id="profile-scale"
                  label={t("프로필 이미지", "Profile image")}
                  description={t(
                    "카드 안의 펫·사용자 이미지 크기",
                    "Size of the pet or custom image inside cards",
                  )}
                  value={profileScale}
                  minimum={MIN_PROFILE_SCALE}
                  maximum={MAX_PROFILE_SCALE}
                  onChange={(value) =>
                    changeDisplayScale("profileScale", value)
                  }
                />
                <SizeRangeControl
                  id="title-scale"
                  label={t("계정 제목", "Account title")}
                  description={t(
                    "계정 이름과 상단 제목 크기",
                    "Account names and dashboard heading",
                  )}
                  value={titleScale}
                  minimum={MIN_TITLE_SCALE}
                  maximum={MAX_TITLE_SCALE}
                  onChange={(value) =>
                    changeDisplayScale("titleScale", value)
                  }
                />
                <SizeRangeControl
                  id="percentage-scale"
                  label={t("사용량 퍼센트", "Usage percentage")}
                  description={t(
                    "원형·막대 안의 가장 중요한 숫자",
                    "Primary values inside rings and bars",
                  )}
                  value={percentageScale}
                  minimum={MIN_PERCENTAGE_SCALE}
                  maximum={MAX_PERCENTAGE_SCALE}
                  onChange={(value) =>
                    changeDisplayScale("percentageScale", value)
                  }
                />
                <SizeRangeControl
                  id="secondary-scale"
                  label={t("보조 설명", "Detail text")}
                  description={t(
                    "한도 이름·초기화 시간·상태, 최소 9pt",
                    "Limit labels, reset times, and status; minimum 9pt",
                  )}
                  value={secondaryScale}
                  minimum={MIN_SECONDARY_SCALE}
                  maximum={MAX_SECONDARY_SCALE}
                  onChange={(value) =>
                    changeDisplayScale("secondaryScale", value)
                  }
                />
              </div>
              <div className="window-size-tools">
                <div className="window-size-tools__copy">
                  <strong>
                    {windowSizeState.sizeLocked
                      ? t("창 크기 고정됨", "Window size locked")
                      : windowSizeState.hasSavedWindowSize
                        ? t("이 배치의 크기 저장됨", "Size saved for this layout")
                        : t("현재 배치 크기", "Current layout size")}
                  </strong>
                  <span>
                    {windowSizeState.currentWindowSize.width > 0
                      ? `${windowSizeState.currentWindowSize.width} × ${windowSizeState.currentWindowSize.height}px`
                      : t(
                          "Windows 앱에서 크기를 저장할 수 있습니다",
                          "Size controls are available in the Windows app",
                        )}
                    {windowSizeState.savedWindowSize
                      ? t(
                          ` · 저장 ${windowSizeState.savedWindowSize.width} × ${windowSizeState.savedWindowSize.height}px`,
                          ` · saved ${windowSizeState.savedWindowSize.width} × ${windowSizeState.savedWindowSize.height}px`,
                        )
                      : ""}
                    {windowSizeState.sizeLocked
                      ? t(
                          " · 전체 위젯 슬라이더·테두리·최대화 잠금",
                          " · widget slider, edges, and maximize locked",
                        )
                      : maximized
                        ? t(
                            " · 복원 후 저장 가능",
                            " · restore before saving",
                          )
                        : ""}
                  </span>
                </div>
                <div className="window-size-tools__actions">
                  <button
                    type="button"
                    onClick={saveCurrentWindowSize}
                    disabled={
                      !window.tokenCat ||
                      Boolean(windowSizeBusy) ||
                      maximized
                    }
                  >
                    {windowSizeBusy === "save"
                      ? t("저장 중…", "Saving…")
                      : t("현재 크기 저장", "Save size")}
                  </button>
                  <button
                    type="button"
                    onClick={resetSavedWindowSize}
                    disabled={
                      !window.tokenCat ||
                      Boolean(windowSizeBusy) ||
                      !windowSizeState.hasSavedWindowSize
                    }
                  >
                    {windowSizeBusy === "reset"
                      ? t("복원 중…", "Restoring…")
                      : t("기본 크기", "Default")}
                  </button>
                  <span className="window-size-lock-control">
                    <span>{t("크기 고정", "Lock")}</span>
                    <Toggle
                      checked={windowSizeState.sizeLocked}
                      onChange={changeWindowSizeLocked}
                      label={t("창 크기 고정", "Lock window size")}
                      disabled={!window.tokenCat || Boolean(windowSizeBusy)}
                    />
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-section integration-settings settings-category settings-category--accounts settings-category--first">
              <div className="settings-section__heading">
                <div>
                  <strong>
                    {t("실제 계정 연동", "Live account connections")}
                  </strong>
                  <span>
                    {t(
                      "인증 정보는 공식 CLI가 분리 프로필에서 관리합니다",
                      "Official CLIs manage authentication in isolated profiles",
                    )}
                  </span>
                </div>
              </div>
              <div className="integration-list">
                {(["claude", "codex"] as IntegrationProvider[]).map(
                  (provider) => {
                    const snapshot = integrations[provider];
                    const providerName = providerFromIntegration(provider);
                    const busy = integrationBusy === provider;
                    const matchingManagedClaude =
                      provider === "claude"
                        ? Object.values(managedIntegrations).find(
                            (candidate) =>
                              candidate.provider === "claude" &&
                              candidate.connected &&
                              candidate.matchesGlobalAccount === true,
                          )
                        : undefined;
                    const statusLabel = matchingManagedClaude
                      ? t(
                          "동일 Max 계정이 아래 등록 계정으로 연결됨",
                          "Same Max account linked below",
                        )
                      : integrationStatusLabel(
                          snapshot,
                          busy,
                          language,
                        );
                    const hasCurrentClaudeLimits = Boolean(
                      snapshot.quotas.fiveHour || snapshot.quotas.weekly,
                    );
                    const lastUsageAt = formatObservationTime(
                      snapshot.lastUpdatedAt,
                      language,
                    );
                    const description =
                      provider === "codex"
                        ? t(
                            "Codex App Server에서 실제 주간 한도와 초기화 시각을 읽습니다.",
                            "Reads the live weekly limit and reset time from Codex App Server.",
                          )
                        : t(
                            "Claude 공식 계정 사용량에서 5시간·주간 한도를 받고, 로컬 Claude Code에서 최신 컨텍스트 토큰 수만 읽습니다.",
                            "Reads 5-hour and weekly limits from Claude account usage and only the latest context token counts from local Claude Code data.",
                          );

                    return (
                      <div
                        className={`integration-row integration-row--${provider}`}
                        key={provider}
                      >
                        <div
                          className="integration-row__mark"
                          aria-hidden="true"
                        >
                          {provider === "claude" ? "C" : "›_"}
                        </div>
                        <div className="integration-row__copy">
                          <div>
                            <strong>{providerName}</strong>
                            <span
                              className={`integration-status integration-status--${matchingManagedClaude ? "connected" : snapshot.status}`}
                            >
                              <i aria-hidden="true" />
                              {statusLabel}
                            </span>
                          </div>
                          <small>{description}</small>
                          {matchingManagedClaude && (
                            <em>
                              {formatPlanName(
                                matchingManagedClaude.plan,
                                providerName,
                              )}{" "}
                              {t(
                                "플랜 · 공식 OAuth 사용량 수신 중",
                                "plan · receiving official OAuth usage",
                              )}
                            </em>
                          )}
                          {snapshot.connected && snapshot.plan && (
                            <em>
                              {formatPlanName(snapshot.plan, providerName)}{" "}
                              {t("플랜 · 공식 로그인 확인됨", "plan · official sign-in verified")}
                            </em>
                          )}
                          {provider === "claude" &&
                            snapshot.connected &&
                            !hasCurrentClaudeLimits && (
                              <small>
                                {lastUsageAt
                                  ? t(
                                      `마지막 사용량 수신 ${lastUsageAt} · 공식 계정 사용량을 자동으로 다시 확인합니다.`,
                                      `Last usage received ${lastUsageAt} · official account usage will be checked again automatically.`,
                                    )
                                  : snapshot.usageErrorCode ===
                                      "CLAUDE_USAGE_AUTH_ERROR"
                                    ? t(
                                        "사용량 인증이 만료되었습니다. Claude를 한 번 사용하거나 다시 로그인하면 자동 재시도합니다.",
                                        "Usage authorization expired. TokenCat retries after you use Claude or sign in again.",
                                      )
                                    : t(
                                        "공식 계정 사용량을 확인하는 중입니다. 네트워크가 복구되면 자동 재시도합니다.",
                                        "Checking official account usage. TokenCat retries automatically when the network is available.",
                                      )}
                              </small>
                            )}
                          {provider === "claude" &&
                            snapshot.connected &&
                            hasCurrentClaudeLimits &&
                            lastUsageAt && (
                              <small>
                                {t(
                                  `최신 사용량 수신 ${lastUsageAt}`,
                                  `Latest usage received ${lastUsageAt}`,
                                )}
                              </small>
                            )}
                          {snapshot.status === "conflict" && (
                            <em>
                              {t(
                                "기존 Claude 상태줄은 변경하지 않았습니다.",
                                "The existing Claude status line was left unchanged.",
                              )}
                            </em>
                          )}
                        </div>
                        <button
                          type="button"
                          className={
                            snapshot.connected || matchingManagedClaude
                              ? "is-connected"
                              : ""
                          }
                          onClick={() => void changeIntegration(provider)}
                          disabled={
                            busy ||
                            integrationBusy !== null ||
                            snapshot.status === "connecting" ||
                            snapshot.status === "conflict" ||
                            Boolean(matchingManagedClaude)
                          }
                        >
                          {busy
                            ? t("확인 중", "Checking")
                            : snapshot.status === "connecting"
                              ? t("로그인 중", "Signing in")
                            : matchingManagedClaude
                              ? t("아래 연결됨", "Linked below")
                            : snapshot.connected
                              ? t("해제", "Disconnect")
                              : snapshot.status === "conflict"
                                ? t("보호됨", "Protected")
                                : t("연동", "Connect")}
                        </button>
                      </div>
                    );
                  },
                )}
              </div>
              <p className="integration-note">
                {t(
                  "Codex는 기존 ChatGPT 로그인을 재사용합니다. Claude의 5시간·주간 수치는 공식 계정 사용량에서 자동 갱신되며, 프롬프트나 로그인 토큰은 저장하지 않습니다.",
                  "Codex reuses your existing ChatGPT sign-in. Claude 5-hour and weekly values refresh automatically from official account usage; prompts and login tokens are never stored.",
                )}
              </p>
            </div>

            <div className="settings-section managed-integration-settings settings-category settings-category--accounts">
              <div className="settings-section__heading">
                <div>
                  <strong>{t("등록한 계정", "Registered accounts")}</strong>
                  <span>
                    {t(
                      "같은 서비스를 여러 계정으로 각각 연결할 수 있습니다",
                      "Connect multiple accounts for the same service independently",
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="managed-add-button"
                  onClick={() => {
                    if (!settingsWindowMode) setSettingsOpen(false);
                    openAddPanel();
                  }}
                  disabled={!managedRegistrationAvailable}
                >
                  ＋ {t("계정 연결", "Connect account")}
                </button>
              </div>

              {Object.keys(managedIntegrations).length ? (
                <div className="managed-integration-list">
                  {Object.entries(managedIntegrations).map(
                    ([accountId, snapshot]) => {
                      const providerName = providerFromIntegration(
                        snapshot.provider,
                      );
                      const displayName =
                         managedSnapshotDetails(
                           snapshot,
                          ).displayName?.trim() ||
                          fallbackAccountName(providerName, language);
                      const busy = managedIntegrationBusy === accountId;
                      const managedLastUsageAt = formatObservationTime(
                        snapshot.lastUpdatedAt,
                        language,
                      );
                      const managedFiveHour =
                        snapshot.quotas.fiveHour?.usedPercent;
                      const managedWeekly =
                        snapshot.quotas.weekly?.usedPercent;

                      return (
                        <div
                          className={`managed-integration-row integration-row--${snapshot.provider}`}
                          key={accountId}
                        >
                          <div
                            className="integration-row__mark"
                            aria-hidden="true"
                          >
                            {snapshot.provider === "claude" ? "C" : "›_"}
                          </div>
                          <div className="managed-integration-row__content">
                            <div className="managed-integration-row__summary">
                              <strong>{displayName}</strong>
                              <span
                                className={`integration-status integration-status--${snapshot.status}`}
                              >
                                <i aria-hidden="true" />
                                {integrationStatusLabel(
                                  snapshot,
                                  busy,
                                  language,
                                )}
                              </span>
                            </div>
                            <small>
                              {providerName}
                              {snapshot.plan
                                ? t(
                                    ` · ${formatPlanName(snapshot.plan, providerName)} 플랜`,
                                    ` · ${formatPlanName(snapshot.plan, providerName)} plan`,
                                  )
                                : t(
                                    " · 플랜 확인 중",
                                    " · checking plan",
                                  )}
                            </small>
                            {snapshot.provider === "claude" &&
                              snapshot.connected &&
                              snapshot.usageSource === "oauth" && (
                                <em>
                                  {t(
                                    `공식 OAuth 사용량 수신 · 5시간 ${managedFiveHour ?? "—"}% · 주간 ${managedWeekly ?? "—"}%${managedLastUsageAt ? ` · ${managedLastUsageAt}` : ""}`,
                                    `Official OAuth usage received · 5h ${managedFiveHour ?? "—"}% · weekly ${managedWeekly ?? "—"}%${managedLastUsageAt ? ` · ${managedLastUsageAt}` : ""}`,
                                  )}
                                </em>
                              )}
                            {snapshot.provider === "claude" &&
                              snapshot.connected &&
                              snapshot.usageErrorCode && (
                                <small>
                                  {snapshot.usageErrorCode ===
                                  "CLAUDE_USAGE_AUTH_ERROR"
                                    ? t(
                                        "공식 사용량 인증 갱신을 기다리는 중입니다. Claude 사용 후 자동 재시도합니다.",
                                        "Waiting for usage authorization to refresh. TokenCat retries after Claude is used.",
                                      )
                                    : t(
                                        "공식 사용량을 다시 확인하는 중입니다.",
                                        "Retrying official usage refresh.",
                                      )}
                                </small>
                              )}
                            <div className="managed-integration-row__actions">
                              <button
                                type="button"
                                onClick={() =>
                                  void startManagedLogin(accountId)
                                }
                                disabled={busy}
                              >
                                {t("다시 로그인", "Sign in again")}
                              </button>
                              <button
                                type="button"
                                className="is-primary"
                                onClick={() =>
                                  void openManagedAccount(accountId)
                                }
                                disabled={busy || !snapshot.connected}
                              >
                                {t(
                                  `이 계정으로 ${providerName} 열기`,
                                  `Open ${providerName} for this account`,
                                )}
                              </button>
                              <button
                                type="button"
                                className="is-danger"
                                onClick={() =>
                                  void removeManagedAccount(accountId)
                                }
                                disabled={busy}
                              >
                                {t("제거", "Remove")}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>
              ) : (
                <div className="managed-integration-empty">
                  <strong>
                    {t(
                      "아직 직접 등록한 계정이 없습니다.",
                      "No accounts have been registered yet.",
                    )}
                  </strong>
                  <span>
                    {t(
                      "계정마다 별칭을 정하고 공식 로그인으로 안전하게 연결하세요.",
                      "Give each account an alias and connect it through the official sign-in.",
                    )}
                  </span>
                </div>
              )}
              <p className="managed-integration-note">
                {t(
                  "Claude의 5시간·주간 사용량은 로그인한 계정에서 자동 갱신됩니다. 서로 다른 계정의 최신 컨텍스트 토큰은 ‘이 계정으로 Claude 열기’ 창을 사용할 때 구분됩니다. TokenCat은 프롬프트나 로그인 토큰을 저장하지 않습니다.",
                  "Claude 5-hour and weekly usage refresh automatically for the signed-in account. For different accounts, latest context tokens are distinguished when you use “Open Claude for this account.” TokenCat never stores prompts or login tokens.",
                )}
              </p>
            </div>

            <div className="settings-section account-order-settings settings-category settings-category--dashboard">
              <div className="settings-section__heading">
                <div>
                  <strong>{t("카드 순서", "Card order")}</strong>
                  <span>
                    {t(
                      "대시보드에서 직접 끌거나 아래 화살표로 순서를 바꿉니다",
                      "Drag cards on the dashboard or use the arrows below",
                    )}
                  </span>
                </div>
              </div>
              <div className="account-order-list">
                {accounts.map((account, index) => {
                  const displayName = accountDisplayName(account, language);
                  return (
                    <div className="account-order-item" key={account.id}>
                      <span className="account-order-item__avatar">
                        <PetAvatar
                          provider={account.provider}
                          accountMode={
                            account.iconMode === "none"
                              ? "initial"
                              : account.iconMode
                          }
                          providerIcons={providerIcons}
                          customIcon={account.customIcon}
                          size="small"
                          language={language}
                        />
                      </span>
                      <span className="account-order-item__label">
                        <strong>{displayName}</strong>
                        <small>{account.provider}</small>
                      </span>
                      <span className="account-order-item__actions">
                        <button
                          type="button"
                          onClick={() => moveAccount(account.id, -1)}
                          disabled={index === 0}
                          aria-label={t(
                            `${displayName} 위로 이동`,
                            `Move ${displayName} up`,
                          )}
                          title={t("위로 이동", "Move up")}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveAccount(account.id, 1)}
                          disabled={index === accounts.length - 1}
                          aria-label={t(
                            `${displayName} 아래로 이동`,
                            `Move ${displayName} down`,
                          )}
                          title={t("아래로 이동", "Move down")}
                        >
                          ↓
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="settings-list settings-category-list">
              <div className="setting-row setting-row--general">
                <div>
                  <strong>{t("펫 움직임", "Pet motion")}</strong>
                  <small>
                    {t(
                      "대기·동기화·완료·한도 상태에 맞춰 움직입니다",
                      "Moves with idle, sync, completion, and limit states",
                    )}
                  </small>
                </div>
                <div className="setting-row__actions">
                  <button
                    className="motion-preview-button"
                    type="button"
                    onClick={() => {
                      if (!petMotion) setPetMotion(true);
                      animatePets();
                      setToast(
                        t(
                          "TokenCat과 계정 펫 움직임을 재생합니다.",
                          "Playing TokenCat and account pet motion.",
                        ),
                      );
                    }}
                  >
                    ▶ {t("보기", "Preview")}
                  </button>
                  <Toggle
                    checked={petMotion}
                    onChange={setPetMotion}
                    label={t("펫 움직임", "Pet motion")}
                  />
                </div>
              </div>
              <div className="setting-row setting-row--general">
                <div>
                  <strong>{t("항상 위에 표시", "Always on top")}</strong>
                  <small>
                    {t(
                      "다른 창보다 앞에 고정합니다",
                      "Keeps TokenCat above other windows",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={pinned}
                  onChange={togglePinned}
                  label={t("항상 위에 표시", "Always on top")}
                />
              </div>
              <div className="setting-row setting-row--general">
                <div>
                  <strong>
                    {t("상단 창 바 자동 숨김", "Auto-hide top bar")}
                  </strong>
                  <small>
                    {t(
                      "잠시 후 접히고 창 맨 위나 위젯을 건드리면 다시 나타납니다",
                      "Folds away after a moment and returns when you touch the top or widget",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={titlebarAutoHide}
                  onChange={setTitlebarAutoHide}
                  label={t(
                    "상단 창 바 자동 숨김",
                    "Auto-hide top bar",
                  )}
                />
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("컴팩트 모드", "Compact mode")}</strong>
                  <small>
                    {t(
                      "창과 카드 간격을 더 줄입니다",
                      "Reduces window and card spacing",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={compact}
                  onChange={changeCompact}
                  label={t("컴팩트 모드", "Compact mode")}
                />
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("미니멀 모드", "Minimal mode")}</strong>
                  <small>
                    {t(
                      "설정한 펫과 사용률 그래프만 밀착해 표시합니다",
                      "Shows only configured pets and compact usage graphs",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={minimal}
                  onChange={changeMinimal}
                  label={t("미니멀 모드", "Minimal mode")}
                  disabled={windowSizeState.sizeLocked && !minimal}
                />
              </div>
              <div className="setting-row setting-row--dashboard setting-row--minimal-layout">
                <div>
                  <strong>
                    {t("미니멀 배치", "Minimal layout")}
                  </strong>
                  <small>
                    {t(
                      "가로·중간·세로 배치를 직접 선택하며 미니멀 상태에서는 바로 전환됩니다",
                      "Choose horizontal, medium, or vertical; changes apply immediately in minimal mode",
                    )}
                  </small>
                </div>
                <div
                  className="minimal-layout-mode-control"
                  role="group"
                  aria-label={t(
                    "미니멀 배치 방식",
                    "Minimal layout orientation",
                  )}
                >
                  {(
                    [
                      ["horizontal", t("가로", "Horizontal")],
                      ["medium", t("중간", "Medium")],
                      ["vertical", t("세로", "Vertical")],
                    ] as Array<[MinimalOrientation, string]>
                  ).map(([orientation, label]) => (
                    <button
                      type="button"
                      className={
                        minimalOrientation === orientation
                          ? "is-active"
                          : ""
                      }
                      aria-pressed={minimalOrientation === orientation}
                      onClick={() => {
                        if (minimal) {
                          changeMinimal(true, orientation);
                        } else {
                          setMinimalOrientation(orientation);
                        }
                      }}
                      key={orientation}
                    >
                      <i
                        className={`minimal-layout-mode-preview minimal-layout-mode-preview--${orientation}`}
                        aria-hidden="true"
                      />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row setting-row--dashboard setting-row--minimal-graph">
                <div>
                  <strong>
                    {t("미니멀 그래프", "Minimal graph")}
                  </strong>
                  <small>
                    {t(
                      "일반 사용량 화면의 원형·막대 선택을 그대로 사용합니다",
                      "Uses the ring or bar style selected on the main usage view",
                    )}
                  </small>
                </div>
                <div
                  className="minimal-graph-mode-control"
                  role="group"
                  aria-label={t(
                    "미니멀 그래프 방식",
                    "Minimal graph style",
                  )}
                >
                  {(
                    [
                      ["follow", t("현재 보기", "Current view")],
                      ["none", t("없음", "None")],
                    ] as Array<[MinimalGraphPreference, string]>
                  ).map(([preference, label]) => (
                    <button
                      type="button"
                      className={
                        minimalGraphPreference === preference
                          ? "is-active"
                          : ""
                      }
                      aria-pressed={minimalGraphPreference === preference}
                      onClick={() => setMinimalGraphPreference(preference)}
                      key={preference}
                    >
                      <i
                        className={`minimal-graph-mode-preview minimal-graph-mode-preview--${
                          preference === "follow" ? minimalGraphMode : "none"
                        }`}
                        aria-hidden="true"
                      />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>
                    {t("크기에 따라 자동 미니멀", "Auto minimal by size")}
                  </strong>
                  <small>
                    {t(
                      `높이 ${autoMinimalHeight}px 이하는 가로형, 폭 ${autoMinimalWidth}px 이하는 중간형, ${VERTICAL_MINIMAL_ENTER_WIDTH}px 미만은 세로형으로 전환합니다`,
                      `Uses horizontal at or below ${autoMinimalHeight}px tall, medium at or below ${autoMinimalWidth}px wide, and vertical below ${VERTICAL_MINIMAL_ENTER_WIDTH}px`,
                    )}
                  </small>
                </div>
                <Toggle
                  checked={autoMinimal}
                  onChange={(next) => {
                    if (next) autoMinimalSuppressedRef.current = false;
                    setAutoMinimal(next);
                  }}
                  label={t(
                    "크기에 따라 자동 미니멀",
                    "Auto minimal by size",
                  )}
                  disabled={windowSizeState.sizeLocked}
                />
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("사용량만 보기", "Usage-focused view")}</strong>
                  <small>
                    {t(
                      "연동 상태와 부가 설명을 숨깁니다",
                      "Hides connection status and secondary details",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={usageOnly}
                  onChange={setUsageOnly}
                  label={t("사용량만 보기", "Usage-focused view")}
                />
              </div>
              <div className="setting-row setting-row--dashboard setting-row--token-display">
                <div>
                  <strong>
                    {t("Claude 컨텍스트 토큰", "Claude context tokens")}
                  </strong>
                  <small>
                    {t(
                      "로컬 Claude Code의 최신 컨텍스트 입력·출력 토큰 수입니다. 구독 한도 총사용량은 아닙니다.",
                      "Input and output token counts for the latest local Claude Code context, not total usage against the subscription limit.",
                    )}
                  </small>
                </div>
                <div
                  className="token-display-mode-control"
                  role="group"
                  aria-label={t(
                    "Claude 컨텍스트 토큰 표시 방식",
                    "Claude context token display",
                  )}
                >
                  {(
                    [
                      ["total", t("합계", "Total")],
                      ["detail", t("입력·출력", "In / out")],
                      ["hidden", t("숨김", "Hidden")],
                    ] as Array<[TokenDisplayMode, string]>
                  ).map(([mode, label]) => (
                    <button
                      type="button"
                      className={tokenDisplayMode === mode ? "is-active" : ""}
                      aria-pressed={tokenDisplayMode === mode}
                      onClick={() => setTokenDisplayMode(mode)}
                      key={mode}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("프로필 표시", "Show profile")}</strong>
                  <small>
                    {t(
                      "각 카드에 계정 펫이나 프로필 이미지를 표시합니다",
                      "Shows the account pet or profile image on each card",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={showCardProfile}
                  onChange={setShowCardProfile}
                  label={t("프로필 표시", "Show profile")}
                />
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("계정 이름 표시", "Show account name")}</strong>
                  <small>
                    {t(
                      "프로필과 별개로 계정 이름을 표시합니다",
                      "Shows the account name independently from the profile",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={showCardName}
                  onChange={setShowCardName}
                  label={t("계정 이름 표시", "Show account name")}
                />
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("플랜 표시", "Show plan")}</strong>
                  <small>
                    {t(
                      "서비스와 플랜을 계정 이름과 별개로 표시합니다",
                      "Shows the service and plan independently from the account name",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={showCardPlan}
                  onChange={setShowCardPlan}
                  label={t("플랜 표시", "Show plan")}
                />
              </div>
              <div className="setting-row setting-row--dashboard">
                <div>
                  <strong>{t("편집 버튼 표시", "Show edit button")}</strong>
                  <small>
                    {t(
                      "카드에서 계정 편집창을 바로 열 수 있습니다",
                      "Lets you open account editing directly from a card",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={showCardEdit}
                  onChange={setShowCardEdit}
                  label={t("편집 버튼 표시", "Show edit button")}
                />
              </div>
              <div className="setting-row setting-row--general">
                <div>
                  <strong>
                    {t("Windows 시작 시 실행", "Launch with Windows")}
                  </strong>
                  <small>
                    {t(
                      "트레이에서 자동 시작합니다",
                      "Starts automatically in the system tray",
                    )}
                  </small>
                </div>
                <Toggle
                  checked={openAtLogin}
                  onChange={changeOpenAtLogin}
                  label={t("Windows 시작 시 실행", "Launch with Windows")}
                />
              </div>
            </div>

            <div className="settings-section settings-category settings-category--accounts">
              <div className="settings-section__heading">
                <strong>
                  {t("기본 계정 프로필", "Default account profile")}
                </strong>
                <span>
                  {t(
                    "계정별로 다시 지정 가능",
                    "Can be overridden per account",
                  )}
                </span>
              </div>
              {(["Claude", "Codex"] as Provider[]).map((provider) => (
                <div className="provider-icon-setting" key={provider}>
                  <div>
                    <PetAvatar
                      provider={provider}
                      accountMode={providerIcons[provider]}
                      providerIcons={providerIcons}
                      size="medium"
                      motion={petMotion}
                      working={syncing}
                      language={language}
                    />
                    <strong>{provider}</strong>
                  </div>
                  <div
                    className="segmented-control"
                    aria-label={t(
                      `${provider} 기본 프로필`,
                      `${provider} default profile`,
                    )}
                  >
                    {(
                      [
                        ["pet", t("펫", "Pet")],
                        ["initial", t("이니셜", "Initial")],
                        ["none", t("숨김", "Hidden")],
                      ] as Array<[ProviderIconMode, string]>
                    ).map(([mode, label]) => (
                      <button
                        type="button"
                        className={
                          providerIcons[provider] === mode ? "is-active" : ""
                        }
                        onClick={() =>
                          setProviderIcons((current) => ({
                            ...current,
                            [provider]: mode,
                          }))
                        }
                        aria-pressed={providerIcons[provider] === mode}
                        key={mode}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="settings-section settings-category settings-category--appearance settings-category--first">
              <div className="settings-section__heading">
                <strong>{t("테마", "Theme")}</strong>
              </div>
              <div
                className="theme-options"
                aria-label={t("테마 선택", "Theme selection")}
              >
                {(
                  [
                    [
                      "light",
                      t("라이트", "Light"),
                      "#f5f5f4",
                      "#ffffff",
                      "#343434",
                    ],
                    [
                      "dark",
                      t("다크", "Dark"),
                      "#18181b",
                      "#242427",
                      "#ededed",
                    ],
                    [
                      "stone",
                      t("스톤", "Stone"),
                      "#e7e5e4",
                      "#f8f7f5",
                      "#44403c",
                    ],
                    [
                      "midnight",
                      t("미드나이트", "Midnight"),
                      "#0b1120",
                      "#111a2e",
                      "#8fb4ff",
                    ],
                    [
                      "ocean",
                      t("오션", "Ocean"),
                      "#eaf2f7",
                      "#f8fbfd",
                      "#25637d",
                    ],
                    [
                      "forest",
                      t("포레스트", "Forest"),
                      "#101815",
                      "#17211d",
                      "#9ac7ad",
                    ],
                    [
                      "rose",
                      t("로즈", "Rose"),
                      "#f4ecec",
                      "#fff9f8",
                      "#7a4e54",
                    ],
                  ] as Array<[Theme, string, string, string, string]>
                ).map(([value, label, background, surface, accent]) => (
                  <button
                    type="button"
                    className={theme === value ? "is-active" : ""}
                    onClick={() => setTheme(value)}
                    aria-pressed={theme === value}
                    aria-label={label}
                    key={value}
                  >
                    <i
                      style={{
                        background: `linear-gradient(135deg, ${background} 0 55%, ${surface} 55% 100%)`,
                      }}
                    >
                      <span style={{ backgroundColor: accent }} />
                    </i>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section settings-category settings-category--appearance">
              <div className="settings-section__heading">
                <strong>{t("투명 모드", "Transparency")}</strong>
                <span>
                  {t(
                    "투명하게 만들 대상을 선택한 뒤 슬라이더로 정도를 조절합니다. 설정 창은 항상 선명하게 유지됩니다.",
                    "Choose what becomes transparent, then adjust the amount. Settings always stays fully opaque.",
                  )}
                </span>
              </div>
              <div
                className="transparency-mode-control"
                role="group"
                aria-label={t("투명 대상", "Transparency target")}
              >
                <button
                  type="button"
                  className={
                    transparencyMode === "whole-window"
                      ? "is-active"
                      : ""
                  }
                  aria-pressed={transparencyMode === "whole-window"}
                  onClick={() =>
                    changeTransparencyMode("whole-window")
                  }
                >
                  <strong>{t("전체 투명", "Whole widget")}</strong>
                  <small>
                    {t(
                      "배경·그래프·숫자·캐릭터",
                      "Background, graphs, numbers, and pets",
                    )}
                  </small>
                </button>
                <button
                  type="button"
                  className={
                    transparencyMode === "background-only"
                      ? "is-active"
                      : ""
                  }
                  aria-pressed={transparencyMode === "background-only"}
                  disabled={!backgroundOnlyTransparencySupported}
                  onClick={() =>
                    changeTransparencyMode("background-only")
                  }
                >
                  <strong>{t("배경만 투명", "Background only")}</strong>
                  <small>
                    {backgroundOnlyTransparencySupported
                      ? t(
                          "그래프·숫자·캐릭터는 선명",
                          "Graphs, numbers, and pets stay crisp",
                        )
                      : t(
                          "Windows 11 22H2 이상 필요",
                          "Requires Windows 11 22H2 or later",
                        )}
                  </small>
                </button>
              </div>
              <div className="window-opacity-control">
                <SizeRangeControl
                  id="window-opacity"
                  label={
                    transparencyMode === "background-only"
                      ? t("배경 불투명도", "Background opacity")
                      : t("전체 불투명도", "Whole-widget opacity")
                  }
                  description={t(
                    `왼쪽 ${MIN_WINDOW_OPACITY}%부터 오른쪽 100%까지 1% 단위로 조절합니다`,
                    `Drag from ${MIN_WINDOW_OPACITY}% on the left to 100% on the right`,
                  )}
                  value={windowOpacity}
                  minimum={MIN_WINDOW_OPACITY}
                  maximum={MAX_WINDOW_OPACITY}
                  unit="%"
                  step={1}
                  onChange={changeWindowOpacity}
                />
              </div>
            </div>

            <div className="settings-section graph-color-settings settings-category settings-category--appearance">
              <div className="settings-section__heading">
                <div>
                  <strong>
                    {t("사용량 그래프 색상", "Usage graph colors")}
                  </strong>
                  <span>
                    {t(
                      "전역 기본값 위에 계정별 색상을 덮어쓸 수 있습니다",
                      "Set service defaults and override individual accounts",
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="color-reset-all"
                  onClick={() =>
                    resetGraphScopePaint(resolvedGraphColorScope)
                  }
                  disabled={!selectedGraphHasOverride}
                >
                  {resolvedGraphColorScope.startsWith("account:")
                    ? t("전역 사용", "Use global")
                    : t("기본값", "Default")}
                </button>
              </div>

              <label className="graph-scope-field">
                <span>{t("적용 범위", "Apply to")}</span>
                <select
                  value={resolvedGraphColorScope}
                  onChange={(event) =>
                    setGraphColorScope(
                      event.currentTarget.value as GraphColorScope,
                    )
                  }
                >
                  <optgroup label={t("전역 기본값", "Global defaults")}>
                    <option value="provider:Claude">
                      {t("Claude 전체", "All Claude accounts")}
                    </option>
                    <option value="provider:Codex">
                      {t("Codex 전체", "All Codex accounts")}
                    </option>
                  </optgroup>
                  <optgroup label={t("계정별 설정", "Account overrides")}>
                    {accounts.map((account) => (
                      <option value={`account:${account.id}`} key={account.id}>
                        {accountDisplayName(account, language)} ·{" "}
                        {account.provider}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>

              <GraphPaintControls
                scope={resolvedGraphColorScope}
                paint={selectedGraphPaint}
                provider={selectedGraphProvider}
                language={language}
                inputNamespace="settings"
                onModeChange={changeGraphPaintMode}
                onPatch={updateGraphScopePaint}
                onPick={pickGraphColorFromScreen}
              />
              <PercentageToneControls
                scope={resolvedGraphColorScope}
                colors={selectedPercentageColors}
                provider={selectedGraphProvider}
                language={language}
                inputNamespace="settings"
                hasOverride={selectedPercentageHasOverride}
                graphFollowsUsage={selectedPercentageGraphEnabled}
                graphModeInherited={selectedPercentageGraphInherited}
                onChange={updatePercentageScopeColor}
                onGraphModeChange={updatePercentageGraphScope}
                onGraphModeReset={resetPercentageGraphScope}
                onReset={resetPercentageScopeColors}
                onPick={pickPercentageColorFromScreen}
              />
              <div className="graph-account-actions">
                {selectedGraphAccount && (
                  <button
                    type="button"
                    className="graph-account-edit"
                    onClick={() => {
                      if (!settingsWindowMode) setSettingsOpen(false);
                      setEditingId(selectedGraphAccount.id);
                    }}
                  >
                    {t(
                      `${accountDisplayName(selectedGraphAccount, language)} 계정 편집`,
                      `Edit ${accountDisplayName(selectedGraphAccount, language)}`,
                    )}
                  </button>
                )}
              </div>
              <p className="graph-color-note">
                {t(
                  "색상은 현재 테마에 저장됩니다. 계정별 설정을 초기화하면 해당 Claude·Codex 전역 색상을 다시 사용합니다.",
                  "Colors are saved per theme. Resetting an account override makes it use the Claude or Codex global color again.",
                )}
              </p>
            </div>

            <div className="settings-section color-settings settings-category settings-category--appearance">
              <div className="settings-section__heading">
                <div>
                  <strong>{t("앱 색상 팔레트", "App color palette")}</strong>
                  <span>
                    {t(
                      "현재 테마에 따로 저장됩니다",
                      "Saved separately for the current theme",
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="color-reset-all"
                  onClick={resetThemeColors}
                  disabled={!Object.keys(activeColorOverrides).length}
                >
                  {t("팔레트 초기화", "Reset palette")}
                </button>
              </div>
              <div className="color-palette-list">
                {COLOR_ROLES.map(({ role, label }) => {
                  const currentColor = getCurrentColor(role);
                  const localizedLabel =
                    role === "accent"
                      ? t("강조", "Accent")
                      : role === "appBg"
                        ? t("앱 배경", "App background")
                        : role === "surface"
                          ? t("카드", "Cards")
                          : label;
                  return (
                    <div className="color-palette-row" key={role}>
                      <div className="color-palette-row__label">
                        <strong>{localizedLabel}</strong>
                        <code>{currentColor}</code>
                      </div>
                      <div className="color-palette-row__controls">
                        <div
                          className="color-swatches"
                          aria-label={t(
                            `${localizedLabel} 빠른 색상`,
                            `${localizedLabel} quick colors`,
                          )}
                        >
                          {activeColorPalette[role].map((color) => (
                            <button
                              type="button"
                              className="color-swatch"
                              style={{ backgroundColor: color }}
                              onClick={() => applyColor(role, color)}
                              aria-label={`${localizedLabel} ${color}`}
                              aria-pressed={currentColor === color}
                              key={color}
                            >
                              <span aria-hidden="true">✓</span>
                            </button>
                          ))}
                        </div>
                        <input
                          id={`tokencat-color-${role}`}
                          className="color-native-input"
                          type="color"
                          value={currentColor}
                          onChange={(event) =>
                            applyColor(role, event.currentTarget.value)
                          }
                          aria-label={t(
                            `${localizedLabel} 직접 선택`,
                            `Choose ${localizedLabel} directly`,
                          )}
                          title={t(
                            `${localizedLabel} 직접 선택`,
                            `Choose ${localizedLabel} directly`,
                          )}
                        />
                        <button
                          type="button"
                          className="eyedropper-button"
                          onClick={() => pickColorFromScreen(role)}
                          aria-label={t(
                            `${localizedLabel} 색 화면에서 추출`,
                            `Pick ${localizedLabel} from the screen`,
                          )}
                          title={t(
                            "화면에서 색상 가져오기",
                            "Pick a color from the screen",
                          )}
                        >
                          <span aria-hidden="true">⌾</span>
                          {t("스포이트", "Pick")}
                        </button>
                        <button
                          type="button"
                          className="color-role-reset"
                          onClick={() => resetColor(role)}
                          disabled={!activeColorOverrides[role]}
                          aria-label={t(
                            `${localizedLabel} 기본값으로 초기화`,
                            `Reset ${localizedLabel} to default`,
                          )}
                          title={t("기본값", "Default")}
                        >
                          ↺
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            </div>
            <footer className="panel-footer">
              <span>TokenCat v{version}</span>
              <button type="button" onClick={() => window.tokenCat?.quit()}>
                {t("앱 완전 종료", "Quit app")}
              </button>
            </footer>
          </section>
        </div>
      )}

      {addOpen && (
        <div className="overlay" onMouseDown={() => setAddOpen(false)}>
          <section
            className="panel form-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="panel-heading">
              <div>
                <span>NEW ACCOUNT</span>
                <h2 id="add-title">{t("계정 추가", "Add account")}</h2>
              </div>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                aria-label={t("닫기", "Close")}
              >
                ×
              </button>
            </header>
            <div
              className="account-add-tabs"
              role="tablist"
              aria-label={t("계정 추가 방식", "Account setup method")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={addMode === "managed"}
                className={addMode === "managed" ? "is-active" : ""}
                onClick={() => setAddMode("managed")}
                disabled={!managedRegistrationAvailable}
                title={
                  managedRegistrationAvailable
                    ? undefined
                    : t(
                        "설치된 TokenCat 앱에서 사용할 수 있습니다.",
                        "Available in the installed TokenCat app.",
                      )
                }
              >
                {t("실제 계정 연결", "Connect live account")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={addMode === "manual"}
                className={addMode === "manual" ? "is-active" : ""}
                onClick={() => setAddMode("manual")}
              >
                {t("사용량 직접 입력", "Enter usage manually")}
              </button>
            </div>
            <form onSubmit={addAccount}>
              <fieldset className="provider-picks">
                <legend>{t("서비스", "Service")}</legend>
                {(["Claude", "Codex"] as Provider[]).map((provider) => (
                  <label key={provider}>
                    <input
                      type="radio"
                      name="provider"
                      value={provider}
                      checked={addProvider === provider}
                      onChange={() => setAddProvider(provider)}
                    />
                    <span>
                      <PetAvatar
                        provider={provider}
                        accountMode="pet"
                        providerIcons={providerIcons}
                        size="small"
                        motion={petMotion}
                        language={language}
                      />
                      {provider}
                    </span>
                  </label>
                ))}
              </fieldset>

              {addMode === "managed" ? (
                <>
                  <div className="managed-connect-intro">
                    <strong>
                      {t(
                        `${addProvider} 실제 사용량 자동 동기화`,
                        `Automatic live ${addProvider} usage`,
                      )}
                    </strong>
                    <span>
                      {t(
                        "계정별 전용 프로필을 만들어 같은 서비스의 여러 계정도 서로 덮어쓰지 않고 등록합니다.",
                        "Creates an isolated profile for each account so multiple accounts for the same service never overwrite one another.",
                      )}
                    </span>
                  </div>
                  <label className="field">
                    <span>{t("계정 별칭", "Account alias")}</span>
                    <input
                      name="managedLabel"
                      autoFocus
                      placeholder={
                        addProvider === "Claude"
                          ? t("예: Claude · 회사", "e.g. Claude · Work")
                          : t("예: Codex · 개인", "e.g. Codex · Personal")
                      }
                      autoComplete="off"
                      required
                    />
                  </label>
                  <p className="form-note managed-connect-note">
                    {t(
                      `다음 단계에서 ${addProvider}의 공식 로그인 화면이 열립니다. TokenCat은 비밀번호를 입력받지 않으며, 인증 정보는 공식 CLI가 계정별 분리 프로필에서 관리합니다.`,
                      `The official ${addProvider} sign-in opens next. TokenCat never asks for your password; the official CLI manages authentication in an isolated account profile.`,
                    )}
                    {addProvider === "Claude" && (
                      <>
                        {" "}
                        {t(
                          "5시간·주간 사용량은 자동 갱신됩니다. 다른 Claude 계정의 컨텍스트 토큰을 구분하려면 ‘이 계정으로 Claude 열기’를 사용하세요.",
                          "5-hour and weekly usage refresh automatically. Use “Open Claude for this account” to distinguish context tokens for another Claude account.",
                        )}
                      </>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <div className="form-grid">
                    <label className="field">
                      <span>{t("계정 이름", "Account name")}</span>
                      <input
                        name="name"
                        autoFocus
                        placeholder={t(
                          `${addProvider} · 개인용`,
                          `${addProvider} · Personal`,
                        )}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>{t("플랜", "Plan")}</span>
                      <input
                        name="plan"
                        placeholder={
                          addProvider === "Claude" ? "Max" : "Plus"
                        }
                        required
                      />
                    </label>
                  </div>
                  <QuotaFields
                    key={`five-hour-${addProvider}`}
                    prefix="fiveHour"
                    label={t("5시간 한도", "5-hour limit")}
                    defaultUsed={0}
                    defaultVisible={addProvider === "Claude"}
                    language={language}
                  />
                  <QuotaFields
                    key={`weekly-${addProvider}`}
                    prefix="weekly"
                    label={t("주간 한도", "Weekly limit")}
                    defaultUsed={0}
                    defaultVisible
                    language={language}
                  />
                  <p className="form-note">
                    {t(
                      "실제 사용 화면에 보이는 한도만 ‘표시’로 켜 주세요.",
                      "Enable only limits shown in the real usage screen.",
                    )}
                  </p>
                </>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={addBusy}
              >
                {addMode === "managed"
                  ? addBusy
                    ? t("계정 준비 중…", "Preparing account…")
                    : t("공식 로그인 열기", "Open official sign-in")
                  : t("추가", "Add")}
              </button>
            </form>
          </section>
        </div>
      )}

      {editingAccount && (
        <div className="overlay" onMouseDown={() => setEditingId(null)}>
          <section
            className="panel form-panel edit-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="panel-heading">
              <div>
                <span>ACCOUNT</span>
                <h2 id="edit-title">{t("계정 편집", "Edit account")}</h2>
              </div>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                aria-label={t("닫기", "Close")}
              >
                ×
              </button>
            </header>

            <div className="icon-picker">
              <span>{t("계정 프로필", "Account profile")}</span>
              <div>
                {(
                  [
                    ["default", t("기본", "Default")],
                    ["pet", t("펫", "Pet")],
                    ["initial", t("이니셜", "Initial")],
                    ["none", t("숨김", "Hidden")],
                  ] as Array<[AccountIconMode, string]>
                ).map(([mode, label]) => (
                  <button
                    type="button"
                    className={
                      editingAccount.iconMode === mode ? "is-active" : ""
                    }
                    onClick={() => setAccountIcon(editingAccount.id, mode)}
                    key={mode}
                  >
                    <span className="icon-preview">
                      <PetAvatar
                        provider={editingAccount.provider}
                        accountMode={mode}
                        providerIcons={providerIcons}
                        customIcon={editingAccount.customIcon}
                        size="small"
                        motion={petMotion}
                        language={language}
                      />
                    </span>
                    {label}
                  </button>
                ))}
                <label
                  className={
                    editingAccount.iconMode === "custom" ? "is-active" : ""
                  }
                >
                  <span className="icon-preview">
                    {editingAccount.customIcon ? (
                      <PetAvatar
                        provider={editingAccount.provider}
                        accountMode="custom"
                        providerIcons={providerIcons}
                        customIcon={editingAccount.customIcon}
                        size="small"
                        motion={petMotion}
                        language={language}
                      />
                    ) : (
                      "+"
                    )}
                  </span>
                  {t("내 이미지", "My image")}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) =>
                      importCustomIcon(
                        editingAccount.id,
                        event.target.files?.[0],
                      )
                    }
                  />
                </label>
              </div>
            </div>

            {editingGraphScope && editingGraphPaint && (
              <section className="edit-graph-color">
                <div className="edit-graph-color__heading">
                  <div>
                    <strong>{t("이 계정의 그래프 색상", "Account graph color")}</strong>
                    <span>
                      {editingGraphHasOverride
                        ? t(
                            "이 계정만의 색상을 사용 중입니다",
                            "Using a color specific to this account",
                          )
                        : t(
                            `${editingAccount.provider} 전역 색상을 사용 중입니다`,
                            `Using the global ${editingAccount.provider} color`,
                          )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="color-reset-all"
                    onClick={() => resetGraphScopePaint(editingGraphScope)}
                    disabled={!editingGraphHasOverride}
                  >
                    {t(
                      `${editingAccount.provider} 전역 사용`,
                      `Use global ${editingAccount.provider}`,
                    )}
                  </button>
                </div>
                <GraphPaintControls
                  scope={editingGraphScope}
                  paint={editingGraphPaint}
                  provider={editingAccount.provider}
                  language={language}
                  inputNamespace="edit"
                  onModeChange={changeGraphPaintMode}
                  onPatch={updateGraphScopePaint}
                  onPick={pickGraphColorFromScreen}
                />
                {editingPercentageColors && (
                  <PercentageToneControls
                    scope={editingGraphScope}
                    colors={editingPercentageColors}
                    provider={editingAccount.provider}
                    language={language}
                    inputNamespace="edit"
                    hasOverride={editingPercentageHasOverride}
                    graphFollowsUsage={editingPercentageGraphEnabled}
                    graphModeInherited={editingPercentageGraphInherited}
                    onChange={updatePercentageScopeColor}
                    onGraphModeChange={updatePercentageGraphScope}
                    onGraphModeReset={resetPercentageGraphScope}
                    onReset={resetPercentageScopeColors}
                    onPick={pickPercentageColorFromScreen}
                  />
                )}
                <p className="graph-color-note">
                  {t(
                    "색상 변경은 현재 테마에 즉시 저장되며 다른 계정에는 영향을 주지 않습니다.",
                    "Changes are saved immediately for this theme and do not affect other accounts.",
                  )}
                </p>
              </section>
            )}

            <form onSubmit={updateAccount}>
              <div className="form-grid">
                <label className="field">
                  <span>{t("계정 이름", "Account name")}</span>
                  <input
                    name="name"
                    defaultValue={editingAccount.name}
                    disabled={Boolean(editingManagedId)}
                    required
                  />
                </label>
                <label className="field">
                  <span>{t("플랜", "Plan")}</span>
                  <input
                    name="plan"
                    defaultValue={editingAccount.plan}
                    disabled={editingAccount.origin === "live"}
                    required
                  />
                </label>
              </div>
              {editingAccount.origin === "live" ? (
                <p className="form-note live-form-note">
                  {editingManagedId
                    ? t(
                        "별칭·플랜·사용률·초기화 시각은 등록한 계정에서 자동으로 갱신됩니다. 프로필 이미지와 그래프 색상은 여기서 바꿀 수 있습니다.",
                        "Alias, plan, usage, and reset time update automatically from the registered account. You can change its profile image and graph color here.",
                      )
                    : t(
                        "플랜·사용률·초기화 시각은 공식 CLI에서 자동으로 갱신됩니다. 이름·프로필 이미지·그래프 색상은 여기서 바꿀 수 있습니다.",
                        "Plan, usage, and reset time update automatically from the official CLI. You can change the name, profile image, and graph color here.",
                      )}
                </p>
              ) : (
                <>
                  <QuotaFields
                    prefix="fiveHour"
                    label={t("5시간 한도", "5-hour limit")}
                    defaultUsed={editingAccount.quotas.fiveHour.used}
                    defaultReset={editingAccount.quotas.fiveHour.reset}
                    defaultVisible={editingAccount.quotas.fiveHour.visible}
                    language={language}
                  />
                  <QuotaFields
                    prefix="weekly"
                    label={t("주간 한도", "Weekly limit")}
                    defaultUsed={editingAccount.quotas.weekly.used}
                    defaultReset={editingAccount.quotas.weekly.reset}
                    defaultVisible={editingAccount.quotas.weekly.visible}
                    language={language}
                  />
                  <p className="form-note">
                    {t(
                      "계정의 실제 사용 화면에 없는 한도는 표시를 꺼도 됩니다.",
                      "You can hide limits that do not appear in the account's real usage screen.",
                    )}
                  </p>
                </>
              )}
              <button className="primary-button" type="submit">
                {t("저장", "Save")}
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void removeAccount()}
              >
                {editingManagedId
                  ? t("등록 계정 제거", "Remove registered account")
                  : editingAccount.origin === "live"
                    ? t("연동 해제", "Disconnect")
                    : t("계정 제거", "Remove account")}
              </button>
            </form>
          </section>
        </div>
      )}

      {pendingManagedRemoval && pendingManagedRemovalSnapshot && (
        <div
          className="overlay confirmation-overlay"
          onMouseDown={() => {
            if (!managedIntegrationBusy) setPendingManagedRemoval(null);
          }}
        >
          <section
            className="panel confirmation-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-account-title"
            aria-describedby="remove-account-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="confirmation-panel__eyebrow">REMOVE ACCOUNT</span>
            <h2 id="remove-account-title">
              {t(
                `${pendingManagedRemovalName} 등록을 제거할까요?`,
                `Remove ${pendingManagedRemovalName}?`,
              )}
            </h2>
            <p id="remove-account-description">
              {t(
                "이 계정으로 연 Claude·Codex 창이 있다면 먼저 닫아 주세요. TokenCat의 사용 분석 기록도 함께 지워집니다. 프로필은 복구 가능한 보관 위치로 이동하며 서비스의 원격 로그인은 철회되지 않습니다.",
                "Close any Claude or Codex window opened for this account first. TokenCat usage history for this account is also cleared. The profile moves to a recoverable archive and the service's remote sign-in is not revoked.",
              )}
            </p>
            <div className="confirmation-panel__actions">
              <button
                type="button"
                autoFocus
                disabled={Boolean(managedIntegrationBusy)}
                onClick={() => setPendingManagedRemoval(null)}
              >
                {t("취소", "Cancel")}
              </button>
              <button
                type="button"
                className="is-danger"
                disabled={Boolean(managedIntegrationBusy)}
                onClick={() =>
                  void removeManagedAccount(pendingManagedRemoval, true)
                }
              >
                {managedIntegrationBusy
                  ? t("제거 중…", "Removing…")
                  : t("등록 제거", "Remove")}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className={`toast ${toast ? "toast--visible" : ""}`} role="status">
        <i />
        <span>{toast}</span>
      </div>
    </div>
  );
}

export default App;
