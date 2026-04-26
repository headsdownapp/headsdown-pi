import { describe, it, expect } from "vitest";
import { __internal } from "../extensions/headsdown/index.js";

describe("availability compatibility fallback", () => {
  it("falls back to availability query and keeps graphql request bound", async () => {
    const graphql = {
      marker: "bound",
      async request(query: string) {
        expect(this).toBe(graphql);
        expect(query).toContain("query AvailabilityCompat");
        return {
          activeContract: {
            id: "contract-1",
            mode: "online",
          },
          availability: {
            inReachableHours: true,
            nextTransitionAt: "2026-04-20T18:00:00Z",
          },
        };
      },
    };

    const client = {
      async getAvailability() {
        throw new Error('GraphQL error: Cannot query field "calendar" on type "RootQueryType".');
      },
      graphql,
    };

    const result = await __internal.getAvailabilityContext(client as any);
    expect(result.contract).toEqual({ id: "contract-1", mode: "online" });
    expect(result.calendar).toBeNull();
    expect(result.schedule).toEqual({
      inReachableHours: true,
      nextTransitionAt: "2026-04-20T18:00:00Z",
    });
  });

  it("rethrows non-calendar errors", async () => {
    const client = {
      async getAvailability() {
        throw new Error("boom");
      },
    };

    await expect(__internal.getAvailabilityContext(client as any)).rejects.toThrow("boom");
  });
});

describe("actor context wiring", () => {
  it("builds actor context from session and cwd", () => {
    const ctx = {
      cwd: "/repo/headsdown-pi",
      sessionManager: {
        getSessionId: () => "session-123",
      },
    };

    expect(__internal.buildActorContext(ctx as any)).toEqual({
      source: "pi",
      agentId: "pi-agent",
      sessionId: "session-123",
      workspaceRef: __internal.toOpaqueWorkspaceRef("/repo/headsdown-pi"),
    });
  });

  it("applies actor context via withActor", () => {
    const client = {
      withActor: (actorContext: unknown) => ({ actorContext }),
    };

    const scoped = __internal.withActorContext(
      client as any,
      {
        cwd: "/repo/headsdown-pi",
        sessionManager: { getSessionId: () => "session-abc" },
      } as any,
    );

    expect(scoped).toEqual({
      actorContext: {
        source: "pi",
        agentId: "pi-agent",
        sessionId: "session-abc",
        workspaceRef: __internal.toOpaqueWorkspaceRef("/repo/headsdown-pi"),
      },
    });
  });
});

describe("bash mutation classification helpers", () => {
  it("classifies common read-only commands as read-only", () => {
    expect(__internal.isReadonlyBashCommand("git status")).toBe(true);
    expect(__internal.isReadonlyBashCommand("ls -la")).toBe(true);
    expect(__internal.isPotentiallyMutatingBashCommand("git status")).toBe(false);
  });

  it("classifies common mutating commands as mutating", () => {
    expect(__internal.isPotentiallyMutatingBashCommand("touch tmp.txt")).toBe(true);
    expect(__internal.isPotentiallyMutatingBashCommand("echo hello > notes.txt")).toBe(true);
    expect(__internal.isPotentiallyMutatingBashCommand("git add . && git commit -m test")).toBe(
      true,
    );
  });

  it("exposes continuation path under user config directory", () => {
    expect(__internal.CONTINUATION_PATH).toContain(".config/headsdown/continuation.json");
  });
});

describe("headsdown compaction helper", () => {
  it("returns null when there is no HeadsDown continuity context", () => {
    const compaction = __internal.buildHeadsDownCompaction({
      availabilitySummary: null,
      wrapUpInstruction: null,
      proposal: null,
      scope: null,
      firstKeptEntryId: "msg-1",
      tokensBefore: 1234,
    });

    expect(compaction).toBeNull();
  });

  it("returns custom compaction summary with preserved metadata when context exists", () => {
    const compaction = __internal.buildHeadsDownCompaction({
      availabilitySummary: "Mode: busy, 12min remaining",
      wrapUpInstruction: "Execution policy: wrap up current slice.",
      proposal: {
        id: "proposal-1",
        decision: "approved",
        description: "Refactor auth service",
        evaluatedAt: "2026-04-22T00:00:00Z",
        estimatedFiles: 3,
        estimatedMinutes: 45,
        scopeSummary: "auth module + tests",
        sourceRef: "ticket-123",
      },
      scope: {
        proposalId: "proposal-1",
        modifiedFiles: ["lib/auth.ts", "test/auth.test.ts"],
        warningSent: true,
        updatedAt: "2026-04-22T00:05:00Z",
      },
      firstKeptEntryId: "msg-42",
      tokensBefore: 5555,
    });

    expect(compaction).toBeTruthy();
    expect(compaction!.firstKeptEntryId).toBe("msg-42");
    expect(compaction!.tokensBefore).toBe(5555);
    expect(compaction!.summary).toContain("## HeadsDown continuity");
    expect(compaction!.summary).toContain("Refactor auth service");
    expect(compaction!.details.v).toBe(1);
    expect(compaction!.details.headsdown.proposal?.id).toBe("proposal-1");
    expect(compaction!.details.headsdown.scope?.modifiedFiles).toEqual([
      "lib/auth.ts",
      "test/auth.test.ts",
    ]);
  });
});

describe("availability override compatibility", () => {
  it("uses native SDK override methods when available", async () => {
    const created = await __internal.createAvailabilityOverrideCompat(
      {
        createAvailabilityOverride: async (input: unknown) => ({ id: "ovr-1", input }),
      } as any,
      { mode: "busy", durationMinutes: 30 },
    );

    expect(created).toEqual({ id: "ovr-1", input: { mode: "busy", durationMinutes: 30 } });
  });

  it("falls back to GraphQL for active/get/cancel override when SDK methods are absent", async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const client = {
      graphql: {
        async request(query: string, variables?: Record<string, unknown>) {
          calls.push({ query, variables });
          if (query.includes("query ActiveAvailabilityOverride")) {
            return {
              activeAvailabilityOverride: {
                id: "ovr-1",
                mode: "busy",
              },
            };
          }
          if (query.includes("mutation CreateAvailabilityOverride")) {
            return {
              createAvailabilityOverride: {
                id: "ovr-2",
                mode: "limited",
              },
            };
          }
          return {
            cancelAvailabilityOverride: {
              id: "ovr-2",
              mode: "limited",
              cancelledAt: "2026-04-21T00:00:00Z",
            },
          };
        },
      },
    };

    const active = await __internal.getActiveAvailabilityOverrideCompat(client as any);
    expect(active).toEqual({ id: "ovr-1", mode: "busy" });

    const created = await __internal.createAvailabilityOverrideCompat(client as any, {
      mode: "limited",
      durationMinutes: 20,
      source: "pi",
    });
    expect(created).toEqual({ id: "ovr-2", mode: "limited" });

    const cancelled = await __internal.cancelAvailabilityOverrideCompat(
      client as any,
      "ovr-2",
      "done",
    );
    expect(cancelled).toEqual({
      id: "ovr-2",
      mode: "limited",
      cancelledAt: "2026-04-21T00:00:00Z",
    });

    expect(calls[0]!.query).toContain("ActiveAvailabilityOverride");
    expect(calls[1]!.variables).toEqual({
      input: { mode: "limited", durationMinutes: 20, source: "pi" },
    });
    expect(calls[2]!.variables).toEqual({ id: "ovr-2", reason: "done", source: "pi" });
  });
});

describe("agent control off-clock queue flow", () => {
  it("selects off-the-clock queue_for_morning run candidates and builds queue handoff artifact", () => {
    const selected = __internal.pickQueueForMorningRun([
      {
        runId: "run-not-off-clock",
        callKey: "needs_your_yes",
        actionState: "awaiting_action",
        allowedActionKeys: ["queue_for_morning", "keep_queued"],
        safeTitle: "Different call",
        clientLabel: "Pi",
        resumeEligibleAt: null,
        nextWorkWindowStartsAt: null,
        handoffAvailable: false,
        handoffState: "missing",
      },
      {
        runId: "run-1",
        callKey: "off_the_clock",
        actionState: "queued",
        allowedActionKeys: ["keep_queued"],
        safeTitle: "Old run",
        clientLabel: "Pi",
        resumeEligibleAt: null,
        nextWorkWindowStartsAt: null,
        handoffAvailable: false,
        handoffState: "missing",
      },
      {
        runId: "run-2",
        callKey: "off_the_clock",
        actionState: "awaiting_action",
        allowedActionKeys: ["queue_for_morning", "keep_queued"],
        safeTitle: "Bug fix",
        clientLabel: "Pi",
        resumeEligibleAt: null,
        nextWorkWindowStartsAt: "2026-04-27T15:00:00Z",
        handoffAvailable: false,
        handoffState: "missing",
      },
    ]);

    expect(selected?.runId).toBe("run-2");

    const artifact = __internal.buildQueuedForMorningContinuationArtifact(selected!, "main");
    expect(artifact.reason).toBe("queue-for-morning");
    expect(artifact.completedSteps).toContain("Queued for morning.");
    expect(artifact.resumeInstruction).toBe("Ready to resume. Resume approved work.");
    expect(artifact.wrapUpInstruction).toContain("Your night stays yours");
  });

  it("normalizes uppercase enum payloads before queue and resume comparisons", () => {
    const normalized = __internal.normalizeAgentControlOverviewPayload({
      headsdownCall: {
        key: "OFF_THE_CLOCK",
        title: "Off the clock",
        body: "Body",
        recommendedActionKey: "QUEUE_FOR_MORNING",
        allowedActionKeys: ["QUEUE_FOR_MORNING", "KEEP_QUEUED"],
        reasonCodes: ["OFF_CLOCK"],
      },
      runSummaries: [
        {
          runId: "run-upper",
          callKey: "OFF_THE_CLOCK",
          actionState: "READY_TO_RESUME",
          allowedActionKeys: ["QUEUE_FOR_MORNING", "KEEP_QUEUED", "RESUME_RUN"],
          safeTitle: "Nightly ask",
          clientLabel: "Pi",
          resumeEligibleAt: "2026-04-27T15:00:00Z",
          nextWorkWindowStartsAt: "2026-04-27T15:00:00Z",
          handoffAvailable: true,
          handoffState: "SAVED",
        },
      ],
    });

    expect(normalized?.headsdownCall?.key).toBe("off_the_clock");
    expect(normalized?.headsdownCall?.recommendedActionKey).toBe("queue_for_morning");
    expect(normalized?.headsdownCall?.allowedActionKeys).toEqual([
      "queue_for_morning",
      "keep_queued",
    ]);

    const run = normalized?.runSummaries[0];
    expect(run?.actionState).toBe("ready_to_resume");
    expect(run?.allowedActionKeys).toContain("resume_run");
    expect(__internal.shouldAutoQueueForMorning(run as any, new Set<string>())).toBe(false);
    expect(__internal.isAlreadyQueuedForMorning(run as any)).toBe(true);
  });

  it("preserves native SDK method receivers for agent-control compat calls", async () => {
    const client = {
      async getAgentControlOverview() {
        expect(this).toBe(client);
        return {
          headsdownCall: { key: "READY_TO_RESUME" },
          runSummaries: [],
        };
      },
      async applyHeadsDownAction(input: Record<string, unknown>) {
        expect(this).toBe(client);
        expect(input).toEqual({ runId: "run-native", actionKey: "resume_run" });
        return {
          ok: true,
          runSummary: {
            runId: "run-native",
            callKey: "READY_TO_RESUME",
            actionState: "READY_TO_RESUME",
            allowedActionKeys: ["RESUME_RUN"],
            handoffAvailable: true,
            handoffState: "SAVED",
          },
        };
      },
    };

    const overview = await __internal.getAgentControlOverviewCompat(client as any);
    expect(overview?.headsdownCall?.key).toBe("ready_to_resume");

    const result = await __internal.applyHeadsDownActionCompat(client as any, {
      runId: "run-native",
      actionKey: "resume_run",
    });
    expect(result.ok).toBe(true);
    expect(result.runSummary?.allowedActionKeys).toEqual(["resume_run"]);
  });

  it("does not auto-queue queue_for_morning on non-off-clock runs", () => {
    const run = {
      runId: "run-needs-yes",
      callKey: "needs_your_yes",
      actionState: "awaiting_action",
      allowedActionKeys: ["queue_for_morning", "keep_queued"],
      safeTitle: "Needs yes",
      clientLabel: "Pi",
      resumeEligibleAt: null,
      nextWorkWindowStartsAt: null,
      handoffAvailable: false,
      handoffState: "missing",
    };

    expect(__internal.pickQueueForMorningRun([run as any])).toBeNull();
    expect(__internal.shouldAutoQueueForMorning(run as any, new Set<string>())).toBe(false);
  });

  it("skips auto queue side effects when run is already queued or handoff is saved", () => {
    const alreadyQueued = {
      runId: "run-queued",
      callKey: "off_the_clock",
      actionState: "queued_for_morning",
      allowedActionKeys: ["queue_for_morning", "keep_queued"],
      safeTitle: "Queued run",
      clientLabel: "Pi",
      resumeEligibleAt: null,
      nextWorkWindowStartsAt: null,
      handoffAvailable: true,
      handoffState: "saved",
    };

    const queuedRunIds = new Set<string>(["run-memoized"]);

    expect(__internal.isAlreadyQueuedForMorning(alreadyQueued as any)).toBe(true);
    expect(__internal.shouldAutoQueueForMorning(alreadyQueued as any, new Set<string>())).toBe(
      false,
    );

    const memoizedRun = {
      ...alreadyQueued,
      runId: "run-memoized",
      actionState: "awaiting_action",
      handoffAvailable: false,
      handoffState: "missing",
    };

    expect(__internal.shouldAutoQueueForMorning(memoizedRun as any, queuedRunIds)).toBe(false);
  });

  it("saves continuation before reporting saved handoff to the backend", async () => {
    const actionCalls: Array<Record<string, unknown>> = [];
    const client = {
      graphql: {
        async request(query: string, variables?: Record<string, unknown>) {
          if (query.includes("mutation ApplyHeadsDownActionForPi")) {
            actionCalls.push({ query, variables });
            return {
              applyHeadsdownAction: {
                ok: true,
                runSummary: {
                  runId: "run-queue",
                  callKey: "ready_to_resume",
                  actionState: "queued_for_morning",
                  allowedActionKeys: ["resume_run", "keep_queued"],
                  safeTitle: "Nightly ask",
                  clientLabel: "Pi",
                  resumeEligibleAt: "2026-04-27T15:00:00Z",
                  nextWorkWindowStartsAt: "2026-04-27T15:00:00Z",
                  handoffAvailable: true,
                  handoffState: "saved",
                },
              },
            };
          }

          throw new Error(`unexpected query: ${query}`);
        },
      },
    };

    const savedArtifacts: Array<Record<string, unknown>> = [];
    const result = await __internal.queueForMorningWithHandoff({
      actorClient: client as any,
      runSummary: {
        runId: "run-queue",
        callKey: "off_the_clock",
        actionState: "awaiting_action",
        allowedActionKeys: ["queue_for_morning", "keep_queued"],
        safeTitle: "Nightly ask",
        clientLabel: "Pi",
        resumeEligibleAt: null,
        nextWorkWindowStartsAt: "2026-04-27T15:00:00Z",
        handoffAvailable: false,
        handoffState: "missing",
      },
      branch: "feature/off-clock",
      saveContinuation: async (artifact: any) => {
        savedArtifacts.push(artifact);
      },
    });

    expect(result.queued).toBe(true);
    expect(result.handoffSaved).toBe(true);
    expect(result.message).toContain("Queued for morning");
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]!.variables).toEqual({
      input: {
        runId: "run-queue",
        actionKey: "queue_for_morning",
        reason: "Off the clock. Queued for morning. Your night stays yours.",
        source: "pi",
        client: "pi",
        nextWorkWindowStartsAt: "2026-04-27T15:00:00Z",
        handoffAvailable: true,
        handoffState: "SAVED",
        handoffSource: "pi",
        handoffKind: "continuation",
        handoffCapturedAt: expect.any(String),
      },
    });
    expect(savedArtifacts).toHaveLength(1);
    expect(savedArtifacts[0]!.resumeInstruction).toBe("Ready to resume. Resume approved work.");
  });

  it("serializes GraphQL enum inputs with backend-compatible casing", () => {
    expect(__internal.toGraphQLEnumValue("saved")).toBe("SAVED");
    expect(__internal.toGraphQLEnumValue("READY_TO_RESUME")).toBe("READY_TO_RESUME");
    expect(__internal.toGraphQLEnumValue("readyToResume")).toBe("READY_TO_RESUME");
    expect(__internal.toGraphQLEnumValue(null)).toBeUndefined();
  });

  it("does not report a saved handoff if continuation persistence fails", async () => {
    const actionCalls: Array<Record<string, unknown>> = [];
    const client = {
      graphql: {
        async request(query: string, variables?: Record<string, unknown>) {
          actionCalls.push({ query, variables });
          return { applyHeadsdownAction: { ok: true, runSummary: null } };
        },
      },
    };

    await expect(
      __internal.queueForMorningWithHandoff({
        actorClient: client as any,
        runSummary: {
          runId: "run-queue",
          callKey: "off_the_clock",
          actionState: "awaiting_action",
          allowedActionKeys: ["queue_for_morning", "keep_queued"],
          safeTitle: "Nightly ask",
          clientLabel: "Pi",
          resumeEligibleAt: null,
          nextWorkWindowStartsAt: null,
          handoffAvailable: false,
          handoffState: "missing",
        },
        branch: "feature/off-clock",
        saveContinuation: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");

    expect(actionCalls).toHaveLength(0);
  });
});
