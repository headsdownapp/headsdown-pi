import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, HeadsDownClient } from "@headsdown/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import headsdownExtension, { __internal } from "../extensions/headsdown/index.js";

function registerHeadsDownHarness() {
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
  return { handlers, pi };
}

function makeApprovedProposalEntry() {
  return {
    type: "custom",
    customType: "headsdown-proposal",
    data: {
      proposals: [
        {
          id: "proposal-1",
          decision: "approved",
          description: "public-safe slice",
          evaluatedAt: new Date().toISOString(),
          estimatedFiles: 4,
          estimatedMinutes: 30,
        },
      ],
    },
  };
}

function makeContext() {
  return {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: {
      getBranch: vi.fn(() => [makeApprovedProposalEntry()]),
      getSessionId: vi.fn(() => "session-1"),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn(),
    },
  };
}

async function useConfigFile(config: Record<string, unknown> | string) {
  const dir = await mkdtemp(join(tmpdir(), "headsdown-pi-config-"));
  const path = join(dir, "config.json");
  await writeFile(path, typeof config === "string" ? config : JSON.stringify(config), "utf-8");
  vi.spyOn(ConfigStore.prototype, "filePath", "get").mockReturnValue(path);
  tempDirs.push(dir);
}

function makeClient(
  mode: "online" | "limited" | "offline",
  events: Record<string, unknown>[],
  policy: Record<string, unknown> = {},
) {
  const client = {
    withActor: vi.fn(() => client),
    getAvailability: vi.fn(async () => ({
      contract: { mode, lock: false },
      calendar: null,
      schedule: { wrapUpGuidance: { active: false } },
    })),
    graphql: {
      request: vi.fn(async () => ({
        autopilotPolicy: {
          latitude: mode === "offline" ? "CAUTIOUS" : "VERIFY",
          escalationStrategy: ["TRY_ALTERNATIVE", "DEFER_FOR_HUMAN_REVIEW"],
          sandboxPreference: "PREFERRED",
          classifierVersion: "1.1.0",
          ...policy,
        },
      })),
    },
    listDigestSummaries: vi.fn(async () => []),
    reportAgentRunEvent: vi.fn(async (input: Record<string, unknown>) => {
      events.push(input);
      return { ok: true, event: null, error: null };
    }),
  };
  return client;
}

async function startSession(
  handlers: Map<string, Array<(event: any, ctx: any) => Promise<any>>>,
  ctx: any,
) {
  const sessionStart = handlers.get("session_start")?.at(0);
  if (!sessionStart) throw new Error("session_start handler was not registered");
  await sessionStart({ reason: "new" }, ctx);
}

async function fireTurnEnd(
  handlers: Map<string, Array<(event: any, ctx: any) => Promise<any>>>,
  ctx: any,
  content: unknown,
  turnIndex = 1,
) {
  const turnEnd = handlers.get("turn_end")?.at(0);
  if (!turnEnd) throw new Error("turn_end handler was not registered");
  await turnEnd({ turnIndex, message: { role: "assistant", content }, toolResults: [] }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("autopilot deferral turn_end hook", () => {
  it("uses configured custom patterns when deciding whether to record", () => {
    const config = __internal.normalizeAutopilotDeferralConfig({
      patterns: [{ key: "custom_marker", pattern: "NEEDS_DECISION" }],
    });

    expect(
      __internal.shouldRecordAutopilotDeferral({
        message: { role: "assistant", content: "NEEDS_DECISION: pick a default" },
        mode: "offline",
        config,
      }),
    ).toEqual({ matched: true, matchedPatternKey: "custom_marker" });
    expect(
      __internal.shouldRecordAutopilotDeferral({
        message: { role: "assistant", content: "Should I pick a default?" },
        mode: "offline",
        config,
      }),
    ).toEqual({ matched: false, matchedPatternKey: null });
  });

  it("nudges with SDK classifier guidance before recording after escalation exhausts", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    const client = makeClient("limited", events);
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers, pi } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, [{ type: "text", text: "Should I update the tests?" }], 1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(pi.sendMessage.mock.calls[0])).toContain("Autopilot classifier addendum");
    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );

    await fireTurnEnd(handlers, ctx, "Should I update the tests?", 2);

    await expect
      .poll(() => events.filter((event) => event.eventType === "deferred_decision.recorded").length)
      .toBe(1);
    const deferrals = events.filter((event) => event.eventType === "deferred_decision.recorded");
    const payload = deferrals[0].payload as Record<string, any>;
    expect(payload.decision_kind).toBe("would_have_asked");
    expect(payload.decision_category).toBe("scope");
    expect(payload.autopilot_context).toMatchObject({
      classifier_version: "1.1.0",
      tool_kind: "interaction.ask_user",
      classification_outcome: "notable",
      classifier_reason_code: "ask_user_baseline",
      classifier_source: "deterministic",
      latitude_at_decision: "verify",
    });
    expect(payload.autopilot_context.escalation_attempts).toEqual([
      {
        step: "try_alternative",
        outcome: "failed",
        reason_code: "try_alternative_failed",
      },
      {
        step: "defer_for_human_review",
        outcome: "deferred",
        reason_code: "defer_for_human_review_deferred",
      },
    ]);
    expect((payload.local_session_summary as Record<string, unknown>).deferredDecisionCount).toBe(
      1,
    );
    const serialized = JSON.stringify(deferrals);
    expect(serialized).not.toContain("Should I update the tests?");
    expect(serialized).not.toContain("README.md");
    expect(serialized).not.toContain(process.cwd());
  });

  it("records immediately when policy requires deferral and remains idempotent for the same turn", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.", 7);
    await fireTurnEnd(handlers, ctx, "Please confirm the default.", 7);

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      1,
    );
  });

  it("falls back to currently accepted deferred-decision fields when hosted context is rejected", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    const client = makeClient("offline", events);
    client.reportAgentRunEvent.mockImplementation(async (input: Record<string, unknown>) => {
      const payload = input.payload as Record<string, unknown>;
      if (payload.autopilot_context) throw new Error("unsupported field autopilot_context");
      events.push(input);
      return { ok: true, event: null, error: null };
    });
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.");

    await expect
      .poll(() => events.filter((event) => event.eventType === "deferred_decision.recorded").length)
      .toBe(1);
    const deferrals = events.filter((event) => event.eventType === "deferred_decision.recorded");
    expect((deferrals[0].payload as Record<string, unknown>).autopilot_context).toBeUndefined();
    expect((deferrals[0].payload as Record<string, unknown>).local_session_summary).toBeDefined();
  });

  it("does not strip classifier context for generic telemetry failures", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    const attemptedDecisionIds: unknown[] = [];
    const client = makeClient("offline", events);
    client.reportAgentRunEvent.mockImplementationOnce(async (input: Record<string, unknown>) => {
      attemptedDecisionIds.push((input.payload as Record<string, unknown>).decision_id);
      throw new Error("network timeout");
    });
    client.reportAgentRunEvent.mockImplementationOnce(async (input: Record<string, unknown>) => {
      attemptedDecisionIds.push((input.payload as Record<string, unknown>).decision_id);
      events.push(input);
      return { ok: true, event: null, error: null };
    });
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.", 1);
    await expect.poll(() => client.reportAgentRunEvent.mock.calls.length).toBe(1);
    expect(events).toHaveLength(0);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.", 2);

    await expect
      .poll(() => events.filter((event) => event.eventType === "deferred_decision.recorded").length)
      .toBe(1);
    const deferrals = events.filter((event) => event.eventType === "deferred_decision.recorded");
    expect((deferrals[0].payload as Record<string, unknown>).autopilot_context).toBeDefined();
    expect(attemptedDecisionIds[1]).toBe(attemptedDecisionIds[0]);
  });

  it("does not mark malformed telemetry responses as recorded", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    const client = makeClient("offline", events);
    client.reportAgentRunEvent.mockImplementationOnce(async () => undefined as any);
    client.reportAgentRunEvent.mockImplementationOnce(async (input: Record<string, unknown>) => {
      events.push(input);
      return { ok: true, event: null, error: null };
    });
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.", 1);
    await expect.poll(() => client.reportAgentRunEvent.mock.calls.length).toBe(1);
    expect(events).toHaveLength(0);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.", 2);

    await expect
      .poll(() => events.filter((event) => event.eventType === "deferred_decision.recorded").length)
      .toBe(1);
    const payload = events[0].payload as Record<string, any>;
    expect(payload.local_session_summary.deferredDecisionCount).toBe(1);
  });

  it("uses a conservative local policy when hosted policy lookup fails", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    const client = makeClient("offline", events);
    client.graphql.request.mockRejectedValue(new Error("policy unavailable"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Please confirm the default.");

    const deferrals = events.filter((event) => event.eventType === "deferred_decision.recorded");
    expect(deferrals).toHaveLength(1);
    expect((deferrals[0].payload as Record<string, any>).autopilot_context).toMatchObject({
      latitude_at_decision: "cautious",
    });
  });

  it("forces deferral after the configured nudge limit instead of looping on the first step", async () => {
    await useConfigFile({
      autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0, maxConsecutiveNudges: 1 },
    });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events, {
        escalationStrategy: ["TRY_ALTERNATIVE", "TRY_IN_SANDBOX", "DEFER_FOR_HUMAN_REVIEW"],
      }) as any,
    );
    const { handlers, pi } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Would you like me to update tests too?", 1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );

    await fireTurnEnd(handlers, ctx, "Would you like me to update tests too?", 2);

    await expect
      .poll(() => events.filter((event) => event.eventType === "deferred_decision.recorded").length)
      .toBe(1);
  });

  it("does not record non-text structured assistant messages", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, [{ type: "image", source: "redacted" }]);

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record events when autopilot deferral is disabled through config", async () => {
    await useConfigFile({ autopilotDeferral: { enabled: false, idleThresholdMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Do you want me to continue?");

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not fail open when config is malformed", async () => {
    await useConfigFile("{");
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Do you want me to continue?");

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record events when fresh availability cannot be verified", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0 } });
    const events: Record<string, unknown>[] = [];
    const client = makeClient("offline", events);
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    client.getAvailability.mockRejectedValueOnce(new Error("network down"));

    await fireTurnEnd(handlers, ctx, "Do you want me to continue?");

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record events outside autopilot mode", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("online", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "Do you want me to continue?");

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record non-deferral messages during autopilot mode", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);

    await fireTurnEnd(handlers, ctx, "I updated the tests and will continue.");

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("cancels a scheduled nudge when the next assistant turn is no longer stuck", async () => {
    vi.useFakeTimers();
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 50, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events) as any,
    );
    const { handlers, pi } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const turnEnd = handlers.get("turn_end")?.at(0);
    if (!turnEnd) throw new Error("turn_end handler was not registered");

    await turnEnd(
      {
        turnIndex: 1,
        message: { role: "assistant", content: "Should I keep going?" },
        toolResults: [],
      },
      ctx,
    );
    await turnEnd(
      {
        turnIndex: 2,
        message: { role: "assistant", content: "I found the answer and will continue." },
        toolResults: [],
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(60);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("waits for the latest stuck turn before firing a scheduled nudge", async () => {
    vi.useFakeTimers();
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 50, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events) as any,
    );
    const { handlers, pi } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const turnEnd = handlers.get("turn_end")?.at(0);
    if (!turnEnd) throw new Error("turn_end handler was not registered");

    await turnEnd(
      {
        turnIndex: 1,
        message: { role: "assistant", content: "Should I keep going?" },
        toolResults: [],
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(25);
    await turnEnd(
      {
        turnIndex: 2,
        message: { role: "assistant", content: "Should I keep going?" },
        toolResults: [],
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("resets autopilot turn idempotency and in-flight state on a new session", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0, nudgeCooldownMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events) as any,
    );
    const { handlers, pi } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const toolStart = handlers.get("tool_execution_start")?.at(0);
    if (!toolStart) throw new Error("tool_execution_start handler was not registered");

    await fireTurnEnd(handlers, ctx, "Should I keep going?", 1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await toolStart({ toolCallId: "leaked-tool", toolName: "read" }, ctx);
    await startSession(handlers, ctx);
    pi.sendMessage.mockClear();

    await fireTurnEnd(handlers, ctx, "Should I keep going?", 1);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not nudge when a turn produced tool results", async () => {
    await useConfigFile({ autopilotDeferral: { idleThresholdMs: 0 } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events) as any,
    );
    const { handlers, pi } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const turnEnd = handlers.get("turn_end")?.at(0);
    if (!turnEnd) throw new Error("turn_end handler was not registered");

    await turnEnd(
      {
        turnIndex: 99,
        message: { role: "assistant", content: "Should I keep going?" },
        toolResults: [{ toolName: "read", result: "ok" }],
      },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });
});
