import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTION_PATTERNS,
  buildLocalSessionSummary,
  detectDeferral,
  normalizeAutopilotDeferralConfig,
  pickDecisionCategory,
  pickDecisionKind,
  pickUrgencyBucket,
} from "../extensions/headsdown/autopilot-deferral.js";

function defaultConfig() {
  return normalizeAutopilotDeferralConfig(undefined);
}

describe("autopilot deferral detection", () => {
  it("matches each default human-input pattern", () => {
    const config = defaultConfig();
    const samplesByKey = new Map([
      ["explicit_defer_marker", "[DEFER] Need a human choice before continuing."],
      ["should_i", "Should I update the tests as well?"],
      ["would_you_like", "Would you like me to keep this backwards compatible?"],
      ["do_you_want", "Do you want me to remove the old option?"],
      ["let_me_know", "Let me know which path you prefer."],
      ["please_confirm", "Please confirm before I publish this."],
      ["which_would_you_prefer", "Which would you prefer for the default?"],
      ["trailing_second_person_question", "I can take either path. What works for you?"],
    ]);

    expect(DEFAULT_DETECTION_PATTERNS.map((pattern) => pattern.key)).toEqual([
      ...samplesByKey.keys(),
    ]);

    for (const [key, sample] of samplesByKey.entries()) {
      expect(detectDeferral(sample, config.patterns)).toEqual({
        matched: true,
        matchedPatternKey: key,
      });
    }
  });

  it("ignores plain assertions and code-fenced rhetorical questions", () => {
    const config = defaultConfig();

    expect(detectDeferral("I updated the tests and will continue.", config.patterns)).toEqual({
      matched: false,
      matchedPatternKey: null,
    });
    expect(
      detectDeferral(
        "```ts\nconst example = 'Do you want this?';\n```\nContinuing now.",
        config.patterns,
      ),
    ).toEqual({ matched: false, matchedPatternKey: null });
  });

  it("normalizes disabled config without losing safe defaults", () => {
    const config = normalizeAutopilotDeferralConfig({ enabled: false });

    expect(config.enabled).toBe(false);
    expect(config.patterns.length).toBeGreaterThan(0);
  });

  it("honors custom patterns and drops invalid regexes without throwing", () => {
    const config = normalizeAutopilotDeferralConfig({
      defaultUrgencyBucket: "high",
      patterns: [
        { key: "custom_marker", pattern: "NEEDS_DECISION" },
        { key: "broken", pattern: "[" },
      ],
    });

    expect(config.patterns.map((pattern) => pattern.key)).toEqual(["custom_marker"]);
    expect(detectDeferral("NEEDS_DECISION", config.patterns)).toEqual({
      matched: true,
      matchedPatternKey: "custom_marker",
    });
    expect(detectDeferral("Should I pick a default?", config.patterns)).toEqual({
      matched: false,
      matchedPatternKey: null,
    });
    expect(pickUrgencyBucket(config)).toBe("high");
  });

  it("treats an explicitly empty or invalid custom pattern set as no detection", () => {
    const emptyConfig = normalizeAutopilotDeferralConfig({ patterns: [] });
    const invalidConfig = normalizeAutopilotDeferralConfig({
      patterns: [{ key: "broken", pattern: "[" }],
    });

    expect(emptyConfig.patterns).toEqual([]);
    expect(invalidConfig.patterns).toEqual([]);
    expect(detectDeferral("Should I pick a default?", emptyConfig.patterns)).toEqual({
      matched: false,
      matchedPatternKey: null,
    });
    expect(detectDeferral("Please confirm the default.", invalidConfig.patterns)).toEqual({
      matched: false,
      matchedPatternKey: null,
    });
  });

  it("builds validated local session summaries from derived counters only", () => {
    const summary = buildLocalSessionSummary({
      runId: "run_ABC-123",
      approvedProposalId: "proposal-1",
      toolCallCount: 4,
      fileChangeCount: 2,
      deferredDecisionCount: 1,
      continuationArtifactAvailable: true,
      validationLocallyPassed: false,
      now: new Date("2026-04-28T10:00:00.000Z"),
    });

    expect(summary).toEqual({
      version: 1,
      sessionId: "run_abc-123",
      generatedAt: "2026-04-28T10:00:00.000Z",
      stale: false,
      toolCallCount: 4,
      fileChangeCount: 2,
      deferredDecisionCount: 1,
      continuationArtifactAvailable: true,
      validationLocallyPassed: false,
      approvedProposalRef: "proposal-1",
      outcomeCategory: "in_progress",
    });
    expect(JSON.stringify(summary)).not.toContain("/private/repo");
    expect(() =>
      buildLocalSessionSummary({ ...summary, now: new Date("invalid") } as any),
    ).toThrow();
  });

  it("uses v1 default categorization helpers", () => {
    expect(pickDecisionKind()).toBe("would_have_asked");
    expect(pickDecisionCategory()).toBe("unknown");
  });
});
