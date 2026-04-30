import { HeadsDownClient } from "@headsdown/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import headsdownExtension from "../extensions/headsdown/index.js";

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

  return { command, handlers };
}

function makeCommandContext() {
  return {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: {
      getBranch: vi.fn(() => []),
      getSessionId: vi.fn(() => "session-1"),
    },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

function makeOverview() {
  return {
    headsdownCall: {
      key: "ATTENTION_WINDOW_CLOSING",
      allowedActionKeys: ["ALLOW_FOR_DURATION", "PAUSE_AND_SUMMARIZE"],
    },
    runSummaries: [
      {
        runId: "run-warning-1",
        callKey: "ATTENTION_WINDOW_CLOSING",
        actionState: "AWAITING_ACTION",
        allowedActionKeys: ["ALLOW_FOR_DURATION", "PAUSE_AND_SUMMARIZE"],
      },
    ],
  };
}

function makeAvailability() {
  return {
    contract: { id: "contract-1", mode: "busy", lock: false },
    schedule: {
      inReachableHours: true,
      nextTransitionAt: "2026-04-28T11:00:00.000Z",
      wrapUpGuidance: {
        active: true,
        remainingMinutes: 8,
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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("attention window command actions", () => {
  it("submits /headsdown extend with validated action payload", async () => {
    const { command } = registerHeadsDownHarness();
    const ctx = makeCommandContext();

    const applyCalls: Array<{ actionKey: string; input: Record<string, unknown> }> = [];
    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => makeAvailability()),
      getAgentControlOverview: vi.fn(async () => makeOverview()),
      applyHeadsDownAction: vi.fn(async function (
        actionKey: string,
        input: Record<string, unknown>,
      ) {
        applyCalls.push({ actionKey, input });
        return {
          ok: true,
          runSummary: {
            runId: "run-warning-1",
            callKey: "ATTENTION_WINDOW_CLOSING",
            allowedActionKeys: ["ALLOW_FOR_DURATION", "PAUSE_AND_SUMMARIZE"],
          },
        };
      }),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    await command.handler("extend 30m", ctx);

    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]?.actionKey).toBe("allow_for_duration");
    expect(applyCalls[0]?.input).toMatchObject({
      runId: "run-warning-1",
      actionKey: "allow_for_duration",
      durationMinutes: 30,
      source: "pi_extend_command",
    });
    expect(String(applyCalls[0]?.input.idempotencyKey)).toContain("allow_for_duration:30");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[HeadsDown] Extend submitted for 30 minutes.",
      "info",
    );
  });

  it("catches /headsdown wrap apply failures and reports actionable warning", async () => {
    const { command } = registerHeadsDownHarness();
    const ctx = makeCommandContext();

    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => makeAvailability()),
      getAgentControlOverview: vi.fn(async () => makeOverview()),
      applyHeadsDownAction: vi.fn(async () => {
        throw new Error("backend timeout");
      }),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    await command.handler("wrap", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Wrap failed for run run-warning-1: backend timeout"),
      "warning",
    );
  });

  it("reports unsupported/empty overview distinctly from no-active-run", async () => {
    const { command } = registerHeadsDownHarness();
    const ctx = makeCommandContext();

    const client = {
      withActor: vi.fn(function (this: any) {
        return this;
      }),
      getAvailability: vi.fn(async () => makeAvailability()),
      getAgentControlOverview: vi.fn(async () => null),
    };

    vi.spyOn(HeadsDownClient, "fromCredentials").mockResolvedValue(client as any);

    await command.handler("wrap", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[HeadsDown] Unable to verify warning actions with the current client/backend support. Re-check with /headsdown status.",
      "warning",
    );
  });
});
