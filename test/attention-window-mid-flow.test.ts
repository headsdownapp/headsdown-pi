import { HeadsDownClient } from "@headsdown/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import headsdownExtension, { __internal } from "../extensions/headsdown/index.js";

function registerHeadsDownHarness() {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const pi = {
    registerCommand: vi.fn(
      (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        commands.set(name, command);
      },
    ),
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
  const command = commands.get("headsdown");
  if (!command) throw new Error("headsdown command was not registered");
  return { command, handlers, pi };
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

  it("uses a tighter local time box for mid-flow warnings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { command, handlers } = registerHeadsDownHarness();
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
            remainingMinutes: 30,
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
      getAgentControlOverview: vi.fn(async () => ({
        headsdownCall: null,
        runSummaries: [],
      })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);
    await command.handler("box 12m", ctx);

    const result = await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);

    expect(result).toBeUndefined();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(__internal.TIME_BOX_STATUS_KEY, "Box: 12m left");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      __internal.ATTENTION_WINDOW_STATUS_KEY,
      "Box deadline: 12m left. Wrap cleanly or clear with /headsdown box clear",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Box deadline closing"),
      "warning",
    );
  });

  it("uses source-aware widget copy when the service deadline is tighter than the box", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { command, handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("required handlers were not registered");

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
            remainingMinutes: 2,
            deadlineAt: "2026-04-28T10:02:00.000Z",
            thresholdMinutes: 15,
            profile: "wrap_up",
            source: "threshold",
            reason: "window closing",
            hints: ["completion_first"],
            selectedMode: "wrap_up",
          },
        },
      })),
      getAgentControlOverview: vi.fn(async () => ({ headsdownCall: null, runSummaries: [] })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);
    await command.handler("box 10m", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(__internal.TIME_BOX_STATUS_KEY, "Box: 10m left");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(__internal.TIME_BOX_WIDGET_KEY, [
      "Service deadline arrives in 2m",
      "/headsdown extend 15m  /  /headsdown wrap",
    ]);
  });

  it("suppresses local threshold notifications while the user is not idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { command, handlers } = registerHeadsDownHarness();
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
            active: false,
            remainingMinutes: null,
            deadlineAt: null,
            thresholdMinutes: 15,
            profile: "normal",
            source: "threshold",
            reason: null,
            hints: [],
            selectedMode: "auto",
          },
        },
      })),
      getAgentControlOverview: vi.fn(async () => ({ headsdownCall: null, runSummaries: [] })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = { ...makeContext(), isIdle: vi.fn(() => false) };
    await sessionStart({ reason: "new" }, ctx);
    await command.handler("box 12m", ctx);

    const result = await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);

    expect(result).toBeUndefined();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      __internal.ATTENTION_WINDOW_STATUS_KEY,
      "Box deadline: 12m left. Wrap cleanly or clear with /headsdown box clear",
    );
    const warningCalls = ctx.ui.notify.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("Box deadline closing"),
    );
    expect(warningCalls).toHaveLength(0);
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

  it("respects polling cooldown before re-fetching attention-window overview", async () => {
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
    vi.setSystemTime(new Date("2026-04-28T10:00:10.000Z"));
    await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);
    vi.setSystemTime(new Date("2026-04-28T10:00:31.000Z"));
    await toolCall({ toolName: "read", input: { path: "README.md" } }, ctx);

    expect(client.getAgentControlOverview).toHaveBeenCalledTimes(2);
  });

  it("injects context hints only when guidance is fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    const contextHandler = handlers.get("context")?.at(0);
    if (!sessionStart || !contextHandler) throw new Error("required handlers were not registered");

    let failAvailability = false;
    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => {
        if (failAvailability) throw new Error("availability timeout");

        return {
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
        };
      }),
      getAgentControlOverview: vi.fn(async () => ({ headsdownCall: null, runSummaries: [] })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);

    const injected = await contextHandler(
      { messages: [{ role: "user", content: "continue" }] },
      ctx,
    );
    expect(injected?.messages).toHaveLength(2);
    expect(injected?.messages[1]).toMatchObject({
      role: "custom",
      customType: "headsdown-wrap-up-guidance",
      display: false,
    });

    failAvailability = true;
    const stale = await contextHandler({ messages: [{ role: "user", content: "continue" }] }, ctx);
    expect(stale).toBeUndefined();
  });

  it.each(["limited", "offline"])(
    "injects autopilot guidance for %s mode without deprecated framing",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

      const { handlers } = registerHeadsDownHarness();
      const sessionStart = handlers.get("session_start")?.at(0);
      const contextHandler = handlers.get("context")?.at(0);
      if (!sessionStart || !contextHandler)
        throw new Error("required handlers were not registered");

      const client = {
        withActor: vi.fn(function (this: any) {
          return this;
        }),
        getAvailability: vi.fn(async () => ({
          contract: { id: "contract-1", mode, lock: false },
          schedule: {
            inReachableHours: mode === "limited",
            nextTransitionAt: "2026-04-28T11:00:00.000Z",
            wrapUpGuidance: {
              active: false,
              remainingMinutes: null,
              deadlineAt: null,
              thresholdMinutes: 15,
              profile: "normal",
              source: "threshold",
              reason: null,
              hints: [],
              selectedMode: "auto",
            },
          },
        })),
        getAgentControlOverview: vi.fn(async () => ({ headsdownCall: null, runSummaries: [] })),
      };

      vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

      const ctx = makeContext();
      await sessionStart({ reason: "new" }, ctx);

      const injected = await contextHandler(
        { messages: [{ role: "user", content: "continue" }] },
        ctx,
      );
      expect(injected?.messages).toHaveLength(2);
      expect(injected?.messages[1]).toMatchObject({
        role: "custom",
        customType: "headsdown-autopilot-guidance",
        display: false,
      });
      const content = String(injected?.messages[1].content);
      expect(content).toContain("Autopilot active");
      expect(content).toContain("keep the run moving inside the approved scope");
      expect(content).toContain("preserve a concise review note");
      expect(content).not.toMatch(/automatic stop|rabbit[- ]hole/i);
    },
  );

  it("injects wrap-up and autopilot guidance together when both are active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    const contextHandler = handlers.get("context")?.at(0);
    if (!sessionStart || !contextHandler) throw new Error("required handlers were not registered");

    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => ({
        contract: { id: "contract-1", mode: "limited", lock: false },
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
      getAgentControlOverview: vi.fn(async () => ({ headsdownCall: null, runSummaries: [] })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);

    const injected = await contextHandler(
      { messages: [{ role: "user", content: "continue" }] },
      ctx,
    );
    expect(injected?.messages).toHaveLength(3);
    expect(injected?.messages[1]).toMatchObject({
      role: "custom",
      customType: "headsdown-wrap-up-guidance",
      display: false,
    });
    expect(injected?.messages[2]).toMatchObject({
      role: "custom",
      customType: "headsdown-autopilot-guidance",
      display: false,
    });
    expect(String(injected?.messages[1].content)).toContain("window closing");
    expect(String(injected?.messages[2].content)).toContain("Autopilot active");
  });

  it("does not inject autopilot guidance for busy mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const { handlers } = registerHeadsDownHarness();
    const sessionStart = handlers.get("session_start")?.at(0);
    const contextHandler = handlers.get("context")?.at(0);
    if (!sessionStart || !contextHandler) throw new Error("required handlers were not registered");

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
            active: false,
            remainingMinutes: null,
            deadlineAt: null,
            thresholdMinutes: 15,
            profile: "normal",
            source: "threshold",
            reason: null,
            hints: [],
            selectedMode: "auto",
          },
        },
      })),
      getAgentControlOverview: vi.fn(async () => ({ headsdownCall: null, runSummaries: [] })),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    const ctx = makeContext();
    await sessionStart({ reason: "new" }, ctx);

    const injected = await contextHandler(
      { messages: [{ role: "user", content: "continue" }] },
      ctx,
    );
    expect(injected).toBeUndefined();
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Warning checks are temporarily unavailable"),
      "warning",
    );
  });
});
