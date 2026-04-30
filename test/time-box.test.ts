import { HeadsDownClient } from "@headsdown/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import headsdownExtension, { __internal } from "../extensions/headsdown/index.js";
import {
  advanceTimeBoxForPrompt,
  createTimeBox,
  formatTimeBoxStatus,
  parseTimeBoxDuration,
  resolveEffectiveDeadline,
} from "../extensions/headsdown/time-box.js";

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
    appendEntry: vi.fn(),
  };

  headsdownExtension(pi as any);

  const command = commands.get("headsdown");
  if (!command) throw new Error("headsdown command was not registered");

  return { command, handlers, pi };
}

function registerHeadsDownCommand() {
  return registerHeadsDownHarness().command;
}

function makeCommandContext() {
  return makeCommandContextWithBranch([]);
}

function makeCommandContextWithBranch(entries: unknown[]) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: {
      getBranch: vi.fn(() => entries),
    },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("time-box duration parsing", () => {
  it("accepts seconds, minutes, hours, and combined durations", () => {
    expect(parseTimeBoxDuration("90s")).toBe(90_000);
    expect(parseTimeBoxDuration("15m")).toBe(15 * 60_000);
    expect(parseTimeBoxDuration("1h")).toBe(60 * 60_000);
    expect(parseTimeBoxDuration("1h30m")).toBe(90 * 60_000);
    expect(parseTimeBoxDuration("1h 30m")).toBe(90 * 60_000);
  });

  it("rejects malformed durations", () => {
    expect(parseTimeBoxDuration("")).toBeNull();
    expect(parseTimeBoxDuration("15")).toBeNull();
    expect(parseTimeBoxDuration("nope")).toBeNull();
    expect(parseTimeBoxDuration("1h nope")).toBeNull();
    expect(parseTimeBoxDuration("0m")).toBeNull();
  });
});

describe("time-box effective deadline resolution", () => {
  it("prefers the local box when it expires before the service deadline", () => {
    const now = Date.parse("2026-01-01T10:00:00Z");
    const box = createTimeBox(12 * 60_000, now);

    const resolved = resolveEffectiveDeadline(box, "2026-01-01T10:30:00.000Z", now);

    expect(resolved).toMatchObject({
      source: "box",
      effectiveDeadlineAt: "2026-01-01T10:12:00.000Z",
      remainingMinutes: 12,
    });
  });

  it("prefers the service deadline when it expires before the local box", () => {
    const now = Date.parse("2026-01-01T10:00:00Z");
    const box = createTimeBox(30 * 60_000, now);

    const resolved = resolveEffectiveDeadline(box, "2026-01-01T10:12:00.000Z", now);

    expect(resolved).toMatchObject({
      source: "backend",
      effectiveDeadlineAt: "2026-01-01T10:12:00.000Z",
      remainingMinutes: 12,
    });
  });

  it("ignores expired local boxes and falls back to an active service deadline", () => {
    const startedAt = Date.parse("2026-01-01T09:30:00Z");
    const now = Date.parse("2026-01-01T10:00:00Z");
    const expiredBox = createTimeBox(10 * 60_000, startedAt);

    const resolved = resolveEffectiveDeadline(expiredBox, "2026-01-01T10:12:00.000Z", now);

    expect(resolved).toMatchObject({ source: "backend", remainingMinutes: 12 });
  });

  it("returns no effective deadline when both candidates are missing or expired", () => {
    const now = Date.parse("2026-01-01T10:00:00Z");
    const expiredBox = createTimeBox(10 * 60_000, Date.parse("2026-01-01T09:30:00Z"));

    expect(resolveEffectiveDeadline(null, null, now)).toMatchObject({ source: "none" });
    expect(resolveEffectiveDeadline(expiredBox, "2026-01-01T09:50:00.000Z", now)).toMatchObject({
      source: "none",
    });
  });
});

describe("time-box status copy", () => {
  it("describes whether the box or service deadline is tighter", () => {
    const now = Date.parse("2026-01-01T10:00:00Z");
    const box = createTimeBox(15 * 60_000, now);

    expect(formatTimeBoxStatus(box, now, "2026-01-01T10:30:00.000Z")).toContain(
      "Box is tighter than service deadline by 15m.",
    );
    expect(formatTimeBoxStatus(box, now, "2026-01-01T10:05:00.000Z")).toContain(
      "Service deadline is tighter by 10m; box has no warning effect.",
    );
    expect(formatTimeBoxStatus(box, now, "2026-01-01T10:15:00.000Z")).toContain(
      "Box matches the service deadline.",
    );
  });
});

describe("time-box prompt guidance", () => {
  it("fires wind-down once at or after the wind-down moment", () => {
    const startedAt = Date.parse("2026-01-01T12:00:00Z");
    const state = createTimeBox(10 * 60_000, startedAt);

    const before = advanceTimeBoxForPrompt(state, Date.parse("2026-01-01T12:06:59Z"));
    expect(before.instruction).toBeNull();
    expect(before.state?.windDownFired).toBe(false);

    const windDown = advanceTimeBoxForPrompt(before.state, Date.parse("2026-01-01T12:07:00Z"));
    expect(windDown.instruction).toContain("Time box wind-down");
    expect(windDown.instruction).toContain("Stop opening new threads");
    expect(windDown.state?.windDownFired).toBe(true);

    const repeated = advanceTimeBoxForPrompt(windDown.state, Date.parse("2026-01-01T12:08:00Z"));
    expect(repeated.instruction).toBeNull();
    expect(repeated.state?.windDownFired).toBe(true);
  });

  it("expires once and clears state", () => {
    const startedAt = Date.parse("2026-01-01T12:00:00Z");
    const state = createTimeBox(10 * 60_000, startedAt);

    const expired = advanceTimeBoxForPrompt(state, Date.parse("2026-01-01T12:10:00Z"));

    expect(expired.instruction).toContain("Time box expired");
    expect(expired.instruction).toContain("Wrap up immediately");
    expect(expired.state).toBeNull();

    const repeated = advanceTimeBoxForPrompt(expired.state, Date.parse("2026-01-01T12:11:00Z"));
    expect(repeated.instruction).toBeNull();
    expect(repeated.state).toBeNull();
  });

  it("skips wind-down for boxes shorter than the threshold", () => {
    const startedAt = Date.parse("2026-01-01T12:00:00Z");
    const state = createTimeBox(90_000, startedAt);

    const beforeExpiration = advanceTimeBoxForPrompt(state, Date.parse("2026-01-01T12:01:00Z"));
    expect(beforeExpiration.instruction).toBeNull();
    expect(beforeExpiration.state?.windDownFired).toBe(false);

    const expired = advanceTimeBoxForPrompt(
      beforeExpiration.state,
      Date.parse("2026-01-01T12:01:30Z"),
    );
    expect(expired.instruction).toContain("Time box expired");
    expect(expired.instruction).not.toContain("Time box wind-down");
    expect(expired.state).toBeNull();
  });

  it("does not inject when no box is active", () => {
    expect(advanceTimeBoxForPrompt(null, Date.now())).toEqual({ state: null, instruction: null });
  });

  it("adds box wind-down guidance to the turn system prompt without replacing existing prompt content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const ctx = makeCommandContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");

    await command.handler("box 10m", ctx);
    vi.setSystemTime(new Date("2026-01-01T12:07:00Z"));

    const result = await beforeAgentStart(
      { prompt: "continue", systemPrompt: "base system prompt" },
      { ...ctx, hasUI: false },
    );

    expect(result.systemPrompt).toContain("base system prompt");
    expect(result.systemPrompt).toContain("Time box wind-down");
    expect(result.systemPrompt).toContain("Stop opening new threads");

    const repeated = await beforeAgentStart(
      { prompt: "continue", systemPrompt: "base system prompt" },
      { ...ctx, hasUI: false },
    );
    expect(repeated.systemPrompt).toContain("base system prompt");
    expect(repeated.systemPrompt).toContain("Wrap-Up hints");
    expect(repeated.systemPrompt).toContain("local work box");
  });

  it("adds box expiration guidance once, clears state, and leaves later turns unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const ctx = makeCommandContext();
    const beforeAgentStart = handlers.get("before_agent_start")?.at(0);
    if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");

    await command.handler("box 90s", ctx);
    vi.setSystemTime(new Date("2026-01-01T12:01:30Z"));

    const result = await beforeAgentStart(
      { prompt: "continue", systemPrompt: "base system prompt" },
      { ...ctx, hasUI: false },
    );

    expect(result.systemPrompt).toContain("base system prompt");
    expect(result.systemPrompt).toContain("Time box expired");
    expect(result.systemPrompt).toContain("Wrap up immediately");

    const repeated = await beforeAgentStart(
      { prompt: "continue", systemPrompt: "base system prompt" },
      { ...ctx, hasUI: false },
    );
    expect(repeated).toBeUndefined();

    await command.handler("box status", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });

  it("clears active time boxes on session start when no session state exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const ctx = makeCommandContext();
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("session_start handler was not registered");

    await command.handler("box 15m", ctx);
    await sessionStart({ reason: "new" }, { ...ctx, hasUI: false });
    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });

  it("packs active time box state into HeadsDown compaction details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const state = createTimeBox(15 * 60_000, Date.parse("2026-01-01T12:00:00Z"));

    const compaction = __internal.buildHeadsDownCompaction({
      availabilitySummary: null,
      wrapUpInstruction: null,
      timeBox: state,
      proposal: null,
      scope: null,
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
    });

    expect(compaction?.details.headsdown.timeBox).toEqual(state);
    expect(compaction?.summary).toContain("Active time box expires");
  });

  it("omits expired time box state from HeadsDown compaction details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:20:00Z"));
    const state = createTimeBox(15 * 60_000, Date.parse("2026-01-01T12:00:00Z"));

    const compaction = __internal.buildHeadsDownCompaction({
      availabilitySummary: "Mode: busy",
      wrapUpInstruction: null,
      timeBox: state,
      proposal: null,
      scope: null,
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
    });

    expect(compaction?.details.headsdown.timeBox).toBeNull();
    expect(compaction?.summary).not.toContain("Active time box expires");
  });

  it("restores an unexpired time box from compaction details on session start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const state = createTimeBox(15 * 60_000, Date.parse("2026-01-01T12:00:00Z"));
    const ctx = {
      ...makeCommandContext(),
      sessionManager: {
        getBranch: vi.fn(() => [
          {
            type: "compaction",
            details: { v: 1, headsdown: { timeBox: state } },
          },
        ]),
      },
    };
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("session_start handler was not registered");

    await sessionStart({ reason: "resume" }, { ...ctx, hasUI: false });
    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Active time box"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("10 minutes left"),
      "info",
    );
  });

  it("restores an unexpired time box from session state on session start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const state = createTimeBox(15 * 60_000, Date.parse("2026-01-01T12:00:00Z"));
    const ctx = {
      ...makeCommandContext(),
      sessionManager: {
        getBranch: vi.fn(() => [
          {
            type: "custom",
            customType: "headsdown-time-box",
            data: { state, updatedAt: "2026-01-01T12:00:00.000Z" },
          },
        ]),
      },
    };
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("session_start handler was not registered");

    await sessionStart({ reason: "resume" }, { ...ctx, hasUI: false });
    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Active time box"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("10 minutes left"),
      "info",
    );
  });

  it("drops an expired restored time box on session start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:20:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const state = createTimeBox(15 * 60_000, Date.parse("2026-01-01T12:00:00Z"));
    const ctx = makeCommandContextWithBranch([
      {
        type: "custom",
        customType: "headsdown-time-box",
        data: { state, updatedAt: "2026-01-01T12:00:00.000Z" },
      },
    ]);
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("session_start handler was not registered");

    await sessionStart({ reason: "resume" }, { ...ctx, hasUI: false });
    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });

  it("uses the newest unexpired restored time box when compaction and session state both exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const older = createTimeBox(15 * 60_000, Date.parse("2026-01-01T12:00:00Z"));
    const newer = createTimeBox(25 * 60_000, Date.parse("2026-01-01T12:00:00Z"));
    const ctx = makeCommandContextWithBranch([
      { type: "compaction", details: { v: 1, headsdown: { timeBox: older } } },
      {
        type: "custom",
        customType: "headsdown-time-box",
        data: { state: newer, updatedAt: "2026-01-01T12:04:00.000Z" },
      },
    ]);
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("session_start handler was not registered");

    await sessionStart({ reason: "resume" }, { ...ctx, hasUI: false });
    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("20 minutes left"),
      "info",
    );
  });

  it("ignores invalid restored time box timestamp ordering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    vi.spyOn(HeadsDownClient, "fromCredentials").mockRejectedValue(new Error("not signed in"));
    const { command, handlers } = registerHeadsDownHarness();
    const ctx = makeCommandContextWithBranch([
      {
        type: "custom",
        customType: "headsdown-time-box",
        data: {
          state: {
            startedAt: Date.parse("2026-01-01T12:10:00Z"),
            windDownAt: Date.parse("2026-01-01T12:09:00Z"),
            expiresAt: Date.parse("2026-01-01T12:20:00Z"),
            windDownFired: false,
          },
          updatedAt: "2026-01-01T12:04:00.000Z",
        },
      },
    ]);
    const sessionStart = handlers.get("session_start")?.at(0);
    if (!sessionStart) throw new Error("session_start handler was not registered");

    await sessionStart({ reason: "resume" }, { ...ctx, hasUI: false });
    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });
});

describe("/headsdown box command", () => {
  it("declares, replaces, reports, and clears an active time box", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("box 15m", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Time box set"), "info");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wind-down begins"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Expires at"), "info");

    await command.handler("box 1h", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Time box replaced"),
      "info",
    );

    await command.handler("box status", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Active time box"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Declared at"), "info");

    await command.handler("box clear", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "[HeadsDown] Time box cleared. No active time box.",
      "info",
    );

    await command.handler("box status", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });

  it("persists set and clear entries while cleaning up UI state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const { command, pi } = registerHeadsDownHarness();
    const ctx = makeCommandContext();

    await command.handler("box 15m", ctx);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "headsdown-time-box",
      expect.objectContaining({
        state: expect.objectContaining({ expiresAt: Date.parse("2026-01-01T12:15:00Z") }),
      }),
    );

    await command.handler("box clear", ctx);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      "headsdown-time-box",
      expect.objectContaining({ state: null }),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(__internal.TIME_BOX_STATUS_KEY, undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(__internal.TIME_BOX_WIDGET_KEY, undefined);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      __internal.ATTENTION_WINDOW_STATUS_KEY,
      undefined,
    );
  });

  it("warns when time-box persistence is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn(
        (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
          commands.set(name, command);
        },
      ),
      registerTool: vi.fn(),
      on: vi.fn(),
      getThinkingLevel: vi.fn(() => "medium"),
      setThinkingLevel: vi.fn(),
    };
    headsdownExtension(pi as any);
    const command = commands.get("headsdown");
    if (!command) throw new Error("headsdown command was not registered");
    const ctx = makeCommandContext();

    await command.handler("box 15m", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("cannot persist it across resume"),
      "warning",
    );
  });

  it("rejects malformed durations without creating a box", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("box nope", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Invalid time box duration"),
      "warning",
    );

    await command.handler("box status", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });

  it("reports short-box status with wind-down skipped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("box 90s", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Wind-down skipped"),
      "info",
    );

    await command.handler("box status", ctx);
    const status = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
    expect(status).toContain("Active time box");
    expect(status).toContain("Wind-down is skipped");
  });

  it("clears expired boxes during status instead of showing stale state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("box 90s", ctx);
    vi.setSystemTime(new Date("2026-01-01T12:01:30Z"));

    await command.handler("box status", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith("[HeadsDown] No active time box.", "info");
  });

  it("sets a fresh box after an expired one without treating it as replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("box 90s", ctx);
    vi.setSystemTime(new Date("2026-01-01T12:01:30Z"));
    await command.handler("box 15m", ctx);

    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Time box set"), "info");
    expect(ctx.ui.notify).not.toHaveBeenLastCalledWith(
      expect.stringContaining("Time box replaced"),
      "info",
    );
  });
});
