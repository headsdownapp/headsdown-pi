import { describe, expect, it } from "vitest";
import { buildProposalInput, deriveProposalIdempotencyKey } from "../extensions/headsdown/index.js";

describe("proposal idempotency key derivation", () => {
  it("uses explicit idempotency_key when provided", () => {
    const input = buildProposalInput(
      {
        description: "Refactor auth resolver",
        idempotency_key: "  client-provided-key  ",
        source_ref: "ticket-142",
        delivery_mode: "auto",
      },
      "tool-1",
    );

    expect((input as { idempotencyKey?: string }).idempotencyKey).toBe("client-provided-key");
  });

  it("derives fallback keys from tool call id when idempotency_key is omitted", () => {
    const params = {
      description: "Refactor auth resolver",
      estimated_files: 2,
      estimated_minutes: 15,
      scope_summary: "auth resolver",
      source_ref: "ticket-142",
      delivery_mode: "auto" as const,
    };

    const first = deriveProposalIdempotencyKey(params, "tool-1");
    const second = deriveProposalIdempotencyKey(params, "tool-1");
    const different = deriveProposalIdempotencyKey(params, "tool-2");

    expect(first).toBe(second);
    expect(first).toBe("pi-toolcall-tool-1");
    expect(different).toBe("pi-toolcall-tool-2");
  });
});
