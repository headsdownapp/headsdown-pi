import { createHash } from "node:crypto";
import type { LocalRefereeContract } from "./contract.js";
import type { LocalRefereeEvaluation } from "./evaluate.js";
import type { LocalRefereeEvidence } from "./evidence.js";

export interface LocalRefereeReceipt {
  schemaVersion: 1;
  generatedAt: string;
  contractRef: string;
  verdict: LocalRefereeEvaluation["verdict"];
  evidence: {
    filesTouchedBucket: string;
    toolCallsBucket: string;
    validationStatus: string;
    testsRun: boolean;
    networkRequired: boolean;
    elapsedMinutesBucket: string;
    outcome: string;
  };
  checks: LocalRefereeEvaluation["checks"];
}

export function buildLocalRefereeContractRef(contract: LocalRefereeContract): string {
  const digest = createHash("sha256").update(JSON.stringify(contract)).digest("hex").slice(0, 16);
  return `contract_${digest}`;
}

export function buildLocalRefereeReceipt(input: {
  contract: LocalRefereeContract;
  evidence: LocalRefereeEvidence;
  evaluation: LocalRefereeEvaluation;
  now?: Date;
}): LocalRefereeReceipt {
  return {
    schemaVersion: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    contractRef: buildLocalRefereeContractRef(input.contract),
    verdict: input.evaluation.verdict,
    evidence: {
      filesTouchedBucket: input.evidence.filesTouchedBucket,
      toolCallsBucket: input.evidence.toolCallsBucket,
      validationStatus: input.evidence.validationStatus,
      testsRun: input.evidence.testsRun,
      networkRequired: input.evidence.networkRequired,
      elapsedMinutesBucket: input.evidence.elapsedMinutesBucket,
      outcome: input.evidence.outcome,
    },
    checks: input.evaluation.checks,
  };
}

export function renderLocalRefereeReceipt(receipt: LocalRefereeReceipt): string {
  const checkLines = receipt.checks.map(
    (check) => `- ${check.id}: ${check.status} (${check.type}, ${check.reasonCode})`,
  );
  return [
    "HEADSDOWN LOCAL REFEREE RECEIPT",
    `Verdict: ${receipt.verdict}`,
    `Contract: ${receipt.contractRef}`,
    `Generated: ${receipt.generatedAt}`,
    "Evidence:",
    `- Files touched: ${receipt.evidence.filesTouchedBucket}`,
    `- Tool calls: ${receipt.evidence.toolCallsBucket}`,
    `- Validation: ${receipt.evidence.validationStatus}`,
    `- Tests run: ${receipt.evidence.testsRun ? "yes" : "no"}`,
    `- Network required: ${receipt.evidence.networkRequired ? "yes" : "no"}`,
    `- Elapsed: ${receipt.evidence.elapsedMinutesBucket}`,
    `- Outcome: ${receipt.evidence.outcome}`,
    "Checks:",
    ...checkLines,
    "",
    "Local-only: this receipt contains derived review fields only. It does not include prompts, source code, file paths, repository names, branch names, terminal output, logs, or message contents.",
  ].join("\n");
}
