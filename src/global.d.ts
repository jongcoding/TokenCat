export {};

declare global {
  type IntegrationProvider = "codex" | "claude";
  type WindowLayout =
    | "vertical"
    | "horizontal"
    | "grid-2x2"
    | "grid-3x3";
  type WindowCardSurfaceMode = "separate" | "unified";
  type MinimalOrientation = "horizontal" | "medium" | "vertical";
  type WindowTransparencyMode = "whole-window" | "background-only";
  interface WindowTransparencyPreferences {
    mode: WindowTransparencyMode;
    opacity: number;
  }
  interface WindowSize {
    width: number;
    height: number;
  }

  interface WindowSizeState {
    changeSource?: "manual" | "programmatic" | "initial";
    sizeLocked: boolean;
    currentWindowSize: WindowSize;
    savedWindowSize: WindowSize | null;
    hasSavedWindowSize: boolean;
  }

  interface IntegrationQuota {
    usedPercent: number;
    resetsAt: string | null;
  }

  interface IntegrationContextTokens {
    source: "claude-context-window";
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextWindowSize: number | null;
    usedPercent: number | null;
    observedAt: string | null;
  }

  interface IntegrationSnapshot {
    provider: IntegrationProvider;
    accountId?: string;
    displayName?: string;
    managed?: boolean;
    connected: boolean;
    plan: string | null;
    status:
      | "connected"
      | "connecting"
      | "disconnected"
      | "unavailable"
      | "conflict"
      | "error";
    quotas: {
      fiveHour?: IntegrationQuota;
      weekly?: IntegrationQuota;
    };
    contextTokens: IntegrationContextTokens | null;
    lastUpdatedAt: string | null;
    usageUpdatedAt?: string | null;
    authVerifiedAt: string | null;
    usageSource?: "app-server" | "oauth" | "local" | null;
    usageErrorCode?: string | null;
    matchesGlobalAccount?: boolean;
    errorCode: string | null;
  }

  type AppUpdateStatus =
    | "disabled"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "up-to-date"
    | "error";

  type AppDistribution = "development" | "portable" | "nsis";

  interface AppUpdateState {
    status: AppUpdateStatus;
    distribution: AppDistribution;
    supported: boolean;
    currentVersion: string;
    availableVersion: string | null;
    progressPercent: number | null;
    transferred: number | null;
    total: number | null;
    checkedAt: string | null;
    downloadedAt: string | null;
    errorCode: string | null;
  }

  interface Window {
    tokenCat?: {
      minimize: () => void;
      hide: () => void;
      quit: () => void;
      openSettings: (
        category?: "general" | "dashboard" | "accounts" | "appearance",
      ) => Promise<boolean>;
      closeSettings: () => Promise<boolean>;
      openOnboarding: (options?: {
        firstRun?: boolean;
      }) => Promise<boolean>;
      closeOnboarding: (
        result: "dismissed" | "completed",
      ) => Promise<boolean>;
      completeOnboarding: () => Promise<boolean>;
      togglePin: () => Promise<boolean>;
      toggleMaximize: () => Promise<boolean>;
      setWindowLayout: (
        layout: WindowLayout,
        compact: boolean,
        quotaOnly: boolean,
        widgetScale: number,
        accountCount: number,
        cardSurfaceMode: WindowCardSurfaceMode,
        minimal: boolean,
        minimalOrientation?: MinimalOrientation,
        transitionSource?: "manual" | "auto-resize",
      ) => Promise<void>;
      applyMainWindowLayout: (
        layout: WindowLayout,
        compact: boolean,
        quotaOnly: boolean,
        widgetScale: number,
        cardSurfaceMode: WindowCardSurfaceMode,
        minimal: boolean,
        minimalOrientation?: MinimalOrientation,
      ) => Promise<boolean>;
      setWindowSizeLocked: (
        enabled: boolean,
      ) => Promise<WindowSizeState>;
      saveCurrentWindowSize: () => Promise<WindowSizeState>;
      resetSavedWindowSize: () => Promise<WindowSizeState>;
      setWindowTransparency: (
        preferences: WindowTransparencyPreferences,
      ) => Promise<WindowTransparencyPreferences>;
      getSettings: () => Promise<WindowSizeState & {
        alwaysOnTop: boolean;
        maximized: boolean;
        openAtLogin: boolean;
        version: string;
        packaged: boolean;
        layout: WindowLayout;
        compact: boolean;
        minimal: boolean;
        minimalOrientation: MinimalOrientation;
        quotaOnly: boolean;
        widgetScale: number;
        cardSurfaceMode: WindowCardSurfaceMode;
        windowOpacity: number;
        transparencyMode: WindowTransparencyMode;
        backgroundOnlyTransparencySupported: boolean;
        language: "ko" | "en";
      }>;
      setLanguage: (language: "ko" | "en") => Promise<"ko" | "en">;
      setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
      getUpdateState: () => Promise<AppUpdateState>;
      checkForUpdates: () => Promise<AppUpdateState>;
      installUpdate: () => Promise<boolean>;
      openUpdateDownloadPage: () => Promise<boolean>;
      onUpdateStateChanged: (
        callback: (state: AppUpdateState) => void,
      ) => () => void;
      getIntegrationStatus: () => Promise<IntegrationSnapshot[]>;
      connectIntegration: (
        provider: IntegrationProvider,
      ) => Promise<IntegrationSnapshot>;
      reauthenticateIntegration: (
        provider: "claude",
      ) => Promise<IntegrationSnapshot>;
      disconnectIntegration: (
        provider: IntegrationProvider,
      ) => Promise<IntegrationSnapshot>;
      refreshIntegration: (
        provider: IntegrationProvider,
      ) => Promise<IntegrationSnapshot>;
      refreshIntegrations: () => Promise<IntegrationSnapshot[]>;
      getManagedIntegrationStatus: () => Promise<
        IntegrationSnapshot[]
      >;
      createManagedIntegration: (input: {
        provider: IntegrationProvider;
        label: string;
      }) => Promise<IntegrationSnapshot>;
      startManagedIntegrationLogin: (
        accountId: string,
      ) => Promise<IntegrationSnapshot>;
      removeManagedIntegration: (
        accountId: string,
      ) => Promise<boolean>;
      openManagedIntegration: (
        accountId: string,
      ) => Promise<boolean>;
      refreshManagedIntegration: (
        accountId: string,
      ) => Promise<IntegrationSnapshot>;
      refreshManagedIntegrations: () => Promise<
        IntegrationSnapshot[]
      >;
      onIntegrationSnapshot: (
        callback: (snapshot: IntegrationSnapshot) => void,
      ) => () => void;
      onPinChanged: (callback: (value: boolean) => void) => () => void;
      onMaximizedChanged: (
        callback: (value: boolean) => void,
      ) => () => void;
      onWindowSizeStateChanged: (
        callback: (value: WindowSizeState) => void,
      ) => () => void;
      onWindowTransparencyChanged: (
        callback: (value: WindowTransparencyPreferences) => void,
      ) => () => void;
      onOpenSettings: (
        callback: (
          category: "general" | "dashboard" | "accounts" | "appearance",
        ) => void,
      ) => () => void;
      onOnboardingAccountRequested: (
        callback: (provider: "Claude" | "Codex") => void,
      ) => () => void;
    };
    tokenCatOnboarding?: {
      getInfo: () => Promise<{
        version: string;
        language: "ko" | "en";
      }>;
      close: (
        result: "dismissed" | "completed",
      ) => Promise<boolean>;
      begin: (provider: "Claude" | "Codex") => Promise<boolean>;
    };
  }
}
