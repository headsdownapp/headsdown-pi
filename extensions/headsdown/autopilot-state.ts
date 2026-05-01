import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Mode } from "@headsdown/sdk";

export type ContractMode = Mode;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const AUTOPILOT_STATE_PATH = join(homedir(), ".config", "headsdown", "autopilot-state.json");

export function resolveAutopilotStatePath(): string {
  return process.env.HEADSDOWN_AUTOPILOT_STATE_PATH ?? AUTOPILOT_STATE_PATH;
}

export interface AutopilotState {
  lastObservedMode: ContractMode | null;
  surfacedDecisionIds: Record<string, string[]>;
  surfacedAtByDecisionId: Record<string, string>;
}

export function emptyAutopilotState(): AutopilotState {
  return {
    lastObservedMode: null,
    surfacedDecisionIds: {},
    surfacedAtByDecisionId: {},
  };
}

function isContractMode(value: unknown): value is ContractMode {
  return value === "online" || value === "busy" || value === "limited" || value === "offline";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeSurfacedDecisionIds(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([runId, decisionIds]) => [runId, normalizeStringArray(decisionIds)] as const)
    .filter(([runId, decisionIds]) => runId.length > 0 && decisionIds.length > 0);

  return Object.fromEntries(entries);
}

function normalizeSurfacedAtByDecisionId(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([decisionKey, surfacedAt]) =>
        decisionKey.length > 0 &&
        typeof surfacedAt === "string" &&
        Number.isFinite(Date.parse(surfacedAt)),
    ),
  ) as Record<string, string>;
}

function surfacedDecisionKey(runId: string, decisionId: string): string {
  return JSON.stringify([runId, decisionId]);
}

function surfacedDecisionTimestamp(
  surfacedAtByDecisionId: Record<string, string>,
  runId: string,
  decisionId: string,
): string | undefined {
  return (
    surfacedAtByDecisionId[surfacedDecisionKey(runId, decisionId)] ??
    surfacedAtByDecisionId[decisionId]
  );
}

export function normalizeAutopilotState(value: unknown): AutopilotState {
  if (!value || typeof value !== "object") return emptyAutopilotState();

  const raw = value as Record<string, unknown>;

  return {
    lastObservedMode: isContractMode(raw.lastObservedMode) ? raw.lastObservedMode : null,
    surfacedDecisionIds: normalizeSurfacedDecisionIds(raw.surfacedDecisionIds),
    surfacedAtByDecisionId: normalizeSurfacedAtByDecisionId(raw.surfacedAtByDecisionId),
  };
}

export function pruneAutopilotState(state: AutopilotState, now: Date = new Date()): AutopilotState {
  const cutoff = now.getTime() - THIRTY_DAYS_MS;
  const surfacedAtByDecisionId = Object.fromEntries(
    Object.entries(state.surfacedAtByDecisionId).filter(([, surfacedAt]) => {
      const timestamp = Date.parse(surfacedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    }),
  ) as Record<string, string>;

  const hasTimestampMap = Object.keys(state.surfacedAtByDecisionId).length > 0;
  const surfacedDecisionIds = Object.fromEntries(
    Object.entries(state.surfacedDecisionIds)
      .map(([runId, decisionIds]) => {
        const keptDecisionIds = hasTimestampMap
          ? decisionIds.filter((decisionId) =>
              surfacedDecisionTimestamp(surfacedAtByDecisionId, runId, decisionId),
            )
          : decisionIds;
        return [runId, keptDecisionIds] as const;
      })
      .filter(([, decisionIds]) => decisionIds.length > 0),
  );

  return {
    ...state,
    surfacedDecisionIds,
    surfacedAtByDecisionId,
  };
}

export function markDecisionIdsSurfaced(
  state: AutopilotState,
  entries: ReadonlyArray<{ runId: string; decisionId: string }>,
  now: Date = new Date(),
): AutopilotState {
  const surfacedDecisionIds: Record<string, string[]> = Object.fromEntries(
    Object.entries(state.surfacedDecisionIds).map(([runId, decisionIds]) => [
      runId,
      [...decisionIds],
    ]),
  );
  const surfacedAtByDecisionId = { ...state.surfacedAtByDecisionId };
  const surfacedAt = now.toISOString();

  for (const entry of entries) {
    const decisionIds = surfacedDecisionIds[entry.runId] ?? [];
    if (!decisionIds.includes(entry.decisionId)) {
      surfacedDecisionIds[entry.runId] = [...decisionIds, entry.decisionId];
    }
    surfacedAtByDecisionId[surfacedDecisionKey(entry.runId, entry.decisionId)] = surfacedAt;
  }

  return pruneAutopilotState({ ...state, surfacedDecisionIds, surfacedAtByDecisionId }, now);
}

export function removeDecisionIdsFromSurfaced(
  state: AutopilotState,
  entries: ReadonlyArray<{ runId: string; decisionId: string }>,
): AutopilotState {
  const removeByRun = new Map<string, Set<string>>();
  for (const entry of entries) {
    const existing = removeByRun.get(entry.runId) ?? new Set<string>();
    existing.add(entry.decisionId);
    removeByRun.set(entry.runId, existing);
  }

  const surfacedDecisionIds = Object.fromEntries(
    Object.entries(state.surfacedDecisionIds)
      .map(([runId, decisionIds]) => {
        const remove = removeByRun.get(runId) ?? new Set<string>();
        return [runId, decisionIds.filter((decisionId) => !remove.has(decisionId))] as const;
      })
      .filter(([, decisionIds]) => decisionIds.length > 0),
  );

  const remainingDecisionIds = new Set(Object.values(surfacedDecisionIds).flat());
  const surfacedAtByDecisionId = { ...state.surfacedAtByDecisionId };
  for (const entry of entries) {
    delete surfacedAtByDecisionId[surfacedDecisionKey(entry.runId, entry.decisionId)];
    if (!remainingDecisionIds.has(entry.decisionId)) {
      delete surfacedAtByDecisionId[entry.decisionId];
    }
  }

  return { ...state, surfacedDecisionIds, surfacedAtByDecisionId };
}

export async function loadAutopilotState(
  path: string = resolveAutopilotStatePath(),
): Promise<AutopilotState> {
  try {
    return pruneAutopilotState(normalizeAutopilotState(JSON.parse(await readFile(path, "utf-8"))));
  } catch {
    return emptyAutopilotState();
  }
}

export async function saveAutopilotState(
  state: AutopilotState,
  path: string = resolveAutopilotStatePath(),
): Promise<void> {
  const pruned = pruneAutopilotState(state);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(pruned, null, 2)}\n`, "utf-8");
}
