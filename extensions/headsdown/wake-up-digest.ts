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
  readonly reAttemptRefined: boolean;
  readonly reAttemptWindowDays: number;
}

export const DEFAULT_WAKE_UP_DIGEST_CONFIG: WakeUpDigestConfig = {
  enabled: true,
  maxEntriesShown: 20,
  reAttemptRefined: true,
  reAttemptWindowDays: 7,
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
    resolutionKind?: string;
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

export interface RefinedDeferredDecisionReAttempt {
  decision_id: string;
  run_id: string;
  resolved_action_key: string | null;
  refined_urgency_bucket: string | null;
  refined_decision_category: string | null;
  notes_bucket: string | null;
  resolved_at: string;
  original: DeferredDecisionEntry;
  local_session_summary?: LocalSessionSummary;
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

export interface RefinedDecisionReAttemptQueryOptions {
  now?: Date;
  daysBack?: number;
  limit?: number;
  runId?: string;
}

const DEFAULT_DAYS_BACK = 30;
const DEFAULT_RE_ATTEMPT_DAYS_BACK = 7;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_ENTRIES_SHOWN_MIN = 1;
const MAX_ENTRIES_SHOWN_MAX = 50;
const SAFE_OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_SUMMARY_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const SAFE_ENUM_TOKEN_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const DECISION_KIND_VALUES = new Set(["would_have_asked", "unknown"]);
const DECISION_CATEGORY_VALUES = new Set([
  "scope",
  "tooling",
  "external_side_effect",
  "validation",
  "style",
  "data",
  "other",
  "unknown",
]);
const URGENCY_BUCKET_VALUES = new Set(["low", "normal", "elevated", "high", "unknown"]);
const NOTES_BUCKET_VALUES = new Set([
  "needs_more_info",
  "wrong_framing",
  "split_into_two",
  "duplicate",
  "other",
]);
const LOCAL_SESSION_OUTCOME_VALUES = new Set<string>(LOCAL_SESSION_SUMMARY_OUTCOME_CATEGORIES);
const PROHIBITED_OUTPUT_KEYS = new Set([
  "transcript",
  "prompt",
  "prompts",
  "file",
  "files",
  "file_name",
  "file_names",
  "file_path",
  "filepath",
  "file_paths",
  "path",
  "paths",
  "repo",
  "repo_name",
  "repository",
  "repository_name",
  "branch",
  "terminal_output",
  "stdout",
  "stderr",
  "test_log",
  "test_logs",
  "source_code",
  "file_contents",
  "diff",
  "log",
  "logs",
  "messages",
  "message_content",
  "message_contents",
  "raw_log",
  "raw_logs",
  "raw_message",
  "raw_messages",
  "raw_payload",
  "raw_text",
]);
const PROHIBITED_OUTPUT_COMPACT_KEYS = new Set(
  [...PROHIBITED_OUTPUT_KEYS].map((key) => key.replace(/_/g, "")),
);
const UNSAFE_OUTPUT_VALUE_PATTERNS = [
  /(?:^|\s)(?:[./~]|[A-Za-z]:\\)[^\s]+/,
  /^[^\s]+\/[^\s]+$/,
  /\b(?:https?|git|ssh):\/\//i,
  /\b(?:stdout|stderr|stacktrace|traceback|diff --git)\b/i,
];

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
    reAttemptRefined: raw.reAttemptRefined !== false,
    reAttemptWindowDays: clampInteger(
      raw.reAttemptWindowDays,
      1,
      DEFAULT_DAYS_BACK,
      DEFAULT_WAKE_UP_DIGEST_CONFIG.reAttemptWindowDays,
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

function normalizeQueryLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUERY_LIMIT;
  return Math.max(0, Math.floor(value));
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

function normalizeNotesBucketToken(value: unknown): string | null {
  const token = normalizeEnumToken(value);
  return token && NOTES_BUCKET_VALUES.has(token) ? token : null;
}

function eventTimestamp(event: AgentRunEvent): number {
  const occurredAt = Date.parse(event.occurredAt);
  if (Number.isFinite(occurredAt)) return occurredAt;
  const insertedAt = Date.parse(event.insertedAt);
  return Number.isFinite(insertedAt) ? insertedAt : 0;
}

function sameEventIdentity(left: AgentRunEvent, right: AgentRunEvent): boolean {
  if (left.eventId && right.eventId) return left.eventId === right.eventId;
  if (left.id && right.id) return left.id === right.id;
  return eventTimestamp(left) === eventTimestamp(right);
}

function readSummaryField(
  raw: Record<string, unknown>,
  camelKey: keyof LocalSessionSummary,
  snakeKey: string,
): unknown {
  return raw[camelKey] ?? raw[snakeKey];
}

function normalizeLocalSessionSummary(value: unknown): LocalSessionSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const sessionId = normalizeSummaryToken(readSummaryField(raw, "sessionId", "session_id"));
  const generatedAt = normalizeIsoString(readSummaryField(raw, "generatedAt", "generated_at"));
  const approvedProposalRefValue = readSummaryField(
    raw,
    "approvedProposalRef",
    "approved_proposal_ref",
  );
  const approvedProposalRef =
    approvedProposalRefValue === null ? null : normalizeSummaryToken(approvedProposalRefValue);
  const outcomeCategory = normalizeOutcomeCategory(
    readSummaryField(raw, "outcomeCategory", "outcome_category"),
  );

  if (raw.version !== 1 || !sessionId || !generatedAt || !outcomeCategory) {
    return undefined;
  }

  return {
    version: 1,
    sessionId,
    generatedAt,
    stale: readSummaryField(raw, "stale", "stale") === true,
    toolCallCount: normalizeNonNegativeInteger(
      readSummaryField(raw, "toolCallCount", "tool_call_count"),
    ),
    fileChangeCount: normalizeNonNegativeInteger(
      readSummaryField(raw, "fileChangeCount", "file_change_count"),
    ),
    deferredDecisionCount: normalizeNonNegativeInteger(
      readSummaryField(raw, "deferredDecisionCount", "deferred_decision_count"),
    ),
    continuationArtifactAvailable:
      readSummaryField(raw, "continuationArtifactAvailable", "continuation_artifact_available") ===
      true,
    validationLocallyPassed:
      readSummaryField(raw, "validationLocallyPassed", "validation_locally_passed") === true,
    approvedProposalRef,
    outcomeCategory,
  };
}

function summaryFactsFromPayload(payload: Record<string, unknown>): {
  facts: DeferredDecisionSummaryFacts;
  localSessionSummary?: LocalSessionSummary;
} {
  const localSessionSummary = normalizeLocalSessionSummary(
    payload.local_session_summary ?? payload.localSessionSummary,
  );

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
  const requestedLimit = normalizeQueryLimit(options.limit);
  const queryLimit = Math.max(DEFAULT_QUERY_LIMIT, requestedLimit);
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

function refinedResolutionFromEvent(
  event: AgentRunEvent,
): Omit<RefinedDeferredDecisionReAttempt, "original" | "local_session_summary"> | null {
  const payload = event.payload ?? {};
  if (payload.resolution_kind !== "refined") return null;
  const decisionId = normalizeOpaqueToken(getString(payload, "decision_id"));
  const runId = normalizeOpaqueToken(event.runId);
  const resolvedAt = normalizeIsoString(event.occurredAt) ?? normalizeIsoString(event.insertedAt);
  if (!decisionId || !runId || !resolvedAt) return null;

  return {
    decision_id: decisionId,
    run_id: runId,
    resolved_action_key: normalizeEnumToken(payload.resolved_action_key),
    refined_urgency_bucket: normalizeUrgencyBucketToken(payload.refined_urgency_bucket),
    refined_decision_category: normalizeDecisionCategoryToken(payload.refined_decision_category),
    notes_bucket: normalizeNotesBucketToken(payload.notes_bucket),
    resolved_at: resolvedAt,
  };
}

export function selectRefinedDecisionReAttempts(input: {
  recordedEvents: ReadonlyArray<AgentRunEvent>;
  refinedResolutionEvents: ReadonlyArray<AgentRunEvent>;
  resolutionEvents?: ReadonlyArray<AgentRunEvent>;
  runId?: string;
  limit?: number;
}): RefinedDeferredDecisionReAttempt[] {
  const recordedByKey = new Map<string, DeferredDecisionEntry>();
  for (const event of input.recordedEvents) {
    const entry = entryFromRecordedEvent(event);
    if (!entry) continue;
    recordedByKey.set(deferredDecisionKey(entry.run_id, entry.decision_id), entry);
  }

  const latestResolutionByKey = new Map<string, AgentRunEvent>();
  for (const event of input.resolutionEvents ?? input.refinedResolutionEvents) {
    const decisionId = normalizeOpaqueToken(getString(event.payload ?? {}, "decision_id"));
    const runId = normalizeOpaqueToken(event.runId);
    if (!decisionId || !runId) continue;
    const key = deferredDecisionKey(runId, decisionId);
    const existing = latestResolutionByKey.get(key);
    if (!existing || eventTimestamp(event) > eventTimestamp(existing)) {
      latestResolutionByKey.set(key, event);
    }
  }

  const latestByKey = new Map<
    string,
    {
      event: AgentRunEvent;
      refined: Omit<RefinedDeferredDecisionReAttempt, "original" | "local_session_summary">;
    }
  >();
  for (const event of input.refinedResolutionEvents) {
    const refined = refinedResolutionFromEvent(event);
    if (!refined) continue;
    if (input.runId && refined.run_id !== input.runId) continue;
    const key = deferredDecisionKey(refined.run_id, refined.decision_id);
    const latestResolution = latestResolutionByKey.get(key);
    if (latestResolution && !sameEventIdentity(latestResolution, event)) continue;
    const existing = latestByKey.get(key);
    if (!existing || eventTimestamp(event) > eventTimestamp(existing.event)) {
      latestByKey.set(key, { event, refined });
    }
  }

  const attempts = [...latestByKey.values()]
    .map(({ refined }) => {
      const original = recordedByKey.get(deferredDecisionKey(refined.run_id, refined.decision_id));
      if (!original) return null;
      return {
        ...refined,
        original,
        ...(original.local_session_summary
          ? { local_session_summary: original.local_session_summary }
          : {}),
      } satisfies RefinedDeferredDecisionReAttempt;
    })
    .filter((entry): entry is RefinedDeferredDecisionReAttempt => entry !== null)
    .sort((a, b) => Date.parse(b.resolved_at) - Date.parse(a.resolved_at));

  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : attempts.length;
  return attempts.slice(0, limit);
}

export async function loadRefinedResolutions(
  client: DeferredDecisionEventClient,
  options: RefinedDecisionReAttemptQueryOptions = {},
): Promise<RefinedDeferredDecisionReAttempt[]> {
  const now = options.now ?? new Date();
  const daysBack = options.daysBack ?? DEFAULT_RE_ATTEMPT_DAYS_BACK;
  const insertedAfter = daysAgoIso(now, daysBack);
  const requestedLimit = normalizeQueryLimit(options.limit);
  const queryLimit = Math.max(DEFAULT_QUERY_LIMIT, requestedLimit);
  const recordedInsertedAfter = daysAgoIso(now, Math.max(daysBack, DEFAULT_DAYS_BACK));
  const [recordedEvents, refinedResolutionEvents, resolutionEvents] = await Promise.all([
    client.listAgentRunEvents({
      eventType: "deferred_decision.recorded",
      insertedAfter: recordedInsertedAfter,
      limit: queryLimit,
      ...(options.runId ? { runId: options.runId } : {}),
    }),
    client.listAgentRunEvents({
      eventType: "deferred_decision.resolved",
      resolutionKind: "refined",
      insertedAfter,
      limit: queryLimit,
      ...(options.runId ? { runId: options.runId } : {}),
    }),
    client.listAgentRunEvents({
      eventType: "deferred_decision.resolved",
      insertedAfter,
      limit: queryLimit,
      ...(options.runId ? { runId: options.runId } : {}),
    }),
  ]);

  return selectRefinedDecisionReAttempts({
    recordedEvents,
    refinedResolutionEvents,
    resolutionEvents,
    runId: options.runId,
    limit: options.limit,
  });
}

function formatSummaryFacts(summary: DeferredDecisionSummaryFacts): string {
  return [
    `tool_calls=${summary.tool_call_count ?? "unknown"}`,
    `file_changes=${summary.file_change_count ?? "unknown"}`,
    `deferred_decisions=${summary.deferred_decision_count ?? "unknown"}`,
    `outcome=${summary.outcome_category ?? "unknown"}`,
    `validation_locally_passed=${summary.validation_locally_passed ?? "unknown"}`,
    `continuation_available=${summary.continuation_artifact_available ?? "unknown"}`,
  ].join(", ");
}

export function formatRefinedReAttemptInstruction(
  attempts: ReadonlyArray<RefinedDeferredDecisionReAttempt>,
  maxEntriesShown: number,
): string | null {
  const limit = clampInteger(
    maxEntriesShown,
    MAX_ENTRIES_SHOWN_MIN,
    MAX_ENTRIES_SHOWN_MAX,
    DEFAULT_WAKE_UP_DIGEST_CONFIG.maxEntriesShown,
  );
  const entries = attempts.slice(0, limit);
  if (entries.length === 0) return null;

  const lines = entries.map((attempt) => {
    const refined = [
      `urgency=${attempt.refined_urgency_bucket ?? attempt.original.urgency_bucket}`,
      `category=${attempt.refined_decision_category ?? attempt.original.decision_category}`,
      `resolved_action_key=${attempt.resolved_action_key ?? "none"}`,
      `notes_bucket=${attempt.notes_bucket ?? "none"}`,
    ].join(", ");
    return `- decision_id=${attempt.decision_id} run_id=${attempt.run_id}; refined: ${refined}; derived_facts: ${formatSummaryFacts(attempt.original.summary)}`;
  });

  return [
    "[HeadsDown] Previously deferred and refined decisions to re-attempt. Use the refined parameters below when deciding what to do next. If you defer one again, treat the original decision as the parent decision. If you complete exactly one matching refined action, Pi will report the outcome automatically.",
    ...lines,
    "Show derived facts only. Do not expose raw transcripts, prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, or message contents.",
  ].join("\n");
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

  if (
    typeof value === "string" &&
    UNSAFE_OUTPUT_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new Error(`Prohibited deferred-decision value at ${path}`);
  }

  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeOutputKey(key);
    const compactKey = normalizedKey.replace(/_/g, "");
    if (
      PROHIBITED_OUTPUT_KEYS.has(normalizedKey) ||
      PROHIBITED_OUTPUT_COMPACT_KEYS.has(compactKey)
    ) {
      throw new Error(`Prohibited deferred-decision field at ${path}.${key}`);
    }
    assertPrivacySafeDeferredDecisionOutput(nested, `${path}.${key}`);
  }
}

function normalizeOutputKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
