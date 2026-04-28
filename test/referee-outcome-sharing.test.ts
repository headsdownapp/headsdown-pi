import { describe, expect, it } from "vitest";
import {
  assertLocalRefereeOutcomeSummaryPayloadIsSafe,
  buildLocalRefereeOutcomeSummaryPayload,
  renderLocalRefereeOutcomeSharePreview,
  shouldShareLocalRefereeOutcomeSummary,
} from "../extensions/headsdown/referee/outcome-sharing.js";
import type { LocalRefereeReceipt } from "../extensions/headsdown/referee/receipt.js";

function fixtureReceipt(): LocalRefereeReceipt {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    contractRef: "contract_test",
    verdict: "passed",
    evidence: {
      filesTouchedBucket: "1_to_2",
      toolCallsBucket: "3_to_5",
      validationStatus: "passed",
      testsRun: true,
      networkRequired: false,
      elapsedMinutesBucket: "15_to_30",
      outcome: "completed",
    },
    checks: [
      { id: "check-1", type: "validation_status", status: "passed", reasonCode: "ok" },
      { id: "check-2", type: "max_files_touched", status: "passed", reasonCode: "ok" },
    ],
  };
}

describe("Local Referee outcome sharing payload", () => {
  it("builds metadata-only payloads from local referee receipts", () => {
    const payload = buildLocalRefereeOutcomeSummaryPayload({
      receipt: fixtureReceipt(),
      clientVersion: "0.2.0",
      executionMode: "local_only",
    });

    expect(payload).toMatchObject({
      schemaVersion: 1,
      finalState: "passed",
      completionExceptionCount: 0,
      validationStatus: "passed",
      elapsedTimeBucket: "15_to_30",
      manualReviewRoundTripEstimate: "none",
      executionMode: "local_only",
      client: { kind: "pi", version: "0.2.0" },
    });
  });

  it("rejects prohibited fields recursively", () => {
    expect(() =>
      assertLocalRefereeOutcomeSummaryPayloadIsSafe({
        safe: { nested: "ok" },
        branchName: "feature/private",
      }),
    ).toThrow("prohibited field");

    expect(() =>
      assertLocalRefereeOutcomeSummaryPayloadIsSafe({
        safe: { nested: "ok" },
        note: "https://private.example.com/path",
      }),
    ).toThrow("prohibited content");
  });

  it("renders an explicit preview with privacy boundary text", () => {
    const preview = renderLocalRefereeOutcomeSharePreview(
      buildLocalRefereeOutcomeSummaryPayload({
        receipt: fixtureReceipt(),
        clientVersion: "0.2.0",
        executionMode: "local_only",
      }),
    );

    expect(preview).toContain("Share this run summary with HeadsDown?");
    expect(preview).toContain("Summary to share:");
    expect(preview).toContain("Control decisions: 2 passed, 0 failed");
    expect(preview).toContain("Completion exceptions: 0");
    expect(preview).toContain("Manual review estimate: none");
    expect(preview).toContain("Mode: local_only");
    expect(preview).toContain("Client: pi 0.2.0");
    expect(preview).toContain("Privacy boundary");
  });
});

describe("Local Referee outcome sharing preferences", () => {
  it("keeps local mode by default and shares only with explicit choice or preference", () => {
    expect(shouldShareLocalRefereeOutcomeSummary({})).toBe(false);
    expect(
      shouldShareLocalRefereeOutcomeSummary({
        config: { preference: "always_share" },
      }),
    ).toBe(true);
    expect(
      shouldShareLocalRefereeOutcomeSummary({
        choice: "share_once",
        config: { preference: "local_only" },
      }),
    ).toBe(true);
  });
});
