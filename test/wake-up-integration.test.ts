import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, HeadsDownClient } from "@headsdown/sdk";
import type { AgentRunEvent } from "@headsdown/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import headsdownExtension from "../extensions/headsdown/index.js";
import {
  emptyAutopilotState,
  loadAutopilotState,
  markDecisionIdsSurfaced,
  saveAutopilotState,
} from "../extensions/headsdown/autopilot-state.js";

const tempDirs: string[] = [];
let oldStatePath: string | undefined;

beforeEach(async () => {
  oldStatePath = process.env.HEADSDOWN_AUTOPILOT_STATE_PATH;
  const dir = await mkdtemp(join(tmpdir(), "headsdown-wake-up-integration-"));
  tempDirs.push(dir);
  process.env.HEADSDOWN_AUTOPILOT_STATE_PATH = join(dir, "autopilot-state.json");
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ wakeUpDigest: { enabled: true } }), "utf-8");
  vi.spyOn(ConfigStore.prototype, "filePath", "get").mockReturnValue(configPath);
});

afterEach(async () => {
  vi.useRealTimers();
  if (oldStatePath === undefined) {
    delete process.env.HEADSDOWN_AUTOPILOT_STATE_PATH;
  } else {
    process.env.HEADSDOWN_AUTOPILOT_STATE_PATH = oldStatePath;
  }
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeEvent(input: {
  eventType: string;
  decisionId: string;
  runId?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}): AgentRunEvent {
  const occurredAt = input.occurredAt ?? "2026-04-30T10:00:00.000Z";

  return {
    id: `${input.eventType}:${input.decisionId}`,
    eventId: `${input.eventType}:${input.decisionId}`,
    eventType: input.eventType,
    schemaVersion: 1,
    occurredAt,
    receivedAt: occurredAt,
    workspaceRef: "workspace_test",
    client: { kind: "pi_extension", name: "headsdown-pi", version: "test" },
    actor: { kind: "agent", ref: "pi-agent" },
    runId: input.runId ?? "run-1",
    source: "pi",
    privacyMode: "metadata_only",
    idempotencyKey: `${input.runId ?? "run-1"}:${input.eventType}:${input.decisionId}`,
    sequence: 1,
    emitterKey: "test",
    payload: {
      decision_id: input.decisionId,
      decision_kind: "would_have_asked",
      decision_category: "unknown",
      urgency_bucket: "normal",
      flagged_for_review: true,
      local_session_summary: {
        version: 1,
        session_id: input.runId ?? "run-1",
        generated_at: occurredAt,
        stale: false,
        tool_call_count: 4,
        file_change_count: 2,
        deferred_decision_count: 1,
        continuation_artifact_available: true,
        validation_locally_passed: false,
        approved_proposal_ref: "proposal-1",
        outcome_category: "in_progress",
      },
      ...input.payload,
    },
    insertedAt: occurredAt,
  } as AgentRunEvent;
}

function registerHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const pi = {
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn((eventName: string, handler: (event: any, ctx: any) => Promise<any>) => {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    }),
    getThinkingLevel: vi.fn(() => "medium"),
    setThinkingLevel: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    exec: vi.fn(),
  };

  headsdownExtension(pi as any);
  return { handlers };
}

function makeContext() {
  return {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: { getBranch: vi.fn(() => []), getSessionId: vi.fn(() => "session-1") },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn() },
  };
}

describe("wake-up digest integration", () => {
  it("surfaces unresolved decisions once on online arrival and injects ready-to-resume guidance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    await saveAutopilotState(
      markDecisionIdsSurfaced(
        { ...emptyAutopilotState(), lastObservedMode: "offline" },
        [{ runId: "run-1", decisionId: "decision_previous00000000" }],
        new Date("2026-04-30T10:00:00.000Z"),
      ),
    );
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_previous00000000",
      }),
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-1" }),
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-2" }),
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_expired000000000",
        payload: { expires_at: "2026-04-29T10:00:00.000Z" },
      }),
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_stale00000000000",
        occurredAt: "2026-03-01T10:00:00.000Z",
      }),
    ];
    const resolved = [
      makeEvent({ eventType: "deferred_decision.resolved", decisionId: "decision-2" }),
    ];
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : resolved,
      ),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const sessionStart = handlers.get("session_start")?.at(0);
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    if (!sessionStart || !beforeAgentStart)
      throw new Error("required handlers were not registered");

    await sessionStart({ reason: "new" }, ctx);
    await sessionStart({ reason: "new" }, ctx);
    const promptResult = await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("1 deferred decision queued"),
      "info",
    );
    expect(promptResult.systemPrompt).toContain("Ready to resume: 2 deferred decisions queued");
    expect(promptResult.systemPrompt).toContain("headsdown_deferred action=list");
    expect(promptResult.systemPrompt).not.toContain("decision-2");
    expect(promptResult.systemPrompt).not.toContain("decision_expired000000000");
  });

  it("injects refined re-attempt context once per session without raw context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000001",
        occurredAt: "2026-04-20T10:00:00.000Z",
        payload: {
          decision_category: "validation",
          urgency_bucket: "normal",
          file_path: "/private/worktree/app/lib/example.ex",
        },
      }),
    ];
    const refined = [
      makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: "decision_refined000000001",
        payload: {
          resolution_kind: "refined",
          refined_urgency_bucket: "elevated",
          refined_decision_category: "validation",
          resolved_action_key: "resume_run",
          notes_bucket: "wrong_framing",
          prompt: "raw prompt should never appear",
        },
      }),
    ];
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return refined;
          if (eventType === "deferred_decision.resolved") return refined;
          return [];
        },
      ),
      reportDeferredDecisionReAttempted: vi.fn(async () => ({
        ok: true,
        error: null,
        event: null,
      })),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const sessionStart = handlers.get("session_start")?.at(0);
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    if (!sessionStart || !beforeAgentStart)
      throw new Error("required handlers were not registered");

    await sessionStart({ reason: "new" }, ctx);
    const promptResult = await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);
    const promptText = promptResult.systemPrompt as string;

    expect(client.listAgentRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deferred_decision.recorded",
        insertedAfter: "2026-04-01T10:00:00.000Z",
      }),
    );
    expect(client.listAgentRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deferred_decision.resolved",
        resolutionKind: "refined",
        insertedAfter: "2026-04-24T10:00:00.000Z",
      }),
    );
    expect(promptText).toContain("Previously deferred and refined decisions to re-attempt");
    expect(promptText).toContain("decision_refined000000001");
    expect(promptText).toContain("urgency=elevated");
    expect(promptText).toContain("category=validation");
    expect(promptText).toContain("resolved_action_key=resume_run");
    expect(promptText).not.toContain("/private/worktree");
    expect(promptText).not.toContain("raw prompt should never appear");

    const state = await loadAutopilotState();
    expect(state.reAttemptedDecisionIds["session-1"]).toContain(
      JSON.stringify(["run-1", "decision_refined000000001"]),
    );

    const secondPromptResult = await beforeAgentStart(
      { prompt: "continue", systemPrompt: "base" },
      ctx,
    );
    expect(secondPromptResult.systemPrompt).not.toContain(
      "Previously deferred and refined decisions to re-attempt",
    );
  });

  it("does not inject a refined re-attempt after a newer non-refined resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refinedDismissed01",
        occurredAt: "2026-04-20T10:00:00.000Z",
      }),
    ];
    const refined = makeEvent({
      eventType: "deferred_decision.resolved",
      decisionId: "decision_refinedDismissed01",
      occurredAt: "2026-04-30T10:00:00.000Z",
      payload: { resolution_kind: "refined", resolved_action_key: "resume_run" },
    });
    const dismissed = {
      ...makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: "decision_refinedDismissed01",
        occurredAt: "2026-05-01T09:00:00.000Z",
        payload: { resolution_kind: "dismissed" },
      }),
      eventId: "event-dismissed-newer",
      id: "event-dismissed-newer",
    };
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return [refined];
          if (eventType === "deferred_decision.resolved") return [refined, dismissed];
          return [];
        },
      ),
      reportDeferredDecisionReAttempted: vi.fn(async () => ({
        ok: true,
        error: null,
        event: null,
      })),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    if (!beforeAgentStart) throw new Error("required handler was not registered");

    const promptResult = await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);

    expect(promptResult?.systemPrompt ?? "").not.toContain(
      "Previously deferred and refined decisions",
    );
    expect(client.reportDeferredDecisionReAttempted).not.toHaveBeenCalled();
  });

  it("reports succeeded and abandoned re-attempt outcomes through the SDK helper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000002",
      }),
    ];
    const refined = [
      makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: "decision_refined000000002",
        payload: {
          resolution_kind: "refined",
          resolved_action_key: "resume_run",
        },
      }),
    ];
    const reportDeferredDecisionReAttempted = vi.fn(async () => ({
      ok: true,
      error: null,
      event: null,
    }));
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return refined;
          if (eventType === "deferred_decision.resolved") return refined;
          return [];
        },
      ),
      reportDeferredDecisionReAttempted,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    const toolExecutionEnd = handlers.get("tool_execution_end")?.at(0);
    const sessionShutdown = handlers.get("session_shutdown")?.at(0);
    if (!beforeAgentStart || !toolExecutionEnd || !sessionShutdown)
      throw new Error("required handlers were not registered");

    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);
    await toolExecutionEnd({ toolName: "resume_run", isError: false }, ctx);

    expect(reportDeferredDecisionReAttempted).toHaveBeenCalledTimes(1);
    const reportCalls = reportDeferredDecisionReAttempted.mock.calls as unknown as Array<
      [Record<string, unknown>, Record<string, unknown>]
    >;
    expect(reportCalls[0]?.[0]).toMatchObject({
      workspaceRef: "unknown",
      runId: "run_session-1:run-1",
      source: "pi_skill",
      client: { kind: "pi", name: "Pi" },
      actor: { kind: "agent", ref: "pi" },
      correlationId: "run-1",
      idempotencyKey:
        "run_session-1:run-1:deferred_decision.re_attempted:decision_refined000000002",
    });
    expect(reportCalls[0]?.[1]).toMatchObject({
      decision_id: "decision_refined000000002",
      outcome: "succeeded",
    });

    await sessionShutdown({ reason: "test" }, ctx);
    expect(reportDeferredDecisionReAttempted).toHaveBeenCalledTimes(1);

    const abandonedCtx = {
      ...makeContext(),
      sessionManager: { getBranch: vi.fn(() => []), getSessionId: vi.fn(() => "session-2") },
    };
    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, abandonedCtx);
    await sessionShutdown({ reason: "test" }, abandonedCtx);
    expect(reportDeferredDecisionReAttempted).toHaveBeenCalledTimes(2);
    expect(reportCalls[1]?.[0]).toMatchObject({
      runId: "run_session-2:run-1",
      correlationId: "run-1",
      idempotencyKey:
        "run_session-2:run-1:deferred_decision.re_attempted:decision_refined000000002",
    });
    expect(reportCalls[1]?.[1]).toMatchObject({
      decision_id: "decision_refined000000002",
      outcome: "abandoned",
    });

    const failedCtx = {
      ...makeContext(),
      sessionManager: { getBranch: vi.fn(() => []), getSessionId: vi.fn(() => "session-3") },
    };
    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, failedCtx);
    await toolExecutionEnd({ toolName: "resume_run", isError: true }, failedCtx);
    expect(reportDeferredDecisionReAttempted).toHaveBeenCalledTimes(3);
    expect(reportCalls[2]?.[0]).toMatchObject({
      runId: "run_session-3:run-1",
      correlationId: "run-1",
      idempotencyKey:
        "run_session-3:run-1:deferred_decision.re_attempted:decision_refined000000002",
    });
    expect(reportCalls[2]?.[1]).toMatchObject({
      decision_id: "decision_refined000000002",
      outcome: "failed",
    });
  });

  it("treats explicit already-resolved re-attempt outcome writes as idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000006",
      }),
    ];
    const refined = [
      makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: "decision_refined000000006",
        payload: {
          resolution_kind: "refined",
          resolved_action_key: "resume_run",
        },
      }),
    ];
    const reportDeferredDecisionReAttempted = vi.fn(async () => {
      throw new Error("Deferred decision already recorded.");
    });
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return refined;
          if (eventType === "deferred_decision.resolved") return refined;
          return [];
        },
      ),
      reportDeferredDecisionReAttempted,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    const toolExecutionEnd = handlers.get("tool_execution_end")?.at(0);
    const sessionShutdown = handlers.get("session_shutdown")?.at(0);
    if (!beforeAgentStart || !toolExecutionEnd || !sessionShutdown)
      throw new Error("required handlers were not registered");

    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);
    await toolExecutionEnd({ toolName: "resume_run", isError: false }, ctx);
    await sessionShutdown({ reason: "test" }, ctx);

    expect(reportDeferredDecisionReAttempted).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Refined re-attempt outcome report failed"),
      "warning",
    );
  });

  it("surfaces conflicting re-attempt outcome duplicate writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000007",
      }),
    ];
    const refined = [
      makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: "decision_refined000000007",
        payload: {
          resolution_kind: "refined",
          resolved_action_key: "resume_run",
        },
      }),
    ];
    const reportDeferredDecisionReAttempted = vi.fn(async () => {
      throw new Error("duplicate event does not match existing persisted body");
    });
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return refined;
          if (eventType === "deferred_decision.resolved") return refined;
          return [];
        },
      ),
      reportDeferredDecisionReAttempted,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    const toolExecutionEnd = handlers.get("tool_execution_end")?.at(0);
    if (!beforeAgentStart || !toolExecutionEnd)
      throw new Error("required handlers were not registered");

    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);
    await toolExecutionEnd({ toolName: "resume_run", isError: false }, ctx);

    expect(reportDeferredDecisionReAttempted).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("duplicate event does not match existing persisted body"),
      "warning",
    );
  });

  it("does not mark ambiguous same-action re-attempts as succeeded from one tool result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000004",
      }),
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000005",
      }),
    ];
    const refined = recorded.map((event) =>
      makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: String(event.payload.decision_id),
        payload: {
          resolution_kind: "refined",
          resolved_action_key: "resume_run",
        },
      }),
    );
    const reportDeferredDecisionReAttempted = vi.fn(async () => ({
      ok: true,
      error: null,
      event: null,
    }));
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return refined;
          if (eventType === "deferred_decision.resolved") return refined;
          return [];
        },
      ),
      reportDeferredDecisionReAttempted,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    const toolExecutionEnd = handlers.get("tool_execution_end")?.at(0);
    if (!beforeAgentStart || !toolExecutionEnd)
      throw new Error("required handlers were not registered");

    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);
    await toolExecutionEnd({ toolName: "resume_run", isError: false }, ctx);

    expect(reportDeferredDecisionReAttempted).not.toHaveBeenCalled();
  });

  it("falls back to generic event reporting when the SDK helper is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision_refined000000003",
      }),
    ];
    const refined = [
      makeEvent({
        eventType: "deferred_decision.resolved",
        decisionId: "decision_refined000000003",
        payload: {
          resolution_kind: "refined",
          resolved_action_key: "resume_run",
        },
      }),
    ];
    const reportAgentRunEvent = vi.fn(async () => ({ ok: true, error: null, event: null }));
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(
        async ({ eventType, resolutionKind }: { eventType?: string; resolutionKind?: string }) => {
          if (eventType === "deferred_decision.recorded") return recorded;
          if (eventType === "deferred_decision.resolved" && resolutionKind === "refined")
            return refined;
          if (eventType === "deferred_decision.resolved") return refined;
          return [];
        },
      ),
      reportAgentRunEvent,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    const toolExecutionEnd = handlers.get("tool_execution_end")?.at(0);
    if (!beforeAgentStart || !toolExecutionEnd)
      throw new Error("required handlers were not registered");

    await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);
    await toolExecutionEnd({ toolName: "resume_run", isError: false }, ctx);

    expect(reportAgentRunEvent).toHaveBeenCalledTimes(1);
    const eventCalls = reportAgentRunEvent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(eventCalls[0]?.[0]).toMatchObject({
      eventType: "deferred_decision.re_attempted",
      workspaceRef: "unknown",
      runId: "run_session-1:run-1",
      source: "pi_skill",
      client: { kind: "pi", name: "Pi" },
      actor: { kind: "agent", ref: "pi" },
      correlationId: "run-1",
      idempotencyKey:
        "run_session-1:run-1:deferred_decision.re_attempted:decision_refined000000003",
      payload: {
        decision_id: "decision_refined000000003",
        outcome: "succeeded",
      },
    });
  });

  it("skips refined re-attempt lookup when config opts out", async () => {
    const dir = tempDirs.at(-1);
    if (!dir) throw new Error("missing temp dir");
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ wakeUpDigest: { enabled: true, reAttemptRefined: false } }),
      "utf-8",
    );
    const client = {
      withActor: vi.fn(() => client),
      getAvailability: vi.fn(async () => ({
        contract: { mode: "online", lock: false },
        calendar: null,
        schedule: { wrapUpGuidance: { active: false } },
      })),
      listDigestSummaries: vi.fn(async () => []),
      listAgentRunEvents: vi.fn(async () => []),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHarness();
    const ctx = makeContext();
    const sessionStart = handlers.get("session_start")?.at(0);
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    if (!sessionStart || !beforeAgentStart)
      throw new Error("required handlers were not registered");

    await sessionStart({ reason: "new" }, ctx);
    const promptResult = await beforeAgentStart({ prompt: "continue", systemPrompt: "base" }, ctx);

    expect(promptResult?.systemPrompt ?? "").not.toContain(
      "Previously deferred and refined decisions",
    );
    expect(client.listAgentRunEvents).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deferred_decision.resolved",
        resolutionKind: "refined",
      }),
    );
  });
});
