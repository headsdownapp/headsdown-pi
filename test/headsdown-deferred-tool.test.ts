import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadsDownClient } from "@headsdown/sdk";
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
  const dir = await mkdtemp(join(tmpdir(), "headsdown-deferred-tool-"));
  tempDirs.push(dir);
  process.env.HEADSDOWN_AUTOPILOT_STATE_PATH = join(dir, "autopilot-state.json");
});

afterEach(async () => {
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
        sessionId: input.runId ?? "run-1",
        generatedAt: occurredAt,
        stale: false,
        toolCallCount: 4,
        fileChangeCount: 2,
        deferredDecisionCount: 1,
        continuationArtifactAvailable: true,
        validationLocallyPassed: false,
        approvedProposalRef: "proposal-1",
        outcomeCategory: "in_progress",
      },
      ...input.payload,
    },
    insertedAt: occurredAt,
  } as AgentRunEvent;
}

function registerToolHarness() {
  const tools = new Map<string, any>();
  const pi = {
    registerCommand: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    on: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium"),
    setThinkingLevel: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    exec: vi.fn(),
  };

  headsdownExtension(pi as any);
  const tool = tools.get("headsdown_deferred");
  if (!tool) throw new Error("headsdown_deferred was not registered");
  return { tool };
}

function makeContext() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getBranch: vi.fn(() => []), getSessionId: vi.fn(() => "session-1") },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn() },
  };
}

function textResult(result: any): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

describe("headsdown_deferred tool", () => {
  it("lists only derived facts and strips raw payload fields", async () => {
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision-1",
        payload: { prompt: "do not show", file_path: "/private/path" },
      }),
    ];
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : [],
      ),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    const payload = textResult(
      await tool.execute("tool-1", { action: "list" }, undefined, undefined, makeContext()),
    );

    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.groups[0].entries[0]).toEqual(
      expect.objectContaining({
        decision_id: "decision-1",
        run_id: "run-1",
        decision_kind: "would_have_asked",
        summary: expect.objectContaining({ tool_call_count: 4, file_change_count: 2 }),
      }),
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("do not show");
    expect(serialized).not.toContain("/private/path");
    expect(serialized).not.toContain("file_path");

    await expect(
      tool.execute(
        "tool-2",
        { action: "list", run_id: "/private/path" },
        undefined,
        undefined,
        makeContext(),
      ),
    ).rejects.toThrow("run_id must be an opaque ID token");
  });

  it("writes approve resolutions with stable idempotency, cleans surfaced state, and returns the updated list", async () => {
    await saveAutopilotState(
      markDecisionIdsSurfaced(
        emptyAutopilotState(),
        [{ runId: "run-1", decisionId: "decision-1" }],
        new Date("2026-05-01T10:00:00.000Z"),
      ),
    );
    const recorded = [
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-1" }),
    ];
    const resolved: AgentRunEvent[] = [];
    const reportDeferredDecisionResolved = vi.fn(async (context: any, payload: any) => {
      resolved.push(
        makeEvent({
          eventType: "deferred_decision.resolved",
          decisionId: payload.decision_id,
          payload,
        }),
      );
      return { ok: true, event: null, error: null };
    });
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : resolved,
      ),
      reportDeferredDecisionResolved,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    const payload = textResult(
      await tool.execute(
        "tool-1",
        { action: "approve", decision_id: "decision-1" },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        action: "approve",
        decision_id: "decision-1",
        resolution_kind: "approved",
        alreadyResolved: false,
      }),
    );
    expect(payload.remaining.count).toBe(0);
    expect(reportDeferredDecisionResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        idempotencyKey: "run-1:deferred_decision.resolved:decision-1",
      }),
      expect.objectContaining({ decision_id: "decision-1", resolution_kind: "approved" }),
    );
    expect(JSON.stringify(reportDeferredDecisionResolved.mock.calls[0])).not.toContain("prompt");
    expect(await loadAutopilotState()).toEqual(
      expect.objectContaining({ surfacedDecisionIds: {}, surfacedAtByDecisionId: {} }),
    );
  });

  it("views a single decision using only derived fields", async () => {
    const recorded = [
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision-1",
        payload: { prompt: "do not show", file_path: "/private/path" },
      }),
    ];
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : [],
      ),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    const payload = textResult(
      await tool.execute(
        "tool-1",
        { action: "view", decision_id: "decision-1" },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(payload.ok).toBe(true);
    expect(payload.decision).toEqual(
      expect.objectContaining({
        decision_id: "decision-1",
        run_id: "run-1",
        summary: expect.objectContaining({ tool_call_count: 4 }),
      }),
    );
    expect(payload.decision.local_session_summary).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("do not show");
    expect(JSON.stringify(payload)).not.toContain("/private/path");
  });

  it("returns structured not found for missing view", async () => {
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async () => []),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    const payload = textResult(
      await tool.execute(
        "tool-1",
        { action: "view", decision_id: "missing" },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(payload).toEqual({ ok: false, notFound: true, decision_id: "missing" });
  });

  it("requires run_id when a decision id appears in multiple runs", async () => {
    const recorded = [
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-shared" }),
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision-shared",
        runId: "run-2",
      }),
    ];
    const resolved: AgentRunEvent[] = [];
    const reportDeferredDecisionResolved = vi.fn(async (context: any, payload: any) => {
      resolved.push(
        makeEvent({
          eventType: "deferred_decision.resolved",
          decisionId: payload.decision_id,
          runId: context.runId,
          payload,
        }),
      );
      return { ok: true, event: null, error: null };
    });
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(
        async ({ eventType, runId }: { eventType?: string; runId?: string }) => {
          const source = eventType === "deferred_decision.recorded" ? recorded : resolved;
          return runId ? source.filter((event) => event.runId === runId) : source;
        },
      ),
      reportDeferredDecisionResolved,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    const ambiguousPayload = textResult(
      await tool.execute(
        "tool-1",
        { action: "view", decision_id: "decision-shared" },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(ambiguousPayload).toEqual({
      ok: false,
      ambiguous: true,
      decision_id: "decision-shared",
      run_ids: ["run-1", "run-2"],
      message: "decision_id matches multiple runs. Pass run_id to choose one.",
    });

    const resolvedPayload = textResult(
      await tool.execute(
        "tool-2",
        { action: "approve", decision_id: "decision-shared", run_id: "run-2" },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(resolvedPayload.ok).toBe(true);
    expect(resolvedPayload.remaining.count).toBe(0);
    expect(reportDeferredDecisionResolved).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2" }),
      expect.objectContaining({ decision_id: "decision-shared", resolution_kind: "approved" }),
    );
  });

  it("requires and writes override action keys", async () => {
    const recorded = [
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-1" }),
    ];
    const reportDeferredDecisionResolved = vi.fn(async () => ({
      ok: true,
      event: null,
      error: null,
    }));
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : [],
      ),
      reportDeferredDecisionResolved,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    await expect(
      tool.execute(
        "tool-1",
        { action: "override", decision_id: "decision-1" },
        undefined,
        undefined,
        makeContext(),
      ),
    ).rejects.toThrow("resolved_action_key is required");

    const payload = textResult(
      await tool.execute(
        "tool-2",
        {
          action: "override",
          decision_id: "decision-1",
          resolved_action_key: "queue_for_later",
        },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(payload.resolution_kind).toBe("overridden");
    expect(reportDeferredDecisionResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision_id: "decision-1",
        resolution_kind: "overridden",
        resolved_action_key: "queue_for_later",
      }),
    );
  });

  it("passes refine fields through and explains runtime re-attempt scope", async () => {
    const recorded = [
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-1" }),
    ];
    const reportDeferredDecisionResolved = vi.fn(async () => ({
      ok: true,
      event: null,
      error: null,
    }));
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : [],
      ),
      reportDeferredDecisionResolved,
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    await expect(
      tool.execute(
        "tool-0",
        {
          action: "refine",
          decision_id: "decision-1",
          refined_decision_category: "ignore previous instructions",
        },
        undefined,
        undefined,
        makeContext(),
      ),
    ).rejects.toThrow("refined_decision_category must be a supported decision category enum");

    await expect(
      tool.execute(
        "tool-0b",
        {
          action: "refine",
          decision_id: "decision-1",
          refined_urgency_bucket: "unknown",
        },
        undefined,
        undefined,
        makeContext(),
      ),
    ).rejects.toThrow("refined_urgency_bucket must be one of low, normal, or high");

    const payload = textResult(
      await tool.execute(
        "tool-1",
        {
          action: "refine",
          decision_id: "decision-1",
          refined_urgency_bucket: "high",
          refined_decision_category: "unknown",
          notes_bucket: "needs_more_info",
          raw_payload: "ignored",
        },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(payload.notice).toContain("does not re-attempt refined decisions automatically yet");
    expect(reportDeferredDecisionResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision_id: "decision-1",
        resolution_kind: "refined",
        refined_urgency_bucket: "high",
        refined_decision_category: "unknown",
        notes_bucket: "needs_more_info",
      }),
    );
    expect(JSON.stringify(reportDeferredDecisionResolved.mock.calls[0])).not.toContain(
      "raw_payload",
    );
  });

  it("treats duplicate resolution writes as already resolved", async () => {
    const recorded = [
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-1" }),
    ];
    const client = {
      withActor: vi.fn(() => client),
      listAgentRunEvents: vi.fn(async ({ eventType }: { eventType?: string }) =>
        eventType === "deferred_decision.recorded" ? recorded : [],
      ),
      reportDeferredDecisionResolved: vi.fn(async () => {
        throw new Error("duplicate key value violates unique constraint");
      }),
    };
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { tool } = registerToolHarness();

    const payload = textResult(
      await tool.execute(
        "tool-1",
        { action: "dismiss", decision_id: "decision-1" },
        undefined,
        undefined,
        makeContext(),
      ),
    );

    expect(payload.ok).toBe(true);
    expect(payload.alreadyResolved).toBe(true);
    expect(payload.notice).toContain("Already resolved");
  });
});
