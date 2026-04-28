export const LOCAL_REFEREE_CONTRACT_PATH = ".headsdown/referee.json";

export type LocalRefereeCheckType =
  | "validation_status"
  | "max_files_touched"
  | "max_tool_calls"
  | "require_tests"
  | "network_required"
  | "outcome";

export interface LocalRefereeCheck {
  type: LocalRefereeCheckType;
  max?: number;
  required?: string | boolean;
}

export interface LocalRefereeContract {
  version: 1;
  checks: LocalRefereeCheck[];
}

const CHECK_TYPES = new Set<LocalRefereeCheckType>([
  "validation_status",
  "max_files_touched",
  "max_tool_calls",
  "require_tests",
  "network_required",
  "outcome",
]);

export class LocalRefereeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRefereeContractError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCheckType(value: unknown, index: number): LocalRefereeCheckType {
  if (typeof value !== "string")
    throw new LocalRefereeContractError(`check ${index + 1} is missing a string type.`);
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!CHECK_TYPES.has(normalized as LocalRefereeCheckType))
    throw new LocalRefereeContractError(`check ${index + 1} has unsupported type.`);
  return normalized as LocalRefereeCheckType;
}

function parseMax(value: unknown, index: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new LocalRefereeContractError(
      `check ${index + 1} requires non-negative numeric ${field}.`,
    );
  return Math.floor(value);
}

function parseRequiredString(value: unknown, index: number, allowed: string[]): string {
  if (typeof value !== "string")
    throw new LocalRefereeContractError(`check ${index + 1} requires a string required value.`);
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!allowed.includes(normalized))
    throw new LocalRefereeContractError(`check ${index + 1} has unsupported required value.`);
  return normalized;
}

function parseRequiredBoolean(value: unknown, index: number): boolean {
  if (typeof value !== "boolean")
    throw new LocalRefereeContractError(`check ${index + 1} requires a boolean required value.`);
  return value;
}

function parseCheck(value: unknown, index: number): LocalRefereeCheck {
  const record = asRecord(value);
  if (!record) throw new LocalRefereeContractError(`check ${index + 1} must be an object.`);

  const type = parseCheckType(record.type, index);
  switch (type) {
    case "validation_status":
      return {
        type,
        required: parseRequiredString(record.required ?? "passed", index, [
          "passed",
          "failed",
          "unknown",
        ]),
      };
    case "max_files_touched":
    case "max_tool_calls":
      return { type, max: parseMax(record.max, index, "max") };
    case "require_tests":
    case "network_required":
      return { type, required: parseRequiredBoolean(record.required ?? true, index) };
    case "outcome":
      return {
        type,
        required: parseRequiredString(record.required ?? "completed", index, [
          "completed",
          "partially_completed",
          "blocked",
          "unknown",
        ]),
      };
  }
}

export function parseLocalRefereeContract(value: unknown): LocalRefereeContract {
  const record = asRecord(value);
  if (!record) throw new LocalRefereeContractError("Local Referee contract must be a JSON object.");
  if (record.version !== 1)
    throw new LocalRefereeContractError("Local Referee contract version must be 1.");
  if (!Array.isArray(record.checks) || record.checks.length === 0)
    throw new LocalRefereeContractError("Local Referee contract requires at least one check.");
  return { version: 1, checks: record.checks.map((check, index) => parseCheck(check, index)) };
}

export function parseLocalRefereeContractJson(contents: string): LocalRefereeContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new LocalRefereeContractError("Local Referee contract must be valid JSON.");
  }
  return parseLocalRefereeContract(parsed);
}
