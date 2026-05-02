import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTION_PATTERNS,
  buildAutopilotContext,
  buildInteractionAskUserActionShape,
  buildLocalSessionSummary,
  detectDeferral,
  escalationAttemptReasonCode,
  normalizeAutopilotDeferralConfig,
  pickDecisionCategory,
  pickDecisionKind,
  pickUrgencyBucket,
  questionCategoryForPattern,
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

  it("ignores plain assertions, generic closers, and code-fenced rhetorical questions", () => {
    const config = defaultConfig();

    expect(detectDeferral("I updated the tests and will continue.", config.patterns)).toEqual({
      matched: false,
      matchedPatternKey: null,
    });
    expect(detectDeferral("Let me know if you need anything else.", config.patterns)).toEqual({
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
    expect(config.idleThresholdMs).toBe(30_000);
    expect(config.nudgeCooldownMs).toBe(5_000);
    expect(config.maxConsecutiveNudges).toBe(4);
    expect(config.hostedAutopilotContextEnabled).toBe(true);
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

  it("uses SDK ask-user action shape and derived categorization helpers", () => {
    const questionCategory = questionCategoryForPattern("please_confirm");
    const actionShape = buildInteractionAskUserActionShape({
      questionCategory,
      recentToolContext: {
        last_tool_kind: "edit",
        last_tool_outcome: "failed",
        turns_since: 1,
      },
    });

    expect(actionShape).toEqual({
      tool_kind: "interaction.ask_user",
      question_category: "approval_request",
      recent_tool_context: {
        last_tool_kind: "edit",
        last_tool_outcome: "failed",
        turns_since: 1,
      },
    });
    expect(pickDecisionKind()).toBe("would_have_asked");
    expect(pickDecisionCategory()).toBe("unknown");
    expect(pickDecisionCategory(questionCategory)).toBe("other");
    expect(pickDecisionCategory(questionCategoryForPattern("should_i"))).toBe("scope");
    expect(escalationAttemptReasonCode("try_alternative", "failed")).toBe("try_alternative_failed");
  });

  it("builds privacy-safe autopilot context from SDK-owned classifier facts", () => {
    const context = buildAutopilotContext({
      classifiedAction: {
        outcome: "notable",
        reasonCode: "ask_user_baseline",
        source: "deterministic",
        toolKind: "interaction.ask_user",
      },
      policy: {
        classifierVersion: "1.1.0",
        latitude: "cautious",
        escalationStrategy: ["try_alternative", "defer_for_human_review"],
        sandboxPreference: "preferred",
      },
      capabilities: {
        classifierVersion: "1.1.0",
        capturedAt: "2026-04-28T10:00:00.000Z",
        sandbox: {
          available: false,
          fsIsolation: "none",
          networkIsolation: "none",
          identityIsolation: "none",
        },
        toolKinds: ["bash", "edit", "webfetch", "mcp", "computer_use"],
      },
      attempts: [
        {
          step: "defer_for_human_review",
          outcome: "deferred",
          reasonCode: "defer_for_human_review_deferred",
        },
      ],
      classifierDecisionId: "decision_abcdef1234567890",
    });

    expect(context).toEqual({
      classifier_version: "1.1.0",
      tool_kind: "interaction.ask_user",
      classification_outcome: "notable",
      classifier_reason_code: "ask_user_baseline",
      classifier_source: "deterministic",
      latitude_at_decision: "cautious",
      sandbox_preference: "preferred",
      classifier_decision_id: "decision_abcdef1234567890",
      capability_summary: {
        sandbox_available: false,
        sandbox_stale: false,
        fs_isolation: "none",
        network_isolation: "none",
        identity_isolation: "none",
      },
      escalation_attempts: [
        {
          step: "defer_for_human_review",
          outcome: "deferred",
          reason_code: "defer_for_human_review_deferred",
        },
      ],
    });
    expect(JSON.stringify(context)).not.toContain("/private/repo");
  });
});
