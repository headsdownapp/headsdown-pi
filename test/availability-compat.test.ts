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
