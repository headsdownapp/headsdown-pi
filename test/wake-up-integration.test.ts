import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, HeadsDownClient } from "@headsdown/sdk";
import type { AgentRunEvent } from "@headsdown/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import headsdownExtension from "../extensions/headsdown/index.js";
import {
  emptyAutopilotState,
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
    await saveAutopilotState({ ...emptyAutopilotState(), lastObservedMode: "offline" });
    const recorded = [
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-1" }),
      makeEvent({ eventType: "deferred_decision.recorded", decisionId: "decision-2" }),
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision-expired",
        payload: { expires_at: "2026-04-29T10:00:00.000Z" },
      }),
      makeEvent({
        eventType: "deferred_decision.recorded",
        decisionId: "decision-stale",
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
    expect(promptResult.systemPrompt).toContain("Ready to resume: 1 deferred decision queued");
    expect(promptResult.systemPrompt).toContain("headsdown_deferred action=list");
    expect(promptResult.systemPrompt).not.toContain("decision-2");
    expect(promptResult.systemPrompt).not.toContain("decision-expired");
  });
});
