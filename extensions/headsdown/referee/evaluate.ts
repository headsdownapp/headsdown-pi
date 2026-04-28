import type { LocalRefereeCheck, LocalRefereeContract } from "./contract.js";
import type { LocalRefereeEvidence } from "./evidence.js";

export type LocalRefereeCheckStatus = "passed" | "failed";
export type LocalRefereeVerdict = "passed" | "needs_review";

export interface LocalRefereeCheckResult {
  id: string;
  type: LocalRefereeCheck["type"];
  status: LocalRefereeCheckStatus;
  reasonCode: string;
}

export interface LocalRefereeEvaluation {
  verdict: LocalRefereeVerdict;
  checks: LocalRefereeCheckResult[];
}

function result(
  index: number,
  check: LocalRefereeCheck,
  passed: boolean,
  reasonCode: string,
): LocalRefereeCheckResult {
  return {
    id: `check_${index + 1}`,
    type: check.type,
    status: passed ? "passed" : "failed",
    reasonCode,
  };
}

function evaluateCheck(
  check: LocalRefereeCheck,
  evidence: LocalRefereeEvidence,
  index: number,
): LocalRefereeCheckResult {
  switch (check.type) {
    case "validation_status": {
      const required = String(check.required ?? "passed");
      return result(
        index,
        check,
        evidence.validationStatus === required,
        evidence.validationStatus === required
          ? "validation_status_matched"
          : "validation_status_mismatch",
      );
    }
    case "max_files_touched": {
      const max = check.max ?? 0;
      return result(
        index,
        check,
        evidence.filesTouched <= max,
        evidence.filesTouched <= max ? "files_within_limit" : "files_over_limit",
      );
    }
    case "max_tool_calls": {
      const max = check.max ?? 0;
      return result(
        index,
        check,
        evidence.toolCalls <= max,
        evidence.toolCalls <= max ? "tool_calls_within_limit" : "tool_calls_over_limit",
      );
    }
    case "require_tests": {
      const required = check.required === true;
      return result(
        index,
        check,
        evidence.testsRun === required,
        evidence.testsRun === required ? "tests_requirement_matched" : "tests_requirement_mismatch",
      );
    }
    case "network_required": {
      const required = check.required === true;
      return result(
        index,
        check,
        evidence.networkRequired === required,
        evidence.networkRequired === required
          ? "network_requirement_matched"
          : "network_requirement_mismatch",
      );
    }
    case "outcome": {
      const required = String(check.required ?? "completed");
      return result(
        index,
        check,
        evidence.outcome === required,
        evidence.outcome === required ? "outcome_matched" : "outcome_mismatch",
      );
    }
  }
}

export function evaluateLocalRefereeContract(
  contract: LocalRefereeContract,
  evidence: LocalRefereeEvidence,
): LocalRefereeEvaluation {
  const checks = contract.checks.map((check, index) => evaluateCheck(check, evidence, index));
  return {
    verdict: checks.every((check) => check.status === "passed") ? "passed" : "needs_review",
    checks,
  };
}
