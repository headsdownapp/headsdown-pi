import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import headsdownExtension from "../extensions/headsdown/index.js";
import {
  parseLocalRefereeContract,
  parseLocalRefereeContractJson,
  LocalRefereeContractError,
} from "../extensions/headsdown/referee/contract.js";
import { evaluateLocalRefereeContract } from "../extensions/headsdown/referee/evaluate.js";
import { normalizeLocalRefereeEvidence } from "../extensions/headsdown/referee/evidence.js";
import {
  __localRefereeRunnerInternal,
  loadLocalRefereeContract,
  runLocalReferee,
} from "../extensions/headsdown/referee/local-runner.js";

function validContract() {
  return {
    version: 1,
    checks: [
      { type: "validation_status", required: "passed" },
      { type: "max_files_touched", max: 5 },
      { type: "max_tool_calls", max: 10 },
      { type: "require_tests", required: true },
      { type: "network_required", required: false },
      { type: "outcome", required: "completed" },
    ],
  };
}

async function tempWorkspaceWithContract(contract: unknown = validContract()) {
  const cwd = await mkdtemp(join(tmpdir(), "headsdown-referee-"));
  await mkdir(join(cwd, ".headsdown"));
  await writeFile(join(cwd, ".headsdown", "referee.json"), JSON.stringify(contract), "utf-8");
  return cwd;
}

describe("Local Referee contract", () => {
  it("parses a supported repo-local completion contract", () => {
    expect(parseLocalRefereeContract(validContract())).toEqual(validContract());
  });

  it("rejects missing or invalid checks with clear validation errors", () => {
    const badContracts = [
      { version: 1, checks: [] },
      { version: 1, checks: [{ type: "raw_log_contains", required: "secret" }] },
      { version: 1, checks: [{ type: "max_files_touched", max: -1 }] },
      { version: 1, checks: [{ type: "network_required", required: "false" }] },
    ];

    for (const contract of badContracts) {
      expect(() => parseLocalRefereeContract(contract)).toThrow(LocalRefereeContractError);
    }
  });

  it("rejects malformed JSON before evaluation", () => {
    expect(() => parseLocalRefereeContractJson("{not json")).toThrow("valid JSON");
  });
});

describe("Local Referee evaluation", () => {
  it("normalizes raw local evidence into counts booleans and categories", () => {
    expect(
      normalizeLocalRefereeEvidence({
        filesTouched: "4",
        toolCalls: "8",
        validationStatus: "success",
        testsRun: "yes",
        networkRequired: "no",
        elapsedMinutes: "22",
        outcome: "complete",
      }),
    ).toMatchObject({
      filesTouched: 4,
      filesTouchedBucket: "3_to_5",
      toolCalls: 8,
      toolCallsBucket: "6_to_10",
      validationStatus: "passed",
      testsRun: true,
      networkRequired: false,
      elapsedMinutesBucket: "15_to_30",
      outcome: "completed",
    });
  });

  it("evaluates each supported check type against normalized evidence", () => {
    const evidence = normalizeLocalRefereeEvidence({
      filesTouched: 5,
      toolCalls: 10,
      validationStatus: "passed",
      testsRun: true,
      networkRequired: false,
      outcome: "completed",
    });
    const evaluation = evaluateLocalRefereeContract(
      parseLocalRefereeContract(validContract()),
      evidence,
    );

    expect(evaluation.verdict).toBe("passed");
    expect(evaluation.checks).toHaveLength(6);
    expect(evaluation.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("produces a mixed receipt when some checks fail", async () => {
    const cwd = await tempWorkspaceWithContract();
    const result = await runLocalReferee({
      cwd,
      evidence: {
        filesTouched: 7,
        toolCalls: 4,
        validationStatus: "failed",
        testsRun: true,
        networkRequired: false,
        outcome: "completed",
      },
    });

    expect(result.evaluation.verdict).toBe("needs_review");
    expect(result.evaluation.checks.map((check) => check.status)).toContain("failed");
    expect(result.receipt.checks.map((check) => check.reasonCode)).toContain("files_over_limit");
    expect(result.receipt.checks.map((check) => check.reasonCode)).toContain(
      "validation_status_mismatch",
    );
  });
});

describe("Local Referee receipt and runner", () => {
  it("keeps contract loading confined to the workspace", async () => {
    const cwd = await tempWorkspaceWithContract();

    await expect(
      loadLocalRefereeContract({ cwd, contractPath: "../outside.json" }),
    ).rejects.toThrow("inside the workspace");
  });

  it("rejects workspace symlinks that point contracts outside the workspace", async () => {
    const cwd = await tempWorkspaceWithContract();
    const outside = await mkdtemp(join(tmpdir(), "headsdown-referee-outside-"));
    await writeFile(join(outside, "outside.json"), JSON.stringify(validContract()), "utf-8");
    await symlink(join(outside, "outside.json"), join(cwd, ".headsdown", "linked.json"));

    await expect(
      loadLocalRefereeContract({ cwd, contractPath: ".headsdown/linked.json" }),
    ).rejects.toThrow("inside the workspace");
  });

  it("counts untracked files individually when collecting git status", () => {
    expect(__localRefereeRunnerInternal.GIT_STATUS_ARGS).toEqual([
      "status",
      "--short",
      "--untracked-files=all",
    ]);
  });

  it("runs local verification without HeadsDown credentials or network calls", async () => {
    const cwd = await tempWorkspaceWithContract();
    const gitStatusShort = vi.fn().mockResolvedValue(" M safe-one\n M safe-two\n");

    const result = await runLocalReferee({
      cwd,
      evidence: {
        toolCalls: 3,
        validationStatus: "passed",
        testsRun: true,
        networkRequired: false,
        outcome: "completed",
      },
      adapters: { gitStatusShort },
    });

    expect(gitStatusShort).toHaveBeenCalledWith(cwd);
    expect(result.evaluation.verdict).toBe("passed");
    expect(result.receipt.evidence.filesTouchedBucket).toBe("1_to_2");
  });

  it("sanitizes the receipt so raw local details are not exposed", async () => {
    const cwd = await tempWorkspaceWithContract({
      version: 1,
      checks: [
        {
          type: "validation_status",
          required: "passed",
          note: "do not leak prompt prose SECRET_PROMPT",
        },
        { type: "max_files_touched", max: 5, path: "/private/repo/src/secret.ts" },
      ],
      branch: "feature/secret-branch",
      repo: "git@example.com:secret/repo.git",
      log: "terminal output TOKEN_123",
    });

    const result = await runLocalReferee({
      cwd,
      evidence: {
        filesTouched: 2,
        toolCalls: 4,
        validationStatus: "passed",
        testsRun: true,
        networkRequired: false,
        outcome: "completed",
        elapsedMinutes: 18,
      },
      adapters: { gitStatusShort: vi.fn().mockResolvedValue(" M /private/repo/src/secret.ts\n") },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const serialized = JSON.stringify(result.receipt) + "\n" + result.renderedReceipt;

    expect(serialized).toContain("filesTouchedBucket");
    expect(serialized).not.toContain("SECRET_PROMPT");
    expect(serialized).not.toContain("/private/repo");
    expect(serialized).not.toContain("secret-branch");
    expect(serialized).not.toContain("git@example.com");
    expect(serialized).not.toContain("TOKEN_123");
    expect(serialized).not.toContain("terminal output TOKEN_123");
  });

  it("exposes the registered headsdown_referee tool as an account-optional local path", async () => {
    const cwd = await tempWorkspaceWithContract();
    const tools = new Map<string, any>();
    const pi = {
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    headsdownExtension(pi as any);
    const tool = tools.get("headsdown_referee");

    expect(tool).toBeTruthy();
    const result = await tool.execute(
      "tool-call",
      {
        evidence: {
          files_touched: 1,
          tool_calls: 1,
          validation_status: "passed",
          tests_run: true,
          network_required: false,
          outcome: "completed",
        },
      },
      new AbortController().signal,
      vi.fn(),
      { cwd },
    );

    expect(result.content[0].text).toContain("HEADSDOWN LOCAL REFEREE RECEIPT");
    expect(result.content[0].text).not.toContain("Not authenticated");
    expect(result.details.evaluation.verdict).toBe("passed");
  });
});
