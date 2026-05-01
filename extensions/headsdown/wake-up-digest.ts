import {
  LOCAL_SESSION_SUMMARY_OUTCOME_CATEGORIES,
  type AgentRunEvent,
  type LocalSessionSummary,
  type Mode,
} from "@headsdown/sdk";
import type { AutopilotState } from "./autopilot-state.js";
import { markDecisionIdsSurfaced } from "./autopilot-state.js";

export interface WakeUpDigestConfig {
  readonly enabled: boolean;
  readonly maxEntriesShown: number;
}

export const DEFAULT_WAKE_UP_DIGEST_CONFIG: WakeUpDigestConfig = {
  enabled: true,
  maxEntriesShown: 20,
};

export type ModeTransition =
  | "online_arrival"
  | "still_offline"
  | "still_online"
  | "going_offline"
  | "no_change"
  | "first_observation";

export interface DeferredDecisionEventClient {
  listAgentRunEvents(args?: {
    runId?: string;
    eventType?: string;
    flaggedForReview?: boolean;
    insertedAfter?: string;
    insertedBefore?: string;
    limit?: number;
  }): Promise<AgentRunEvent[]>;
}

export interface DeferredDecisionSummaryFacts {
  tool_call_count: number | null;
  file_change_count: number | null;
  deferred_decision_count: number | null;
  outcome_category: string | null;
  validation_locally_passed: boolean | null;
  continuation_artifact_available: boolean | null;
}

export interface DeferredDecisionEntry {
  decision_id: string;
  run_id: string;
  decision_kind: string;
  decision_category: string;
  urgency_bucket: string;
  flagged_for_review: boolean;
  recorded_at: string;
  expires_at: string | null;
  summary: DeferredDecisionSummaryFacts;
  local_session_summary?: LocalSessionSummary;
}

export interface DeferredDecisionGroup {
  run_id: string;
  entries: DeferredDecisionEntry[];
}

export interface WakeUpDigestSummary {
  count: number;
  runIds: string[];
  flaggedCount: number;
  hasFlagged: boolean;
}

export interface DeferredDecisionQueryOptions {
  now?: Date;
  daysBack?: number;
  limit?: number;
  runId?: string;
  flaggedOnly?: boolean;
  state?: AutopilotState;
  excludeSurfaced?: boolean;
}

const DEFAULT_DAYS_BACK = 30;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_ENTRIES_SHOWN_MIN = 1;
const MAX_ENTRIES_SHOWN_MAX = 50;
const SAFE_OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_SUMMARY_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const SAFE_ENUM_TOKEN_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const DECISION_KIND_VALUES = new Set(["would_have_asked", "unknown"]);
const DECISION_CATEGORY_VALUES = new Set(["unknown"]);
const URGENCY_BUCKET_VALUES = new Set(["low", "normal", "high", "unknown"]);
const LOCAL_SESSION_OUTCOME_VALUES = new Set<string>(LOCAL_SESSION_SUMMARY_OUTCOME_CATEGORIES);
const PROHIBITED_OUTPUT_KEYS = new Set([
  "transcript",
  "prompt",
  "prompts",
  "file_path",
  "filepath",
  "file_paths",
  "repo",
  "repository",
  "branch",
  "terminal_output",
  "stdout",
  "stderr",
  "test_log",
  "test_logs",
  "source_code",
  "file_contents",
  "diff",
  "raw_payload",
  "raw_text",
]);

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizeWakeUpDigestConfig(value: unknown): WakeUpDigestConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    enabled: raw.enabled !== false,
    maxEntriesShown: clampInteger(
      raw.maxEntriesShown,
      MAX_ENTRIES_SHOWN_MIN,
      MAX_ENTRIES_SHOWN_MAX,
      DEFAULT_WAKE_UP_DIGEST_CONFIG.maxEntriesShown,
    ),
  };
}

function normalizeMode(value: unknown): Mode | null {
  return value === "online" || value === "busy" || value === "limited" || value === "offline"
    ? value
    : null;
}

function isOfflineLikeMode(mode: Mode | null): boolean {
  return mode === "offline" || mode === "limited";
}

function isOnlineLikeMode(mode: Mode | null): boolean {
  return mode === "online" || mode === "busy";
}

export function detectModeTransition(previousMode: unknown, currentMode: unknown): ModeTransition {
  const previous = normalizeMode(previousMode);
  const current = normalizeMode(currentMode);

  if (!previous) return "first_observation";
  if (!current || previous === current) return "no_change";
  if (isOfflineLikeMode(previous) && isOnlineLikeMode(current)) return "online_arrival";
  if (isOfflineLikeMode(previous) && isOfflineLikeMode(current)) return "still_offline";
  if (isOnlineLikeMode(previous) && isOfflineLikeMode(current)) return "going_offline";
  if (isOnlineLikeMode(previous) && isOnlineLikeMode(current)) return "still_online";
  return "no_change";
}

export function shouldTriggerWakeUp(transition: ModeTransition, currentMode?: unknown): boolean {
  const current = normalizeMode(currentMode);
  return (
    transition === "online_arrival" ||
    (transition === "first_observation" && isOnlineLikeMode(current))
  );
}

function daysAgoIso(now: Date, daysBack: number): string {
  return new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();
}

function getString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function isSafeOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_OPAQUE_TOKEN_PATTERN.test(value);
}

function normalizeOpaqueToken(value: unknown): string | null {
  return isSafeOpaqueToken(value) ? value : null;
}

function normalizeEnumToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return SAFE_ENUM_TOKEN_PATTERN.test(token) ? token : null;
}

function normalizeDecisionKindToken(value: unknown): string {
  const token = normalizeEnumToken(value);
  return token && DECISION_KIND_VALUES.has(token) ? token : "unknown";
}

export function normalizeDecisionCategoryToken(value: unknown): string | null {
  const token = normalizeEnumToken(value);
  return token && DECISION_CATEGORY_VALUES.has(token) ? token : null;
}

export function normalizeUrgencyBucketToken(value: unknown): string | null {
  const token = normalizeEnumToken(value);
  return token && URGENCY_BUCKET_VALUES.has(token) ? token : null;
}

function getBoolean(value: Record<string, unknown>, key: string): boolean | null {
  const raw = value[key];
  return typeof raw === "boolean" ? raw : null;
}

function normalizeIsoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeSummaryToken(value: unknown): string | null {
  return typeof value === "string" && SAFE_SUMMARY_TOKEN_PATTERN.test(value) ? value : null;
}

function normalizeOutcomeCategory(value: unknown): LocalSessionSummary["outcomeCategory"] | null {
  const token = normalizeEnumToken(value);
  return token && LOCAL_SESSION_OUTCOME_VALUES.has(token)
    ? (token as LocalSessionSummary["outcomeCategory"])
    : null;
}

function normalizeLocalSessionSummary(value: unknown): LocalSessionSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<LocalSessionSummary>;
  const sessionId = normalizeSummaryToken(raw.sessionId);
  const generatedAt = normalizeIsoString(raw.generatedAt);
  const approvedProposalRef =
    raw.approvedProposalRef === null ? null : normalizeSummaryToken(raw.approvedProposalRef);
  const outcomeCategory = normalizeOutcomeCategory(raw.outcomeCategory);

  if (raw.version !== 1 || !sessionId || !generatedAt || !outcomeCategory) {
    return undefined;
  }

  return {
    version: 1,
    sessionId,
    generatedAt,
    stale: raw.stale === true,
    toolCallCount: normalizeNonNegativeInteger(raw.toolCallCount),
    fileChangeCount: normalizeNonNegativeInteger(raw.fileChangeCount),
    deferredDecisionCount: normalizeNonNegativeInteger(raw.deferredDecisionCount),
    continuationArtifactAvailable: raw.continuationArtifactAvailable === true,
    validationLocallyPassed: raw.validationLocallyPassed === true,
    approvedProposalRef,
    outcomeCategory,
  };
}

function summaryFactsFromPayload(payload: Record<string, unknown>): {
  facts: DeferredDecisionSummaryFacts;
  localSessionSummary?: LocalSessionSummary;
} {
  const localSessionSummary = normalizeLocalSessionSummary(payload.local_session_summary);

  if (!localSessionSummary) {
    return {
      facts: {
        tool_call_count: null,
        file_change_count: null,
        deferred_decision_count: null,
        outcome_category: null,
        validation_locally_passed: null,
        continuation_artifact_available: null,
      },
    };
  }

  return {
    facts: {
      tool_call_count: localSessionSummary.toolCallCount,
      file_change_count: localSessionSummary.fileChangeCount,
      deferred_decision_count: localSessionSummary.deferredDecisionCount,
      outcome_category: localSessionSummary.outcomeCategory,
      validation_locally_passed: localSessionSummary.validationLocallyPassed,
      continuation_artifact_available: localSessionSummary.continuationArtifactAvailable,
    },
    localSessionSummary,
  };
}

export function entryFromRecordedEvent(event: AgentRunEvent): DeferredDecisionEntry | null {
  const payload = event.payload ?? {};
  const decisionId = normalizeOpaqueToken(getString(payload, "decision_id"));
  const runId = normalizeOpaqueToken(event.runId);
  const occurredAt = normalizeIsoString(event.occurredAt);
  if (!decisionId || !runId || !occurredAt) return null;

  const { facts, localSessionSummary } = summaryFactsFromPayload(payload);

  return {
    decision_id: decisionId,
    run_id: runId,
    decision_kind: normalizeDecisionKindToken(payload.decision_kind),
    decision_category: normalizeDecisionCategoryToken(payload.decision_category) ?? "unknown",
    urgency_bucket: normalizeUrgencyBucketToken(payload.urgency_bucket) ?? "normal",
    flagged_for_review: getBoolean(payload, "flagged_for_review") ?? false,
    recorded_at: occurredAt,
    expires_at: normalizeIsoString(payload.expires_at),
    summary: facts,
    ...(localSessionSummary ? { local_session_summary: localSessionSummary } : {}),
  };
}

function deferredDecisionKey(runId: string, decisionId: string): string {
  return `${runId}\0${decisionId}`;
}

function resolvedDecisionKeys(events: ReadonlyArray<AgentRunEvent>): Set<string> {
  return new Set(
    events
      .map((event) => {
        const runId = normalizeOpaqueToken(event.runId);
        const decisionId = normalizeOpaqueToken(getString(event.payload ?? {}, "decision_id"));
        return runId && decisionId ? deferredDecisionKey(runId, decisionId) : null;
      })
      .filter((key): key is string => key !== null),
  );
}

function isExpired(entry: DeferredDecisionEntry, now: Date): boolean {
  return entry.expires_at !== null && Date.parse(entry.expires_at) < now.getTime();
}

function isStale(entry: DeferredDecisionEntry, now: Date, daysBack: number): boolean {
  if (entry.expires_at !== null) return false;
  const recordedAt = Date.parse(entry.recorded_at);
  return (
    !Number.isFinite(recordedAt) || recordedAt < now.getTime() - daysBack * 24 * 60 * 60 * 1000
  );
}

function isSurfaced(entry: DeferredDecisionEntry, state: AutopilotState | undefined): boolean {
  return state?.surfacedDecisionIds[entry.run_id]?.includes(entry.decision_id) === true;
}

function sortDeferredDecisionEntries(entries: DeferredDecisionEntry[]): DeferredDecisionEntry[] {
  return [...entries].sort((a, b) => {
    if (a.flagged_for_review !== b.flagged_for_review) return a.flagged_for_review ? -1 : 1;
    return Date.parse(b.recorded_at) - Date.parse(a.recorded_at);
  });
}

export function selectUnresolvedDeferredDecisionEntries(input: {
  recordedEvents: ReadonlyArray<AgentRunEvent>;
  resolvedEvents: ReadonlyArray<AgentRunEvent>;
  now?: Date;
  daysBack?: number;
  state?: AutopilotState;
  excludeSurfaced?: boolean;
  flaggedOnly?: boolean;
  runId?: string;
  limit?: number;
}): DeferredDecisionEntry[] {
  const now = input.now ?? new Date();
  const daysBack = input.daysBack ?? DEFAULT_DAYS_BACK;
  const resolvedKeys = resolvedDecisionKeys(input.resolvedEvents);

  const entries = input.recordedEvents
    .map(entryFromRecordedEvent)
    .filter((entry): entry is DeferredDecisionEntry => entry !== null)
    .filter((entry) => !resolvedKeys.has(deferredDecisionKey(entry.run_id, entry.decision_id)))
    .filter((entry) => !isExpired(entry, now))
    .filter((entry) => !isStale(entry, now, daysBack))
    .filter((entry) => entry.local_session_summary?.stale !== true)
    .filter((entry) => !input.runId || entry.run_id === input.runId)
    .filter((entry) => input.flaggedOnly !== true || entry.flagged_for_review)
    .filter((entry) => input.excludeSurfaced !== true || !isSurfaced(entry, input.state));

  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : entries.length;
  return sortDeferredDecisionEntries(entries).slice(0, limit);
}

export async function listUnresolvedDeferredDecisionEntries(
  client: DeferredDecisionEventClient,
  options: DeferredDecisionQueryOptions = {},
): Promise<DeferredDecisionEntry[]> {
  const now = options.now ?? new Date();
  const daysBack = options.daysBack ?? DEFAULT_DAYS_BACK;
  const insertedAfter = daysAgoIso(now, daysBack);
  const queryLimit =
    options.limit && options.limit > DEFAULT_QUERY_LIMIT ? options.limit : DEFAULT_QUERY_LIMIT;
  const [recordedEvents, resolvedEvents] = await Promise.all([
    client.listAgentRunEvents({
      eventType: "deferred_decision.recorded",
      insertedAfter,
      limit: queryLimit,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.flaggedOnly ? { flaggedForReview: true } : {}),
    }),
    client.listAgentRunEvents({
      eventType: "deferred_decision.resolved",
      insertedAfter,
      limit: queryLimit,
      ...(options.runId ? { runId: options.runId } : {}),
    }),
  ]);

  return selectUnresolvedDeferredDecisionEntries({
    recordedEvents,
    resolvedEvents,
    now,
    daysBack,
    state: options.state,
    excludeSurfaced: options.excludeSurfaced,
    flaggedOnly: options.flaggedOnly,
    runId: options.runId,
    limit: options.limit,
  });
}

export function groupDeferredDecisionEntries(
  entries: ReadonlyArray<DeferredDecisionEntry>,
): DeferredDecisionGroup[] {
  const groups = new Map<string, DeferredDecisionEntry[]>();

  for (const entry of entries) {
    groups.set(entry.run_id, [...(groups.get(entry.run_id) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([runId, groupEntries]) => ({
      run_id: runId,
      entries: sortDeferredDecisionEntries(groupEntries),
    }))
    .sort(
      (a, b) =>
        Date.parse(b.entries[0]?.recorded_at ?? "") - Date.parse(a.entries[0]?.recorded_at ?? ""),
    );
}

export function summarizeWakeUpDigest(
  entries: ReadonlyArray<DeferredDecisionEntry>,
): WakeUpDigestSummary {
  const runIds = [...new Set(entries.map((entry) => entry.run_id))];
  const flaggedCount = entries.filter((entry) => entry.flagged_for_review).length;

  return {
    count: entries.length,
    runIds,
    flaggedCount,
    hasFlagged: flaggedCount > 0,
  };
}

export function markWakeUpDigestSurfaced(
  state: AutopilotState,
  entries: ReadonlyArray<DeferredDecisionEntry>,
  now: Date = new Date(),
): AutopilotState {
  return markDecisionIdsSurfaced(
    state,
    entries.map((entry) => ({ runId: entry.run_id, decisionId: entry.decision_id })),
    now,
  );
}

export function formatWakeUpDigestInstruction(summary: WakeUpDigestSummary): string | null {
  if (summary.count <= 0) return null;

  const decisionNoun = summary.count === 1 ? "decision" : "decisions";
  const runNoun = summary.runIds.length === 1 ? "run" : "runs";
  const flagged = summary.flaggedCount > 0 ? ` ${summary.flaggedCount} flagged for review.` : "";

  return `[HeadsDown] Ready to resume: ${summary.count} deferred ${decisionNoun} queued across ${summary.runIds.length} ${runNoun}.${flagged} Use headsdown_deferred action=list to review. Show derived facts only: decision IDs, run IDs, decision kind/category, urgency bucket, flagged state, summary counts/buckets, and timestamps. Do not expose raw transcripts, prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, or message contents.`;
}

export function assertPrivacySafeDeferredDecisionOutput(value: unknown, path = "$output"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPrivacySafeDeferredDecisionOutput(entry, `${path}[${index}]`),
    );
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_OUTPUT_KEYS.has(key.toLowerCase())) {
      throw new Error(`Prohibited deferred-decision field at ${path}.${key}`);
    }
    assertPrivacySafeDeferredDecisionOutput(nested, `${path}.${key}`);
  }
}
