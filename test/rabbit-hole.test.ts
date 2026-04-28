import { describe, expect, it } from "vitest";
import { __internal } from "../extensions/headsdown/index.js";
import {
  formatHeadsDownCallForPrompt,
  renderHeadsDownCallCopy,
} from "../extensions/headsdown/call-renderer.js";

describe("rabbit-hole detection helpers", () => {
  it("detects rabbit_hole_detected from run summary and returns matching run", () => {
    const result = __internal.detectRabbitHoleFromOverview(
      {
        currentCall: {
          callKey: "good_to_run",
        },
        headsdownCall: {
          key: "good_to_run",
          knownKey: "good_to_run",
          reasonCodes: [],
        },
        runSummaries: [
          {
            runId: "run_proposal-1",
            callKey: "rabbit_hole_detected",
            reasonCodes: ["low_progress"],
          },
        ],
      } as any,
      "run_proposal-1",
    );

    expect(result.detected).toBe(true);
    expect(result.runSummary?.runId).toBe("run_proposal-1");
    expect(result.runSummary?.callKey).toBe("rabbit_hole_detected");
  });

  it("can match backend proposal run ids as well as event run ids", () => {
    const result = __internal.detectRabbitHoleFromOverview(
      {
        currentCall: {
          callKey: "GOOD_TO_RUN",
        },
        headsdownCall: {
          key: "good_to_run",
          knownKey: "GOOD_TO_RUN",
          reasonCodes: [],
        },
        runSummaries: [
          {
            runId: "proposal-uuid",
            callKey: "RABBIT_HOLE_DETECTED",
            reasonCodes: ["scope_growth"],
          },
        ],
      } as any,
      ["run_proposal-uuid", "proposal-uuid"],
    );

    expect(result.detected).toBe(true);
    expect(result.runSummary?.runId).toBe("proposal-uuid");
  });

  it("does not treat historical rabbit-hole events as active when current run state moved on", () => {
    const result = __internal.detectRabbitHoleFromOverview(
      {
        currentCall: {
          callKey: "RABBIT_HOLE_DETECTED",
        },
        headsdownCall: {
          key: "rabbit_hole_detected",
          knownKey: "RABBIT_HOLE_DETECTED",
          reasonCodes: [],
        },
        runSummaries: [
          {
            runId: "proposal-uuid",
            callKey: "READY_TO_RESUME",
            reasonCodes: [],
          },
        ],
      } as any,
      ["run_proposal-uuid", "proposal-uuid"],
    );

    expect(result.detected).toBe(false);
    expect(result.runSummary?.callKey).toBe("READY_TO_RESUME");
  });

  it("renders active rabbit-hole copy when overview call is stale good_to_run", () => {
    const narrative = __internal.buildRabbitHoleNarrative({
      call: {
        key: "good_to_run",
        knownKey: "GOOD_TO_RUN",
        title: "Good to run",
        body: "This task fits the time and attention you have right now.",
        reasonCodes: [],
      } as any,
      runSummary: {
        runId: "run_proposal-1",
        callKey: "RABBIT_HOLE_DETECTED",
        reasonCodes: ["scope_growth", "low_progress"],
      } as any,
      activeCallKey: "rabbit_hole_detected",
    });

    expect(narrative).toContain("Call: Rabbit hole detected");
    expect(narrative).not.toContain("Call: Good to run");
    expect(narrative).toContain("HEADSDOWN CALL");
  });

  it("renders Call/Trap/Play/Escalation narrative for rabbit-hole interventions", () => {
    const narrative = __internal.buildRabbitHoleNarrative({
      call: {
        key: "rabbit_hole_detected",
        knownKey: "rabbit_hole_detected",
        title: "Rabbit hole detected",
        body: "Scope expanded.",
        reasonCodes: ["scope_growth"],
      } as any,
      runSummary: {
        runId: "run_proposal-1",
        callKey: "rabbit_hole_detected",
        reasonCodes: ["scope_growth", "low_progress"],
      } as any,
    });

    expect(narrative).toContain("Call:");
    expect(narrative).toContain("Trap:");
    expect(narrative).toContain("Play:");
    expect(narrative).toContain("Escalation:");
    expect(narrative).toContain("HEADSDOWN CALL");
  });

  it("builds pause and allow_for_duration action payloads for the backend proposal run id", () => {
    expect(
      __internal.buildPauseAndSummarizeActionInput("proposal-uuid", "rabbit_hole_detected"),
    ).toEqual({
      runId: "proposal-uuid",
      reason: "rabbit_hole_detected",
      sourceState: "rabbit_hole_detected",
      source: "pi",
      client: "headsdown-pi",
    });

    expect(__internal.buildAllowForDurationInput("proposal-uuid", 15, "manual_override")).toEqual({
      runId: "proposal-uuid",
      durationMinutes: 15,
      reason: "manual_override",
      sourceState: "rabbit_hole_detected",
      source: "pi",
      client: "headsdown-pi",
    });
  });

  it("filters rendered call actions through backend allowed action keys", () => {
    const rendered = renderHeadsDownCallCopy({ key: "rabbit_hole_detected" });
    const deniedPrompt = formatHeadsDownCallForPrompt(
      __internal.filterRenderedCallActions(rendered, []),
    );
    const allowedPrompt = formatHeadsDownCallForPrompt(
      __internal.filterRenderedCallActions(rendered, ["pause_and_summarize"]),
    );

    expect(deniedPrompt).not.toContain("action=pause_and_summarize");
    expect(deniedPrompt).not.toContain("action=allow_for_duration");
    expect(allowedPrompt).toContain("action=pause_and_summarize");
    expect(allowedPrompt).not.toContain("action=allow_for_duration");
  });

  it("uses matching run action keys before global call action keys for prompts", () => {
    const overview = __internal.normalizeAgentControlOverviewPayload({
      headsdownCall: {
        key: "RABBIT_HOLE_DETECTED",
        allowedActionKeys: ["PAUSE_AND_SUMMARIZE"],
      },
      runSummaries: [
        {
          runId: "run-active",
          callKey: "RABBIT_HOLE_DETECTED",
          allowedActionKeys: [],
        },
      ],
    });

    expect(
      __internal.allowedActionKeysForCallPrompt(overview!, "rabbit_hole_detected", ["run-active"]),
    ).toEqual([]);
    expect(
      __internal.allowedActionKeysForCallPrompt(overview!, "rabbit_hole_detected", []),
    ).toEqual([]);
  });

  it("allows rabbit-hole actions only when the backend run allow-list includes the action", () => {
    const overview = __internal.normalizeAgentControlOverviewPayload({
      runSummaries: [
        {
          runId: "proposal-uuid",
          callKey: "RABBIT_HOLE_DETECTED",
          allowedActionKeys: ["PAUSE_AND_SUMMARIZE", "ALLOW_FOR_DURATION"],
        },
      ],
    });

    expect(
      __internal.resolveAllowedRunAction({
        overview,
        candidateRunIds: ["run_proposal-uuid", "proposal-uuid"],
        actionKey: "pause_and_summarize",
        expectedCallKeys: ["rabbit_hole_detected"],
      }),
    ).toMatchObject({ allowed: true, reason: "allowed", runSummary: { runId: "proposal-uuid" } });

    expect(
      __internal.resolveAllowedRunAction({
        overview,
        candidateRunIds: ["proposal-uuid"],
        actionKey: "allow_for_duration",
        expectedCallKeys: ["rabbit_hole_detected"],
      }),
    ).toMatchObject({ allowed: true, reason: "allowed", runSummary: { runId: "proposal-uuid" } });
  });

  it("fails closed when action allow-list data is missing, stale, or denies the action", () => {
    const overview = __internal.normalizeAgentControlOverviewPayload({
      runSummaries: [
        {
          runId: "proposal-uuid",
          callKey: "READY_TO_RESUME",
          allowedActionKeys: ["RESUME_RUN"],
        },
        {
          runId: "run-without-actions",
          callKey: "RABBIT_HOLE_DETECTED",
        },
      ],
    });

    expect(
      __internal.resolveAllowedRunAction({
        overview: null,
        candidateRunIds: ["proposal-uuid"],
        actionKey: "pause_and_summarize",
        expectedCallKeys: ["rabbit_hole_detected"],
      }).reason,
    ).toBe("missing_overview");

    expect(
      __internal.resolveAllowedRunAction({
        overview,
        candidateRunIds: ["missing-run"],
        actionKey: "pause_and_summarize",
        expectedCallKeys: ["rabbit_hole_detected"],
      }).reason,
    ).toBe("missing_run");

    expect(
      __internal.resolveAllowedRunAction({
        overview,
        candidateRunIds: ["proposal-uuid"],
        actionKey: "pause_and_summarize",
        expectedCallKeys: ["rabbit_hole_detected"],
      }).reason,
    ).toBe("call_mismatch");

    expect(
      __internal.resolveAllowedRunAction({
        overview,
        candidateRunIds: ["run-without-actions"],
        actionKey: "pause_and_summarize",
        expectedCallKeys: ["rabbit_hole_detected"],
      }).reason,
    ).toBe("action_not_allowed");
  });

  it("keeps rabbit-hole narrative copy canonical even if incoming call copy is untrusted", () => {
    const narrative = __internal.buildRabbitHoleNarrative({
      call: {
        key: "rabbit_hole_detected",
        knownKey: "rabbit_hole_detected",
        title: "Untrusted call title",
        body: "Untrusted call body",
        reasonCodes: ["scope_growth"],
      } as any,
      runSummary: {
        runId: "run_proposal-1",
        callKey: "rabbit_hole_detected",
        reasonCodes: ["scope_growth"],
      } as any,
    });

    expect(narrative).toContain("Call: Rabbit hole detected");
    expect(narrative).toContain("The work is growing past the size that was worth approving");
    expect(narrative).not.toContain("Untrusted call title");
    expect(narrative).not.toContain("Untrusted call body");
  });

  it("hashes workspace refs so raw cwd is not sent", () => {
    const opaque = __internal.toOpaqueWorkspaceRef("/Users/name/private-repo");

    expect(opaque).toMatch(/^workspace_[a-f0-9]{16}$/);
    expect(opaque).not.toContain("private-repo");
    expect(opaque).not.toContain("/Users/name");
  });

  it("normalizes rabbit-hole session override command modes", () => {
    expect(__internal.normalizeRabbitHoleSessionMode("on")).toBe("on");
    expect(__internal.normalizeRabbitHoleSessionMode("normal")).toBe("on");
    expect(__internal.normalizeRabbitHoleSessionMode("off")).toBe("off");
    expect(__internal.normalizeRabbitHoleSessionMode("soft")).toBe("off");
    expect(__internal.normalizeRabbitHoleSessionMode("quiet")).toBe("quiet");
    expect(__internal.normalizeRabbitHoleSessionMode("mute")).toBe("quiet");
    expect(__internal.normalizeRabbitHoleSessionMode("unknown")).toBeNull();
  });

  it("reports rabbit-hole session override status without requiring backend state", () => {
    expect(__internal.formatRabbitHoleSessionStatus("on")).toContain(
      "normal hard stops and guidance",
    );
    expect(__internal.formatRabbitHoleSessionStatus("off", "run_1")).toContain(
      "hard stops disabled, soft guidance remains",
    );
    expect(
      __internal.formatRabbitHoleSessionStatus("quiet", "run_1", {
        contained: true,
        sourceState: "rabbit_hole_detected",
      }),
    ).toContain("hard stops and rabbit-hole guidance disabled");
    expect(__internal.formatRabbitHoleSessionStatus("quiet", "run_1")).toContain(
      "Telemetry reporting stays enabled",
    );
  });

  it("blocks contained rabbit-hole mutations only in normal session mode", () => {
    const intervention = {
      contained: true,
      sourceState: "rabbit_hole_detected" as const,
    };

    expect(__internal.shouldBlockRabbitHoleMutation("on", intervention, 1_000)).toMatchObject({
      block: true,
      expiredAllowance: false,
    });
    expect(__internal.shouldBlockRabbitHoleMutation("off", intervention, 1_000)).toEqual({
      block: false,
      expiredAllowance: false,
    });
    expect(__internal.shouldBlockRabbitHoleMutation("quiet", intervention, 1_000)).toEqual({
      block: false,
      expiredAllowance: false,
    });
  });

  it("contains expired allow-for-duration windows only in normal session mode", () => {
    const intervention = {
      contained: false,
      sourceState: "rabbit_hole_detected" as const,
      allowedUntil: 900,
    };

    expect(__internal.shouldBlockRabbitHoleMutation("on", intervention, 1_000)).toMatchObject({
      block: true,
      expiredAllowance: true,
    });
    expect(__internal.shouldBlockRabbitHoleMutation("off", intervention, 1_000)).toEqual({
      block: false,
      expiredAllowance: false,
    });
    expect(__internal.shouldBlockRabbitHoleMutation("quiet", intervention, 1_000)).toEqual({
      block: false,
      expiredAllowance: false,
    });
  });

  it("suppresses rabbit-hole guidance only in quiet session mode", () => {
    expect(__internal.shouldEmitRabbitHoleGuidance("on")).toBe(true);
    expect(__internal.shouldEmitRabbitHoleGuidance("off")).toBe(true);
    expect(__internal.shouldEmitRabbitHoleGuidance("quiet")).toBe(false);
  });
});
