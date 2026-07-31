const ONBOARDING_SCHEMA_VERSION = 1;
const DEFAULT_ONBOARDING_STATUS = "unseen";
const ONBOARDING_STATUSES = new Set([
  "unseen",
  "pending",
  "in-progress",
  "dismissed",
  "completed",
]);
const AUTO_START_ONBOARDING_STATUSES = new Set([
  "unseen",
  "pending",
  "in-progress",
]);
const RESUMABLE_ONBOARDING_STATUSES = new Set([
  "pending",
  "in-progress",
]);

const ALLOWED_ONBOARDING_TRANSITIONS = {
  unseen: new Set([
    "pending",
    "in-progress",
    "dismissed",
    "completed",
  ]),
  pending: new Set([
    "in-progress",
    "dismissed",
    "completed",
  ]),
  "in-progress": new Set(["pending", "dismissed", "completed"]),
  dismissed: new Set(),
  completed: new Set(),
};

function defaultOnboardingState() {
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status: DEFAULT_ONBOARDING_STATUS,
  };
}

function futureSchemaFallbackState() {
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status: "completed",
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOnboardingStatus(value) {
  return ONBOARDING_STATUSES.has(value);
}

function normalizeOnboardingState(value) {
  if (!isRecord(value)) return defaultOnboardingState();

  if (
    Number.isInteger(value.schemaVersion) &&
    value.schemaVersion > ONBOARDING_SCHEMA_VERSION
  ) {
    // A downgraded app must not restart an onboarding flow whose newer
    // schema it cannot understand.
    return futureSchemaFallbackState();
  }

  if (
    value.schemaVersion !== ONBOARDING_SCHEMA_VERSION ||
    !isOnboardingStatus(value.status)
  ) {
    return defaultOnboardingState();
  }

  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status: value.status,
  };
}

function canAutoStartOnboarding(value) {
  const status = isOnboardingStatus(value)
    ? value
    : normalizeOnboardingState(value).status;
  return AUTO_START_ONBOARDING_STATUSES.has(status);
}

function canCompleteOnboarding(value) {
  const status = isOnboardingStatus(value)
    ? value
    : normalizeOnboardingState(value).status;
  return status === "in-progress";
}

function canResumeOnboarding(value) {
  const status = isOnboardingStatus(value)
    ? value
    : normalizeOnboardingState(value).status;
  return RESUMABLE_ONBOARDING_STATUSES.has(status);
}

function transitionOnboardingState(currentState, nextStatus) {
  const current = normalizeOnboardingState(currentState);
  if (!isOnboardingStatus(nextStatus)) return current;
  if (nextStatus === current.status) return current;
  if (!ALLOWED_ONBOARDING_TRANSITIONS[current.status].has(nextStatus)) {
    return current;
  }
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    status: nextStatus,
  };
}

module.exports = {
  DEFAULT_ONBOARDING_STATUS,
  ONBOARDING_SCHEMA_VERSION,
  canAutoStartOnboarding,
  canCompleteOnboarding,
  canResumeOnboarding,
  isOnboardingStatus,
  normalizeOnboardingState,
  transitionOnboardingState,
};
