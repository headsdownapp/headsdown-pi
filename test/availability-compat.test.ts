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
      workspaceRef: "/repo/headsdown-pi",
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
        workspaceRef: "/repo/headsdown-pi",
      },
    });
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
