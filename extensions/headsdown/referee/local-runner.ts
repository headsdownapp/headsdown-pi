import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  LOCAL_REFEREE_CONTRACT_PATH,
  buildLocalRefereeReceipt,
  evaluateLocalRefereeContract,
  normalizeLocalRefereeEvidence,
  parseLocalRefereeContractJson,
  renderLocalRefereeReceipt,
  type LocalRefereeContract,
  type LocalRefereeEvaluation,
  type LocalRefereeEvidence,
  type LocalRefereeRawEvidence,
  type LocalRefereeReceipt,
} from "@headsdown/sdk/referee";

const execFile = promisify(execFileCallback);
const GIT_STATUS_ARGS = ["status", "--short", "--untracked-files=all"] as const;

export interface LocalRefereeRunnerAdapters {
  readFile?: (path: string, encoding: "utf-8") => Promise<string>;
  gitStatusShort?: (cwd: string) => Promise<string>;
}

export interface LocalRefereeRunOptions {
  cwd: string;
  contractPath?: string;
  evidence?: LocalRefereeRawEvidence;
  adapters?: LocalRefereeRunnerAdapters;
  now?: Date;
}

export interface LocalRefereeRunResult {
  contract: LocalRefereeContract;
  evidence: LocalRefereeEvidence;
  evaluation: LocalRefereeEvaluation;
  receipt: LocalRefereeReceipt;
  renderedReceipt: string;
}

function assertInsideWorkspace(workspaceRoot: string, candidatePath: string): void {
  const relativePath = relative(workspaceRoot, candidatePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Local Referee contract_path must stay inside the workspace.");
  }
}

async function resolveContractPath(cwd: string, contractPath?: string): Promise<string> {
  const workspaceRoot = await realpath(cwd);
  const requestedPath = contractPath?.trim() || LOCAL_REFEREE_CONTRACT_PATH;
  const lexicalPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);
  assertInsideWorkspace(workspaceRoot, lexicalPath);

  let realContractPath: string;
  try {
    realContractPath = await realpath(lexicalPath);
  } catch {
    throw new Error(
      `Local Referee contract not found. Create ${LOCAL_REFEREE_CONTRACT_PATH} or pass contract_path.`,
    );
  }

  assertInsideWorkspace(workspaceRoot, realContractPath);
  return realContractPath;
}

async function defaultGitStatusShort(cwd: string): Promise<string> {
  const result = await execFile("git", [...GIT_STATUS_ARGS], {
    cwd,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function countTouchedFilesFromGitStatus(status: string): number {
  return status.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function countTouchedFiles(cwd: string, gitStatusShort: (cwd: string) => Promise<string>) {
  try {
    return countTouchedFilesFromGitStatus(await gitStatusShort(cwd));
  } catch {
    throw new Error(
      "Local Referee could not count touched files with git status. Pass files_touched evidence explicitly.",
    );
  }
}

function normalizeLegacyCountEvidence(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return fallback;
}

export async function loadLocalRefereeContract(options: {
  cwd: string;
  contractPath?: string;
  adapters?: LocalRefereeRunnerAdapters;
}): Promise<LocalRefereeContract> {
  const path = await resolveContractPath(options.cwd, options.contractPath);
  const read = options.adapters?.readFile ?? readFile;
  const contents = await read(path, "utf-8");

  return parseLocalRefereeContractJson(contents);
}

export async function collectLocalRefereeEvidence(options: {
  cwd: string;
  evidence?: LocalRefereeRawEvidence;
  adapters?: LocalRefereeRunnerAdapters;
}): Promise<LocalRefereeEvidence> {
  const rawEvidence = options.evidence ?? {};
  const gitStatusShort = options.adapters?.gitStatusShort ?? defaultGitStatusShort;
  const filesTouched =
    rawEvidence.filesTouched === undefined || rawEvidence.filesTouched === null
      ? await countTouchedFiles(options.cwd, gitStatusShort)
      : normalizeLegacyCountEvidence(rawEvidence.filesTouched);
  const toolCalls = normalizeLegacyCountEvidence(rawEvidence.toolCalls);

  return normalizeLocalRefereeEvidence({
    ...rawEvidence,
    filesTouched,
    toolCalls,
    networkRequired: rawEvidence.networkRequired ?? false,
  });
}

export async function runLocalReferee(
  options: LocalRefereeRunOptions,
): Promise<LocalRefereeRunResult> {
  const contract = await loadLocalRefereeContract(options);
  const evidence = await collectLocalRefereeEvidence(options);
  const evaluation = evaluateLocalRefereeContract(contract, evidence);
  const receipt = buildLocalRefereeReceipt({ contract, evidence, evaluation, now: options.now });
  return {
    contract,
    evidence,
    evaluation,
    receipt,
    renderedReceipt: renderLocalRefereeReceipt(receipt),
  };
}

export const __localRefereeRunnerInternal = {
  GIT_STATUS_ARGS,
  countTouchedFilesFromGitStatus,
  resolveContractPath,
};
