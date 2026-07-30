export const ACCOUNT_STORAGE_KEY = "tokencat-desktop-accounts";

export type AccountStorageStatus = "missing" | "valid" | "invalid";

export type AccountBootstrapResult = {
  status: AccountStorageStatus;
  accounts: unknown[];
  shouldStartOnboarding: boolean;
};

function isStoredAccountCandidate(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const provider = (value as { provider?: unknown }).provider;
  return provider === "Claude" || provider === "Codex";
}

export function parseAccountStorage(
  stored: string | null,
): AccountBootstrapResult {
  if (stored === null) {
    return {
      status: "missing",
      accounts: [],
      shouldStartOnboarding: true,
    };
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return {
        status: "invalid",
        accounts: [],
        shouldStartOnboarding: false,
      };
    }

    return {
      status: "valid",
      accounts: parsed.filter(isStoredAccountCandidate),
      shouldStartOnboarding: false,
    };
  } catch {
    return {
      status: "invalid",
      accounts: [],
      shouldStartOnboarding: false,
    };
  }
}
