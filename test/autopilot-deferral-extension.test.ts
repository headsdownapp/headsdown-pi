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
          evaluatedAt: "2026-04-28T10:00:00.000Z",
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

function makeClient(mode: "online" | "limited" | "offline", events: Record<string, unknown>[]) {
  const client = {
    withActor: vi.fn(() => client),
    getAvailability: vi.fn(async () => ({
      contract: { mode, lock: false },
      calendar: null,
      schedule: { wrapUpGuidance: { active: false } },
    })),
    listDigestSummaries: vi.fn(async () => []),
    reportAgentRunEvent: vi.fn(async (input: Record<string, unknown>) => {
      events.push(input);
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

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("autopilot deferral message_end hook", () => {
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

  it("records multiple metadata-only deferrals during autopilot runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:05:00.000Z"));
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const messageEnd = handlers.get("message_end")?.at(0);
    const toolCall = handlers.get("tool_call")?.at(0);
    if (!messageEnd || !toolCall) throw new Error("required handlers were not registered");

    await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);
    await messageEnd(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Should I update the tests?" }],
        },
      },
      ctx,
    );
    await messageEnd(
      { message: { role: "assistant", content: "Please confirm the default." } },
      ctx,
    );
    await messageEnd(
      { message: { role: "assistant", content: "[NEEDS_USER] choose option A or B" } },
      ctx,
    );

    const deferrals = events.filter((event) => event.eventType === "deferred_decision.recorded");
    expect(deferrals).toHaveLength(3);
    const decisionIds = deferrals.map(
      (event) => (event.payload as Record<string, unknown>).decision_id,
    );
    expect(new Set(decisionIds)).toHaveProperty("size", 3);
    expect(decisionIds).toEqual(
      decisionIds.map((id) => expect.stringMatching(/^decision_[a-f0-9]{32}$/)),
    );
    expect(
      deferrals.map(
        (event) =>
          ((event.payload as Record<string, any>).local_session_summary as Record<string, unknown>)
            .deferredDecisionCount,
      ),
    ).toEqual([1, 2, 3]);
    const serialized = JSON.stringify(deferrals);
    expect(serialized).not.toContain("Should I update the tests?");
    expect(serialized).not.toContain("Please confirm");
    expect(serialized).not.toContain("README.md");
    expect(serialized).not.toContain(process.cwd());
  });

  it("does not record non-text structured assistant messages", async () => {
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const messageEnd = handlers.get("message_end")?.at(0);
    if (!messageEnd) throw new Error("message_end handler was not registered");

    await messageEnd(
      { message: { role: "assistant", content: [{ type: "image", source: "redacted" }] } },
      ctx,
    );

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record events when autopilot deferral is disabled through config", async () => {
    await useConfigFile({ autopilotDeferral: { enabled: false } });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("offline", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const messageEnd = handlers.get("message_end")?.at(0);
    if (!messageEnd) throw new Error("message_end handler was not registered");

    await messageEnd(
      { message: { role: "assistant", content: "Do you want me to continue?" } },
      ctx,
    );

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
    const messageEnd = handlers.get("message_end")?.at(0);
    if (!messageEnd) throw new Error("message_end handler was not registered");

    await messageEnd(
      { message: { role: "assistant", content: "Do you want me to continue?" } },
      ctx,
    );

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record events when fresh availability cannot be verified", async () => {
    const events: Record<string, unknown>[] = [];
    const client = makeClient("offline", events);
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    client.getAvailability.mockRejectedValueOnce(new Error("network down"));
    const messageEnd = handlers.get("message_end")?.at(0);
    if (!messageEnd) throw new Error("message_end handler was not registered");

    await messageEnd(
      { message: { role: "assistant", content: "Do you want me to continue?" } },
      ctx,
    );

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record events outside autopilot mode", async () => {
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("online", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const messageEnd = handlers.get("message_end")?.at(0);
    if (!messageEnd) throw new Error("message_end handler was not registered");

    await messageEnd(
      { message: { role: "assistant", content: "Do you want me to continue?" } },
      ctx,
    );

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });

  it("does not record non-deferral messages during autopilot mode", async () => {
    const events: Record<string, unknown>[] = [];
    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(
      makeClient("limited", events) as any,
    );
    const { handlers } = registerHeadsDownHarness();
    const ctx = makeContext();
    await startSession(handlers, ctx);
    const messageEnd = handlers.get("message_end")?.at(0);
    if (!messageEnd) throw new Error("message_end handler was not registered");

    await messageEnd(
      { message: { role: "assistant", content: "I updated the tests and will continue." } },
      ctx,
    );

    expect(events.filter((event) => event.eventType === "deferred_decision.recorded")).toHaveLength(
      0,
    );
  });
});
