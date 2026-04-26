import { describe, it, expect } from "vitest";
import {
  applyTrustPolicy,
  decideAutoThinking,
  isSensitivePath,
  matchGlob,
  formatSummary,
  formatWrapUpInstruction,
  normalizeAutoThinkingConfig,
  type AutoThinkingConfig,
} from "../extensions/headsdown/policy.js";
import type { Contract } from "@headsdown/sdk";

type CalendarContext = {
  automateEndOfDay: boolean;
  automateStartOfDay: boolean;
  day: string;
  endsAt: string;
  nextWorkday: string;
  nextWorkdayStartsAt: string;
  now: string;
  offHours: boolean;
  startsAt: string;
  workHours: boolean;
  working: boolean;
};

// === applyTrustPolicy ===

describe("applyTrustPolicy", () => {
  // --- Advisory mode: never blocks ---

  describe("advisory trust level", () => {
    const trust = "advisory" as const;

    it.each([
      ["online", false, false],
      ["online", false, true],
      ["busy", false, false],
      ["busy", false, true],
      ["busy", true, false],
      ["busy", true, true],
      ["limited", false, false],
      ["limited", false, true],
      ["offline", false, false],
      ["offline", false, true],
      ["none", false, false],
    ])("never blocks for mode=%s, locked=%s, hasProposal=%s", (mode, locked, hasProposal) => {
      expect(applyTrustPolicy(trust, mode, locked, hasProposal)).toBeUndefined();
    });
  });

  // --- Active mode: blocks locked + offline-without-proposal ---

  describe("active trust level", () => {
    const trust = "active" as const;

    it("allows online mode", () => {
      expect(applyTrustPolicy(trust, "online", false, false)).toBeUndefined();
    });

    it("allows busy mode without lock", () => {
      expect(applyTrustPolicy(trust, "busy", false, false)).toBeUndefined();
    });

    it("allows busy mode with proposal", () => {
      expect(applyTrustPolicy(trust, "busy", false, true)).toBeUndefined();
    });

    it("blocks busy mode when locked", () => {
      const result = applyTrustPolicy(trust, "busy", true, false);
      expect(result).toEqual({ block: true, reason: expect.stringContaining("locked") });
    });

    it("blocks locked even with proposal", () => {
      const result = applyTrustPolicy(trust, "busy", true, true);
      expect(result).toEqual({ block: true, reason: expect.stringContaining("locked") });
    });

    it("allows limited mode", () => {
      expect(applyTrustPolicy(trust, "limited", false, false)).toBeUndefined();
    });

    it("blocks offline without proposal", () => {
      const result = applyTrustPolicy(trust, "offline", false, false);
      expect(result).toEqual({ block: true, reason: expect.stringContaining("offline") });
    });

    it("allows offline with proposal", () => {
      expect(applyTrustPolicy(trust, "offline", false, true)).toBeUndefined();
    });

    it("blocks offline+locked even with proposal", () => {
      const result = applyTrustPolicy(trust, "offline", true, true);
      expect(result).toEqual({ block: true, reason: expect.stringContaining("locked") });
    });
  });

  // --- Guarded mode: requires proposals for busy/limited/offline ---

  describe("guarded trust level", () => {
    const trust = "guarded" as const;

    it("allows online mode without proposal", () => {
      expect(applyTrustPolicy(trust, "online", false, false)).toBeUndefined();
    });

    it("blocks busy without proposal", () => {
      const result = applyTrustPolicy(trust, "busy", false, false);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("No approved proposal"),
      });
      expect(result!.reason).toContain("busy");
    });

    it("allows busy with proposal", () => {
      expect(applyTrustPolicy(trust, "busy", false, true)).toBeUndefined();
    });

    it("blocks busy+locked even with proposal", () => {
      const result = applyTrustPolicy(trust, "busy", true, true);
      expect(result).toEqual({ block: true, reason: expect.stringContaining("locked") });
    });

    it("blocks limited without proposal", () => {
      const result = applyTrustPolicy(trust, "limited", false, false);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("limited"),
      });
    });

    it("allows limited with proposal", () => {
      expect(applyTrustPolicy(trust, "limited", false, true)).toBeUndefined();
    });

    it("blocks offline without proposal", () => {
      const result = applyTrustPolicy(trust, "offline", false, false);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("offline"),
      });
    });

    it("blocks offline with proposal (still requires permission)", () => {
      // In guarded mode, offline with proposal is allowed (proposal satisfies the requirement)
      expect(applyTrustPolicy(trust, "offline", false, true)).toBeUndefined();
    });
  });

  // --- Unknown trust level ---

  it("returns undefined for unknown trust level", () => {
    expect(applyTrustPolicy("unknown" as any, "busy", true, false)).toBeUndefined();
  });

  // --- Block reasons always include [HeadsDown] prefix ---

  it("all block reasons include [HeadsDown] prefix", () => {
    const testCases: Array<[string, string, boolean, boolean]> = [
      ["active", "busy", true, false],
      ["active", "offline", false, false],
      ["guarded", "busy", true, false],
      ["guarded", "busy", false, false],
      ["guarded", "limited", false, false],
      ["guarded", "offline", false, false],
    ];

    for (const [trust, mode, locked, hasProposal] of testCases) {
      const result = applyTrustPolicy(trust as any, mode, locked, hasProposal);
      expect(result).toBeTruthy();
      expect(result!.reason).toMatch(/^\[HeadsDown\]/);
    }
  });
});

// === Auto-thinking policy ===

describe("normalizeAutoThinkingConfig", () => {
  it("defaults to disabled and conservative options", () => {
    expect(normalizeAutoThinkingConfig(undefined)).toEqual({
      enabled: false,
      maxLevel: "high",
      respectManualChanges: true,
      showStatus: true,
      allowDowngrade: false,
    });
  });

  it("accepts valid user options", () => {
    expect(
      normalizeAutoThinkingConfig({
        enabled: true,
        maxLevel: "medium",
        respectManualChanges: false,
        showStatus: false,
        allowDowngrade: true,
      }),
    ).toEqual({
      enabled: true,
      maxLevel: "medium",
      respectManualChanges: false,
      showStatus: false,
      allowDowngrade: true,
    });
  });

  it("falls back for invalid values without rejecting the whole config", () => {
    expect(
      normalizeAutoThinkingConfig({
        enabled: true,
        maxLevel: "expensive",
        respectManualChanges: "yes",
        showStatus: false,
        allowDowngrade: "no",
      }),
    ).toEqual({
      enabled: true,
      maxLevel: "high",
      respectManualChanges: true,
      showStatus: false,
      allowDowngrade: false,
    });
  });
});

describe("decideAutoThinking", () => {
  const enabledConfig: AutoThinkingConfig = {
    enabled: true,
    maxLevel: "high",
    respectManualChanges: true,
    showStatus: true,
    allowDowngrade: false,
  };

  it("returns no change when auto-thinking is disabled", () => {
    const decision = decideAutoThinking({
      prompt: "Debug this failure",
      currentLevel: "minimal",
      config: { ...enabledConfig, enabled: false },
      mode: "offline",
    });

    expect(decision).toEqual({ level: null, reason: "disabled", status: null });
  });

  it.each([
    ["quick explain this", "minimal", null, null, false, "low"],
    ["Implement this API change", "minimal", null, null, false, "medium"],
    ["Investigate this flaky concurrency failure", "minimal", null, null, false, "high"],
    ["quick summary", "minimal", "busy", null, false, "high"],
    ["quick summary", "minimal", "limited", null, false, "medium"],
    ["quick summary", "minimal", "offline", null, false, "high"],
    ["quick summary", "minimal", null, false, false, "high"],
    ["quick summary", "minimal", null, true, true, "medium"],
    ["quick summary", "minimal", null, true, false, "low"],
  ])(
    "selects %s with current=%s mode=%s reachable=%s proposal=%s",
    (prompt, currentLevel, mode, inReachableHours, hasActiveProposal, expectedLevel) => {
      const decision = decideAutoThinking({
        prompt,
        currentLevel: currentLevel as never,
        config: enabledConfig,
        mode,
        inReachableHours,
        hasActiveProposal,
      });

      expect(decision.level).toBe(expectedLevel);
      expect(decision.status).toBe(`thinking:auto ${expectedLevel}`);
    },
  );

  it("caps the selected level at maxLevel", () => {
    const decision = decideAutoThinking({
      prompt: "Investigate this flaky concurrency failure",
      currentLevel: "minimal",
      config: { ...enabledConfig, maxLevel: "medium" },
    });

    expect(decision.level).toBe("medium");
    expect(decision.status).toBe("thinking:auto medium");
  });

  it("preserves a manual thinking change when configured", () => {
    const decision = decideAutoThinking({
      prompt: "Implement this API change",
      currentLevel: "high",
      lastAutoLevel: "low",
      config: enabledConfig,
    });

    expect(decision).toEqual({
      level: null,
      reason: "manual_preserved",
      status: "thinking:manual high",
    });
  });

  it("overrides a manual thinking change when respectManualChanges is disabled", () => {
    const decision = decideAutoThinking({
      prompt: "Implement this API change",
      currentLevel: "high",
      lastAutoLevel: "low",
      config: { ...enabledConfig, respectManualChanges: false, allowDowngrade: true },
    });

    expect(decision.level).toBe("medium");
  });

  it("does not downgrade by default", () => {
    const decision = decideAutoThinking({
      prompt: "quick summary",
      currentLevel: "high",
      config: enabledConfig,
    });

    expect(decision).toEqual({
      level: null,
      reason: "downgrade_skipped",
      status: "thinking:auto high",
    });
  });

  it("does not request a change when the selected level already matches", () => {
    const decision = decideAutoThinking({
      prompt: "Implement this API change",
      currentLevel: "medium",
      config: enabledConfig,
    });

    expect(decision).toEqual({
      level: null,
      reason: "already_selected",
      status: "thinking:auto medium",
    });
  });

  it("omits status feedback when showStatus is disabled", () => {
    const decision = decideAutoThinking({
      prompt: "Investigate this flaky concurrency failure",
      currentLevel: "minimal",
      config: { ...enabledConfig, showStatus: false },
    });

    expect(decision.level).toBe("high");
    expect(decision.status).toBeNull();
  });

  it("uses full-depth wrap-up guidance as a high-thinking signal", () => {
    const decision = decideAutoThinking({
      prompt: "quick summary",
      currentLevel: "minimal",
      config: enabledConfig,
      wrapUpSelectedMode: "full_depth",
    });

    expect(decision.level).toBe("high");
  });
});

// === isSensitivePath ===

describe("isSensitivePath", () => {
  describe("default patterns", () => {
    it.each([
      ".env",
      ".env.local",
      ".env.production",
      "config/.env",
      ".ssh/id_rsa",
      ".ssh/config",
      "deep/path/.ssh/authorized_keys",
      "app/secrets/api_key.txt",
      "app/secret/tokens.json",
      "package.json",
      "package-lock.json",
      ".npmrc",
      ".pypirc",
      "Dockerfile",
      "Dockerfile.prod",
      "docker-compose.yml",
      "docker-compose.override.yml",
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      "Makefile",
      "app/config/credentials.yml",
      "lib/id_rsa_deploy",
      "keys/id_ed25519",
      ".ssh/authorized_keys",
      ".ssh/known_hosts",
    ])("matches sensitive path: %s", (path) => {
      expect(isSensitivePath(path, [])).toBe(true);
    });

    it.each([
      "src/index.ts",
      "README.md",
      "lib/auth/handler.ts",
      "test/fixtures.json",
      "src/components/Button.tsx",
      "docs/api.md",
      "package-info.txt",
      "my-docker-notes.md",
    ])("does not match safe path: %s", (path) => {
      expect(isSensitivePath(path, [])).toBe(false);
    });
  });

  describe("user patterns", () => {
    it("matches user-configured glob patterns", () => {
      expect(isSensitivePath("config/production.yml", ["config/*.yml"])).toBe(true);
    });

    it("matches ** for deep paths", () => {
      expect(isSensitivePath("deep/nested/secret.key", ["**/*.key"])).toBe(true);
    });

    it("does not match non-matching patterns", () => {
      expect(isSensitivePath("src/index.ts", ["*.json"])).toBe(false);
    });

    it("combines default and user patterns", () => {
      // Default pattern matches
      expect(isSensitivePath(".env", ["custom/*"])).toBe(true);
      // User pattern matches
      expect(isSensitivePath("custom/file.txt", ["custom/*"])).toBe(true);
      // Neither matches
      expect(isSensitivePath("src/safe.ts", ["custom/*"])).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty path", () => {
      expect(isSensitivePath("", [])).toBe(false);
    });

    it("handles empty user patterns array", () => {
      expect(isSensitivePath("src/index.ts", [])).toBe(false);
    });
  });
});

// === matchGlob ===

describe("matchGlob", () => {
  it("matches exact paths", () => {
    expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/index.ts", "src/other.ts")).toBe(false);
  });

  it("matches * within a segment", () => {
    expect(matchGlob("*.ts", "index.ts")).toBe(true);
    expect(matchGlob("*.ts", "dir/index.ts")).toBe(false);
    expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/deep/index.ts")).toBe(false);
  });

  it("matches ** across segments", () => {
    expect(matchGlob("**/*.ts", "src/deep/index.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(matchGlob("src/**", "src/anything/at/all")).toBe(true);
  });

  it("matches ? for single character", () => {
    expect(matchGlob("file?.ts", "file1.ts")).toBe(true);
    expect(matchGlob("file?.ts", "file12.ts")).toBe(false);
  });

  it("escapes regex special characters in patterns", () => {
    expect(matchGlob("file.ts", "file.ts")).toBe(true);
    expect(matchGlob("file.ts", "fileXts")).toBe(false);
    expect(matchGlob("test(1).ts", "test(1).ts")).toBe(true);
  });

  it("rejects patterns longer than 200 chars", () => {
    const longPattern = "a".repeat(201);
    expect(matchGlob(longPattern, "a")).toBe(false);
  });

  it("handles invalid patterns gracefully", () => {
    // Patterns that could cause regex errors are caught
    expect(matchGlob("[invalid", "test")).toBe(false);
  });

  it("anchors to full path (no partial matches)", () => {
    expect(matchGlob("index.ts", "src/index.ts")).toBe(false);
    expect(matchGlob("src/*", "src/index.ts/extra")).toBe(false);
  });
});

// === formatSummary ===

describe("formatWrapUpInstruction", () => {
  it("returns null when guidance is inactive", () => {
    const instruction = formatWrapUpInstruction({
      active: false,
      deadlineAt: null,
      remainingMinutes: null,
      profile: "normal",
      source: "inactive",
      reason: "",
      hints: [],
      thresholdMinutes: 30,
      selectedMode: "auto",
    });

    expect(instruction).toBeNull();
  });

  it("returns cold-start wrap_up instruction with context", () => {
    const instruction = formatWrapUpInstruction({
      active: true,
      deadlineAt: "2026-04-22T01:00:00Z",
      remainingMinutes: 14,
      profile: "wrap_up",
      source: "threshold",
      reason: "Approaching end of focus window",
      hints: ["Summarize progress", "Leave handoff notes"],
      thresholdMinutes: 30,
      selectedMode: "wrap_up",
    });

    expect(instruction).toContain("Execution policy for this task");
    expect(instruction).toContain("keep scope minimal");
    expect(instruction).toContain("About 14 minutes remain");
    expect(instruction).toContain("Reason: Approaching end of focus window");
  });

  it("returns cold-start full_depth instruction", () => {
    const instruction = formatWrapUpInstruction({
      active: true,
      deadlineAt: "2026-04-22T01:00:00Z",
      remainingMinutes: 40,
      profile: "normal",
      source: "forced_full_depth",
      reason: "",
      hints: [],
      thresholdMinutes: 30,
      selectedMode: "full_depth",
    });

    expect(instruction).toContain("Execution policy for this task");
    expect(instruction).toContain("full implementation depth");
  });
});

describe("formatSummary", () => {
  const baseCalendar: CalendarContext = {
    automateEndOfDay: true,
    automateStartOfDay: true,
    day: "wednesday",
    endsAt: "2025-06-15T17:00:00Z",
    nextWorkday: "thursday",
    nextWorkdayStartsAt: "2025-06-16T09:00:00Z",
    now: "2025-06-15T14:00:00Z",
    offHours: false,
    startsAt: "2025-06-15T09:00:00Z",
    workHours: true,
    working: true,
  };

  it("handles no contract", () => {
    const summary = formatSummary(null, baseCalendar);
    expect(summary).toContain("No active availability contract");
    expect(summary).toContain("work hours");
  });

  it("includes mode", () => {
    const contract: Contract = {
      id: "1",
      mode: "busy",
      status: true,
      statusEmoji: null,
      statusText: null,
      autoRespond: false,
      lock: false,
      duration: null,
      ruleSetType: null,
      ruleSetParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      insertedAt: "2025-06-15T14:00:00Z",
    };

    const summary = formatSummary(contract, baseCalendar);
    expect(summary).toContain("Mode: busy");
  });

  it("includes status with emoji", () => {
    const contract: Contract = {
      id: "1",
      mode: "busy",
      status: true,
      statusEmoji: "🔨",
      statusText: "Deep work",
      autoRespond: false,
      lock: false,
      duration: null,
      ruleSetType: null,
      ruleSetParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      insertedAt: "2025-06-15T14:00:00Z",
    };

    const summary = formatSummary(contract, baseCalendar);
    expect(summary).toContain("🔨 Deep work");
  });

  it("includes time remaining when positive", () => {
    const contract: Contract = {
      id: "1",
      mode: "busy",
      status: true,
      statusEmoji: null,
      statusText: null,
      autoRespond: false,
      lock: false,
      duration: null,
      ruleSetType: null,
      ruleSetParams: null,
      expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      insertedAt: "2025-06-15T14:00:00Z",
    };

    const summary = formatSummary(contract, baseCalendar);
    expect(summary).toMatch(/\d+min remaining/);
  });

  it("omits time remaining when expired", () => {
    const contract: Contract = {
      id: "1",
      mode: "busy",
      status: true,
      statusEmoji: null,
      statusText: null,
      autoRespond: false,
      lock: false,
      duration: null,
      ruleSetType: null,
      ruleSetParams: null,
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      insertedAt: "2025-06-15T14:00:00Z",
    };

    const summary = formatSummary(contract, baseCalendar);
    expect(summary).not.toContain("remaining");
  });

  it("includes locked flag", () => {
    const contract: Contract = {
      id: "1",
      mode: "offline",
      status: true,
      statusEmoji: null,
      statusText: null,
      autoRespond: false,
      lock: true,
      duration: null,
      ruleSetType: null,
      ruleSetParams: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      insertedAt: "2025-06-15T14:00:00Z",
    };

    const summary = formatSummary(contract, baseCalendar);
    expect(summary).toContain("locked");
  });

  it("shows off-hours info", () => {
    const offHoursCal: CalendarContext = { ...baseCalendar, offHours: true, workHours: false };
    const summary = formatSummary(null, offHoursCal);
    expect(summary).toContain("off-hours");
    expect(summary).toContain("thursday");
  });

  it("handles schedule-based availability context", () => {
    const summary = formatSummary(null, {
      inReachableHours: false,
      nextTransitionAt: "2025-06-15T17:00:00Z",
    });
    expect(summary).toContain("outside reachable hours");
    expect(summary).toContain("next transition");
  });

  it("includes Wrap-Up guidance when active in schedule context", () => {
    const summary = formatSummary(null, {
      inReachableHours: true,
      wrapUpGuidance: { active: true, remainingMinutes: 18 },
    } as never);

    expect(summary).toContain("Wrap-Up");
    expect(summary).toContain("18min left");
  });
});
