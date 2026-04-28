import type { LocalRefereeReceipt } from "./receipt.js";

export type LocalRefereeOutcomeSharingPreference = "local_only" | "always_share";
export type LocalRefereeOutcomeShareChoice =
  | "preview"
  | "share_once"
  | "always_share"
  | "keep_local";

export interface LocalRefereeOutcomeSharingConfig {
  preference?: LocalRefereeOutcomeSharingPreference;
}

export interface LocalRefereeOutcomeSummaryPayload {
  schemaVersion: 1;
  finalState: LocalRefereeReceipt["verdict"];
  controlDecisionCounts: {
    passed: number;
    failed: number;
  };
  completionExceptionCount: number;
  validationStatus: string;
  elapsedTimeBucket: string;
  manualReviewRoundTripEstimate: string;
  executionMode: "local_only" | "hosted";
  client: {
    kind: "pi";
    version: string;
  };
}

const PROHIBITED_KEY_PATTERN =
  /(?:prompt|source|code|diff|file|path|repo|repository|branch|terminal|output|log|issue|pr|url|message|content|hash)/i;
const PROHIBITED_VALUE_PATTERN =
  /(?:https?:\/\/|git@|\b[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|src|lib|test)\/|\.git\b|BEGIN [A-Z ]+PRIVATE KEY|diff --git|@@\s+-\d+|console\.log|defmodule\s+|function\s+\w+|class\s+\w+)/i;

function countChecks(receipt: LocalRefereeReceipt, status: "passed" | "failed"): number {
  return receipt.checks.filter((check) => check.status === status).length;
}

function manualReviewRoundTripEstimate(receipt: LocalRefereeReceipt): string {
  const failed = countChecks(receipt, "failed");
  if (failed >= 3) return "multiple";
  if (failed >= 1 || receipt.verdict === "needs_review") return "one";
  return "none";
}

export function buildLocalRefereeOutcomeSummaryPayload(input: {
  receipt: LocalRefereeReceipt;
  clientVersion: string;
  executionMode?: "local_only" | "hosted";
}): LocalRefereeOutcomeSummaryPayload {
  const payload: LocalRefereeOutcomeSummaryPayload = {
    schemaVersion: 1,
    finalState: input.receipt.verdict,
    controlDecisionCounts: {
      passed: countChecks(input.receipt, "passed"),
      failed: countChecks(input.receipt, "failed"),
    },
    completionExceptionCount: countChecks(input.receipt, "failed"),
    validationStatus: input.receipt.evidence.validationStatus,
    elapsedTimeBucket: input.receipt.evidence.elapsedMinutesBucket,
    manualReviewRoundTripEstimate: manualReviewRoundTripEstimate(input.receipt),
    executionMode: input.executionMode ?? "local_only",
    client: { kind: "pi", version: input.clientVersion },
  };

  assertLocalRefereeOutcomeSummaryPayloadIsSafe(payload);
  return payload;
}

export function assertLocalRefereeOutcomeSummaryPayloadIsSafe(
  value: unknown,
  path = "payload",
): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (PROHIBITED_VALUE_PATTERN.test(value)) {
      throw new Error(`Outcome summary contains prohibited content at ${path}.`);
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertLocalRefereeOutcomeSummaryPayloadIsSafe(item, `${path}[${index}]`),
    );
    return;
  }

  if (typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (PROHIBITED_KEY_PATTERN.test(key)) {
        throw new Error(`Outcome summary contains prohibited field '${key}' at ${path}.`);
      }
      assertLocalRefereeOutcomeSummaryPayloadIsSafe(nestedValue, `${path}.${key}`);
    }
    return;
  }

  throw new Error(`Outcome summary contains unsupported value at ${path}.`);
}

export function shouldShareLocalRefereeOutcomeSummary(input: {
  choice?: LocalRefereeOutcomeShareChoice;
  config?: LocalRefereeOutcomeSharingConfig;
}): boolean {
  if (input.choice === "share_once" || input.choice === "always_share") return true;
  if (input.choice === "keep_local" || input.choice === "preview") return false;
  return input.config?.preference === "always_share";
}

export function renderLocalRefereeOutcomeSharePreview(
  payload: LocalRefereeOutcomeSummaryPayload,
): string {
  return [
    "Share this run summary with HeadsDown?",
    "",
    "HeadsDown can learn from the outcome without seeing the work itself.",
    "",
    "Summary to share:",
    `✓ Final state: ${payload.finalState}`,
    `✓ Validation status: ${payload.validationStatus}`,
    `✓ Control decisions: ${payload.controlDecisionCounts.passed} passed, ${payload.controlDecisionCounts.failed} failed`,
    `! Completion exceptions: ${payload.completionExceptionCount}`,
    `↩ Manual review estimate: ${payload.manualReviewRoundTripEstimate}`,
    `◷ Elapsed time: ${payload.elapsedTimeBucket}`,
    `◇ Mode: ${payload.executionMode}`,
    `◇ Client: ${payload.client.kind} ${payload.client.version}`,
    "",
    "Privacy boundary: this summary contains structured metadata only. It does not include prompts, source code, diffs, file contents, file paths, repository names, branch names, terminal output, logs, issue or PR text, URLs, message contents, or hashes of those values.",
    "",
    "Choose: share_once, always_share, or keep_local.",
  ].join("\n");
}
