const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_ONBOARDING_STATUS,
  ONBOARDING_SCHEMA_VERSION,
  canAutoStartOnboarding,
  canCompleteOnboarding,
  canResumeOnboarding,
  isOnboardingStatus,
  normalizeOnboardingState,
  transitionOnboardingState,
} = require("../electron/onboarding.cjs");

const STATUSES = [
  "unseen",
  "pending",
  "in-progress",
  "dismissed",
  "completed",
];

test("onboarding schema and status constants are stable", () => {
  assert.equal(ONBOARDING_SCHEMA_VERSION, 1);
  assert.equal(DEFAULT_ONBOARDING_STATUS, "unseen");
  for (const status of STATUSES) {
    assert.equal(isOnboardingStatus(status), true);
  }
  assert.equal(isOnboardingStatus("complete"), false);
  assert.equal(isOnboardingStatus(undefined), false);
});

test("valid onboarding states normalize without retaining unknown fields", () => {
  for (const status of STATUSES) {
    assert.deepEqual(
      normalizeOnboardingState({
        schemaVersion: 1,
        status,
        ignored: "value",
      }),
      {
        schemaVersion: 1,
        status,
      },
    );
  }
});

test("missing and malformed onboarding states fall back to unseen", () => {
  const malformedValues = [
    undefined,
    null,
    false,
    "pending",
    [],
    {},
    { schemaVersion: 0, status: "completed" },
    { schemaVersion: -1, status: "pending" },
    { schemaVersion: 1.5, status: "pending" },
    { schemaVersion: Number.NaN, status: "pending" },
    { schemaVersion: Number.POSITIVE_INFINITY, status: "pending" },
    { schemaVersion: "1", status: "pending" },
    { schemaVersion: 1 },
    { schemaVersion: 1, status: "unknown" },
  ];

  for (const value of malformedValues) {
    assert.deepEqual(normalizeOnboardingState(value), {
      schemaVersion: 1,
      status: "unseen",
    });
  }
});

test("future onboarding schemas use a terminal downgrade fallback", () => {
  for (const schemaVersion of [2, 3, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(
      normalizeOnboardingState({
        schemaVersion,
        status: "in-progress",
      }),
      {
        schemaVersion: 1,
        status: "completed",
      },
    );
  }

  assert.equal(
    canAutoStartOnboarding({
      schemaVersion: 2,
      status: "in-progress",
    }),
    false,
  );
});

test("only resumable statuses allow automatic onboarding", () => {
  const expected = {
    unseen: true,
    pending: true,
    "in-progress": true,
    dismissed: false,
    completed: false,
  };

  for (const status of STATUSES) {
    assert.equal(canAutoStartOnboarding(status), expected[status]);
    assert.equal(
      canAutoStartOnboarding({ schemaVersion: 1, status }),
      expected[status],
    );
  }
});

test("only an explicit provider handoff can complete onboarding", () => {
  for (const status of STATUSES) {
    const expected = status === "in-progress";
    assert.equal(canCompleteOnboarding(status), expected);
    assert.equal(
      canCompleteOnboarding({ schemaVersion: 1, status }),
      expected,
    );
  }
});

test("only interrupted first-run states resume automatically", () => {
  const resumable = new Set(["pending", "in-progress"]);
  for (const status of STATUSES) {
    assert.equal(canResumeOnboarding(status), resumable.has(status));
    assert.equal(
      canResumeOnboarding({ schemaVersion: 1, status }),
      resumable.has(status),
    );
  }
});

test("onboarding transitions follow the safe state graph", () => {
  const allowed = {
    unseen: ["pending", "in-progress", "dismissed", "completed"],
    pending: ["in-progress", "dismissed", "completed"],
    "in-progress": ["pending", "dismissed", "completed"],
    dismissed: [],
    completed: [],
  };

  for (const currentStatus of STATUSES) {
    for (const nextStatus of STATUSES) {
      const result = transitionOnboardingState(
        { schemaVersion: 1, status: currentStatus },
        nextStatus,
      );
      const shouldTransition =
        nextStatus === currentStatus ||
        allowed[currentStatus].includes(nextStatus);
      assert.deepEqual(result, {
        schemaVersion: 1,
        status: shouldTransition ? nextStatus : currentStatus,
      });
    }
  }
});

test("invalid transitions are non-throwing and preserve normalized state", () => {
  assert.deepEqual(
    transitionOnboardingState(
      { schemaVersion: 1, status: "pending" },
      "unknown",
    ),
    {
      schemaVersion: 1,
      status: "pending",
    },
  );
  assert.deepEqual(
    transitionOnboardingState(
      { schemaVersion: 1, status: "completed" },
      null,
    ),
    {
      schemaVersion: 1,
      status: "completed",
    },
  );
});

test("transitions do not mutate caller-owned state", () => {
  const current = {
    schemaVersion: 1,
    status: "pending",
    retainedByCaller: true,
  };

  assert.deepEqual(
    transitionOnboardingState(current, "in-progress"),
    {
      schemaVersion: 1,
      status: "in-progress",
    },
  );
  assert.deepEqual(current, {
    schemaVersion: 1,
    status: "pending",
    retainedByCaller: true,
  });
});

test("future schema states cannot be reopened by an older transition helper", () => {
  assert.deepEqual(
    transitionOnboardingState(
      { schemaVersion: 2, status: "in-progress" },
      "pending",
    ),
    {
      schemaVersion: 1,
      status: "completed",
    },
  );
});
