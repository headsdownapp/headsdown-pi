import { describe, expect, it } from "vitest";
import { __internal } from "../extensions/headsdown/index.js";

const proposal = {
  id: "proposal-1",
  decision: "approved" as const,
  description: "Edit /private/repo/src/auth.ts on feature/secret-branch with prompt content",
  evaluatedAt: "2026-04-25T20:00:00Z",
  estimatedFiles: 2,
  estimatedMinutes: 20,
  scopeSummary: "Touch app files",
  sourceRef: "https://github.com/headsdownapp/private/issues/907",
};

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

describe("Pi agent run event payloads", () => {
  it("builds run started events without raw task text, paths, repo names, branches, or URLs", () => {
    const input = __internal.buildStartedEventInput(proposal);
    const serialized = stringify(input);

    expect(input).toMatchObject({
      eventType: "agent_run.started",
      workspaceRef: "unknown",
      source: "pi_skill",
      proposalRef: "proposal-1",
      payload: {
        task_category: "coding_agent_change",
        task_size_bucket: "small",
        started_by: "agent",
        initial_call_key: "good_to_run",
        estimated_minutes_bucket: "15_to_30",
        estimated_files_bucket: "1_to_2",
      },
    });
    expect(serialized).not.toContain("/private/repo");
    expect(serialized).not.toContain("feature/secret-branch");
    expect(serialized).not.toContain("github.com");
    expect(serialized).not.toContain("prompt content");
  });

  it("builds progress and scope drift events from counts and buckets only", () => {
    const telemetry = {
      runId: __internal.runIdForProposal("proposal-1"),
      proposalId: "proposal-1",
      startedAt: Date.now() - 10_000,
      sequence: 2,
      toolCallsCount: 4,
      toolReadCount: 1,
      toolWriteCount: 2,
      toolExternalCount: 1,
      failureCount: 0,
      retryCount: 0,
      redirectCount: 1,
      filesRead: new Set(["/private/repo/src/auth.ts"]),
      filesModified: new Set(["/private/repo/src/auth.ts", "/private/repo/test/auth_test.ts"]),
      progressState: "working" as const,
      startedReported: true,
      scopeDriftReported: false,
      completedReported: false,
    };

    const progress = __internal.buildProgressEventInput(telemetry, false, 2, 20);
    const drift = __internal.buildScopeDriftEventInput(telemetry, 1);
    const graphqlInput = __internal.serializeAgentRunEventForGraphQL(progress);
    const serialized = stringify({ progress, drift });

    expect(progress).toMatchObject({
      eventType: "agent_run.progress_reported",
      progressPayload: {
        toolCallsCount: 4,
        toolReadCount: 1,
        toolWriteCount: 2,
        filesReadBucket: "1_to_2",
        filesModifiedBucket: "1_to_2",
        scopeChanged: false,
        progressState: "working",
        scopeGrowthBucket: "none",
        confidenceBucket: "low",
      },
    });
    expect(drift).toMatchObject({
      eventType: "scope_drift.detected",
      payload: {
        drift_type: "scope_grew",
        approved_scope_bucket: "1_to_2_files",
        observed_scope_bucket: "1_to_2_files",
        files_touched_count: 2,
      },
    });
    expect(graphqlInput).toMatchObject({
      schemaVersion: 1,
      privacyMode: "METADATA_ONLY",
      progressPayload: {
        filesReadBucket: "_1_TO_2",
        filesModifiedBucket: "_1_TO_2",
        scopeGrowthBucket: "NONE",
        validationStatus: "UNKNOWN",
        confidenceBucket: "LOW",
      },
    });
    expect(graphqlInput.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(String(graphqlInput.occurredAt)).toString()).not.toBe("Invalid Date");
    expect(serialized).not.toContain("/private/repo");
    expect(serialized).not.toContain("auth.ts");
  });

  it("reports validation and ready-for-review progress-state hints without raw command content", () => {
    expect(__internal.progressStateForBashCommand("npm test")).toBe("validating");
    expect(__internal.progressStateForBashCommand("mix compile --warnings-as-errors")).toBe(
      "validating",
    );
    expect(__internal.progressStateForBashCommand("git commit -m public-safe")).toBe(
      "ready_for_review",
    );
    expect(__internal.progressStateForBashCommand("gh pr create --fill")).toBe("ready_for_review");
    expect(__internal.progressStateForBashCommand("rg finish_line_friction")).toBeNull();

    const telemetry = {
      runId: __internal.runIdForProposal("proposal-1"),
      proposalId: "proposal-1",
      startedAt: Date.now() - 10_000,
      sequence: 2,
      toolCallsCount: 4,
      toolReadCount: 1,
      toolWriteCount: 2,
      toolExternalCount: 1,
      failureCount: 0,
      retryCount: 0,
      redirectCount: 1,
      filesRead: new Set(["/private/repo/src/auth.ts"]),
      filesModified: new Set(["/private/repo/src/auth.ts"]),
      progressState: "validating" as const,
      startedReported: true,
      scopeDriftReported: false,
      completedReported: false,
    };

    const progress = __internal.buildProgressEventInput(telemetry, false, 2, 20);
    const graphqlInput = __internal.serializeAgentRunEventForGraphQL(progress);
    const serialized = stringify({ progress, graphqlInput });

    expect(progress).toMatchObject({
      progressPayload: {
        progressState: "validating",
      },
    });
    expect(graphqlInput).toMatchObject({
      progressPayload: {
        progressState: "VALIDATING",
      },
    });
    expect(serialized).not.toContain("npm test");
    expect(serialized).not.toContain("git commit");
    expect(serialized).not.toContain("/private/repo");
  });

  it("reports only growth beyond the approved file estimate", () => {
    const telemetry = {
      runId: __internal.runIdForProposal("proposal-1"),
      proposalId: "proposal-1",
      startedAt: Date.now() - 10_000,
      sequence: 2,
      toolCallsCount: 4,
      toolReadCount: 1,
      toolWriteCount: 3,
      toolExternalCount: 0,
      failureCount: 0,
      retryCount: 0,
      redirectCount: 0,
      filesRead: new Set<string>(),
      filesModified: new Set(["one.ts", "two.ts", "three.ts"]),
      progressState: "working" as const,
      startedReported: true,
      scopeDriftReported: false,
      completedReported: false,
    };

    const withinEstimate = __internal.buildProgressEventInput(telemetry, false, 3, 20);
    const overEstimate = __internal.buildProgressEventInput(telemetry, true, 1, 20);

    expect(withinEstimate).toMatchObject({
      progressPayload: {
        filesModifiedBucket: "3_to_5",
        scopeChanged: false,
        scopeGrowthBucket: "none",
        confidenceBucket: "low",
      },
    });
    expect(overEstimate).toMatchObject({
      progressPayload: {
        filesModifiedBucket: "3_to_5",
        scopeChanged: true,
        scopeGrowthBucket: "1_to_2_files",
        confidenceBucket: "medium",
      },
    });
  });

  it("uses medium confidence when concrete progress risk signals are present", () => {
    expect(
      __internal.progressConfidenceBucket({
        elapsedSeconds: 30,
        estimatedMinutes: 20,
        scopeGrowth: undefined,
        retryCount: 0,
        failureCount: 0,
      }),
    ).toBe("low");
    expect(
      __internal.progressConfidenceBucket({
        elapsedSeconds: 30,
        estimatedMinutes: 20,
        scopeGrowth: 1,
        retryCount: 0,
        failureCount: 0,
      }),
    ).toBe("medium");
    expect(
      __internal.progressConfidenceBucket({
        elapsedSeconds: 30,
        estimatedMinutes: 20,
        scopeGrowth: 0,
        retryCount: 0,
        failureCount: 3,
      }),
    ).toBe("medium");
    expect(
      __internal.progressConfidenceBucket({
        elapsedSeconds: 1_600,
        estimatedMinutes: 20,
        scopeGrowth: 0,
        retryCount: 0,
        failureCount: 0,
      }),
    ).toBe("medium");
  });

  it("builds continuation, resumed, queued, terminal, and outcome events without raw continuation text", () => {
    const telemetry = {
      runId: __internal.runIdForProposal("proposal-1"),
      proposalId: "proposal-1",
      startedAt: Date.now() - 30_000,
      sequence: 4,
      toolCallsCount: 5,
      toolReadCount: 1,
      toolWriteCount: 2,
      toolExternalCount: 1,
      failureCount: 1,
      retryCount: 0,
      redirectCount: 0,
      filesRead: new Set<string>(),
      filesModified: new Set(["/private/repo/src/auth.ts"]),
      progressState: "working" as const,
      startedReported: true,
      scopeDriftReported: true,
      completedReported: false,
    };
    const artifact = {
      branch: "feature/secret-branch",
      runId: telemetry.runId,
      approvedProposalId: "proposal-1",
      approvedProposalDescription: "Fix secret auth issue with prompt details",
      estimatedFiles: 2,
      modifiedFiles: ["/private/repo/src/auth.ts"],
      openDecisions: ["Should we expose raw prompt?"],
      pendingSteps: ["Inspect /private/repo/src/auth.ts"],
      completedSteps: ["Edited secret file"],
      resumeInstruction: "Resume with raw prompt details",
      wrapUpInstruction: "Proceed normally",
      savedAt: "2026-04-25T20:10:00Z",
      reason: "manual-save /private/repo feature/secret-branch",
    };

    const continuation = __internal.buildContinuationSavedEventInput(telemetry, artifact);
    const resumed = __internal.buildResumedEventInput(artifact);
    const queued = __internal.buildQueuedForMorningEventInput(proposal, "2026-04-26T15:00:00Z");
    const terminal = __internal.buildTerminalEventInput(
      telemetry,
      "completed",
      "test_failure /private/repo feature/secret-branch",
      true,
    );
    const outcome = __internal.buildSteeringOutcomeEventInput(
      telemetry,
      "completed",
      "test_failure /private/repo feature/secret-branch",
      true,
    );
    const serialized = stringify({ continuation, resumed, queued, terminal, outcome });

    expect(continuation).toMatchObject({
      eventType: "agent_run.continuation_saved",
      idempotencyKey: `${telemetry.runId}:agent_run.continuation_saved:manual_save:4`,
      payload: {
        continuation_id: "cont_proposal-1",
        save_reason: "manual_save",
        pending_steps_count: 1,
        completed_steps_count: 1,
        dirty_files_count: 1,
      },
    });
    expect(resumed).toMatchObject({ eventType: "agent_run.resumed" });
    expect(queued).toMatchObject({ eventType: "agent_run.queued_for_morning" });
    expect(terminal).toMatchObject({
      eventType: "agent_run.completed",
      payload: { failure_category: "unknown" },
    });
    expect(outcome).toMatchObject({
      eventType: "steering_outcome.reported",
      payload: { error_category: "unknown" },
    });
    expect(serialized).not.toContain("/private/repo");
    expect(serialized).not.toContain("private_repo");
    expect(serialized).not.toContain("feature/secret-branch");
    expect(serialized).not.toContain("feature_secret-branch");
    expect(serialized).not.toContain("secret-branch");
    expect(serialized).not.toContain("prompt details");
    expect(serialized).not.toContain("github.com");
  });

  it("maps Pi task outcomes to taxonomy outcome values", () => {
    expect(__internal.mapTaskOutcomeToAgentRunOutcome("completed")).toBe("succeeded");
    expect(__internal.mapTaskOutcomeToAgentRunOutcome("failed")).toBe("failed");
    expect(__internal.mapTaskOutcomeToAgentRunOutcome("cancelled")).toBe("cancelled");
    expect(__internal.mapTaskOutcomeToAgentRunOutcome("timed_out")).toBe("failed");
    expect(__internal.mapTaskOutcomeToAgentRunOutcome("partially_completed")).toBe("paused");
  });
});
