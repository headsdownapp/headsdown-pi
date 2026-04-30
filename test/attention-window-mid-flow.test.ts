import { HeadsDownClient } from "@headsdown/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import headsdownExtension, { __internal } from "../extensions/headsdown/index.js";

function registerHeadsDownHarness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const pi = {
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn((eventName: string, handler: (event: any, ctx: any) => Promise<any>) => {
      const existing = handlers.get(eventName) ?? [];
      handlers.set(eventName, [...existing, handler]);
    }),
    getThinkingLevel: vi.fn(() => "medium"),
    setThinkingLevel: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };

  headsdownExtension(pi as any);
  return { handlers, pi };
}

function makeSessionEntryWithApprovedProposal() {
  return {
    type: "custom",
    customType: "headsdown-proposal",
    data: {
      proposals: [
        {
          id: "proposal-1",
          decision: "approved",
          description: "deliver warning slice",
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
      getBranch: vi.fn(() => [makeSessionEntryWithApprovedProposal()]),
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attention window mid-flow polling", () => {
  it("notifies once per fingerprint, keeps status updated, and re-notifies on tighter threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    const toolCall = handlers.get("tool_call")?.at(0);
    if (!sessionStart || !toolCall) throw new Error("required handlers were not registered");

    const overviewState = {
      callKey: "ATTENTION_WINDOW_CLOSING",
      thresholdMinutes: 15,
    };
    const availabilityState = {
      active: true,
      remainingMinutes: 12,
      deadlineAt: "2026-04-28T10:30:00.000Z",
      thresholdMinutes: 15,
    };

    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => ({
        contract: { id: "contract-1", mode: "busy", lock: false },
        schedule: {
          inReachableHours: true,
          nextTransitionAt: "2026-04-28T11:00:00.000Z",
          wrapUpGuidance: {
            active: availabilityState.active,
            remainingMinutes: availabilityState.remainingMinutes,
            deadlineAt: availabilityState.deadlineAt,
            thresholdMinutes: availabilityState.thresholdMinutes,
            profile: "wrap_up",
            source: "threshold",
            reason: "window closing",
            hints: ["completion_first"],
            selectedMode: "wrap_up",
          },
        },
      })),
      getAgentControlOverview: vi.fn(async () => ({
        headsdownCall: { key: overviewState.callKey, allowedActionKeys: ["ALLOW_FOR_DURATION"] },
        runSummaries: [
          {
            runId: "run_proposal-1",
            callKey: "ATTENTION_WINDOW_CLOSING",
            actionState: "AWAITING_ACTION",
            allowedActionKeys: ["ALLOW_FOR_DURATION", "PAUSE_AND_SUMMARIZE"],
          },
        ],
      })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);

    const firstResult = await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);
    expect(firstResult).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Window closing"),
      "warning",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      __internal.ATTENTION_WINDOW_STATUS_KEY,
      "Window closing: 12m left. /headsdown extend or /headsdown wrap",
    );

    availabilityState.remainingMinutes = 9;
    vi.setSystemTime(new Date("2026-04-28T10:00:31.000Z"));
    const secondResult = await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);
    expect(secondResult).toBeUndefined();

    const warningCalls = ctx.ui.notify.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("Window closing"),
    );
    expect(warningCalls).toHaveLength(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      __internal.ATTENTION_WINDOW_STATUS_KEY,
      "Window closing: 9m left. /headsdown extend or /headsdown wrap",
    );

    availabilityState.remainingMinutes = 4;
    availabilityState.thresholdMinutes = 5;
    overviewState.thresholdMinutes = 5;
    vi.setSystemTime(new Date("2026-04-28T10:01:02.000Z"));
    const thirdResult = await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);
    expect(thirdResult).toBeUndefined();

    const warningCallsAfterTightening = ctx.ui.notify.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("Window closing"),
    );
    expect(warningCallsAfterTightening).toHaveLength(2);
  });

  it("clears persistent status when wrap-up guidance deactivates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    const toolCall = handlers.get("tool_call")?.at(0);
    if (!sessionStart || !toolCall) throw new Error("required handlers were not registered");

    const availabilityState = {
      active: true,
      remainingMinutes: 12,
      deadlineAt: "2026-04-28T10:30:00.000Z",
      thresholdMinutes: 15,
    };

    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => ({
        contract: { id: "contract-1", mode: "busy", lock: false },
        schedule: {
          inReachableHours: true,
          nextTransitionAt: "2026-04-28T11:00:00.000Z",
          wrapUpGuidance: {
            active: availabilityState.active,
            remainingMinutes: availabilityState.remainingMinutes,
            deadlineAt: availabilityState.deadlineAt,
            thresholdMinutes: availabilityState.thresholdMinutes,
            profile: "wrap_up",
            source: "threshold",
            reason: "window closing",
            hints: ["completion_first"],
            selectedMode: "wrap_up",
          },
        },
      })),
      getAgentControlOverview: vi.fn(async () => ({
        headsdownCall: {
          key: "ATTENTION_WINDOW_CLOSING",
          allowedActionKeys: ["ALLOW_FOR_DURATION"],
        },
        runSummaries: [
          {
            runId: "run_proposal-1",
            callKey: "ATTENTION_WINDOW_CLOSING",
            actionState: "AWAITING_ACTION",
            allowedActionKeys: ["ALLOW_FOR_DURATION", "PAUSE_AND_SUMMARIZE"],
          },
        ],
      })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);
    await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);

    availabilityState.active = false;
    vi.setSystemTime(new Date("2026-04-28T10:00:31.000Z"));
    await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      __internal.ATTENTION_WINDOW_STATUS_KEY,
      undefined,
    );
  });

  it("does not block tool execution when overview polling fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    const toolCall = handlers.get("tool_call")?.at(0);
    if (!sessionStart || !toolCall) throw new Error("required handlers were not registered");

    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => ({
        contract: { id: "contract-1", mode: "busy", lock: false },
        schedule: {
          inReachableHours: true,
          nextTransitionAt: "2026-04-28T11:00:00.000Z",
          wrapUpGuidance: {
            active: true,
            remainingMinutes: 12,
            deadlineAt: "2026-04-28T10:30:00.000Z",
            thresholdMinutes: 15,
            profile: "wrap_up",
            source: "threshold",
            reason: "window closing",
            hints: ["completion_first"],
            selectedMode: "wrap_up",
          },
        },
      })),
      getAgentControlOverview: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);

    const result = await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);
    expect(result).toBeUndefined();
    const blocked =
      typeof result === "object" && result && "block" in result
        ? (result as { block?: boolean }).block
        : false;
    expect(blocked).not.toBe(true);
  });
});
