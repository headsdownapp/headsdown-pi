/**
 * HeadsDown Availability Extension for Pi
 *
 * Gives Pi awareness of the user's focus mode, schedule, and availability.
 *
 * - Injects HeadsDown execution policy directly into the turn system prompt
 * - Registers native HeadsDown tools (status/propose/digest/continuation/auth/etc.)
 * - Intercepts mutating tool calls (write/edit/mutating bash) based on trust policy
 * - Tracks realized scope drift from successful tool results
 * - Persists continuity snapshots across compaction/tree/session transitions
 * - Registers /headsdown command for quick status checks
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import * as HeadsDownSDK from "@headsdown/sdk";
import { HeadsDownClient, ConfigStore } from "@headsdown/sdk";
import type {
  ActorContext,
  AgentControlOverview,
  Contract,
  DelegationGrantFilterInput,
  DelegationGrantInput,
  DelegationGrantPermission,
  DelegationGrantScope,
  HeadsDownConfig,
  LocalSessionSummary,
  ProposalInput,
  ScheduleResolution,
  Verdict,
} from "@headsdown/sdk";
import {
  applyTrustPolicy,
  decideAutoThinking,
  formatAutopilotGuidance,
  formatSummary,
  formatWrapUpInstruction,
  isSensitivePath,
  normalizeAutoThinkingConfig,
  type AutoThinkingConfig,
  type ThinkingLevel,
} from "./policy.js";
import {
  formatHeadsDownCallForPrompt,
  renderHeadsDownCallCopy,
  type CanonicalHeadsDownCallKey,
  type HeadsDownActionKey,
  type HeadsDownUiIntent,
  type RenderedHeadsDownCallCopy,
} from "./call-renderer.js";
import { runLocalReferee } from "./referee/local-runner.js";
import {
  buildLocalRefereeOutcomeSummaryPayload,
  renderLocalRefereeOutcomeSharePreview,
  shouldShareLocalRefereeOutcomeSummary,
  type LocalRefereeOutcomeShareChoice,
  type LocalRefereeOutcomeSharingPreference,
} from "./referee/outcome-sharing.js";
import {
  advanceTimeBoxForPrompt,
  createTimeBox,
  formatTimeBoxConfirmation,
  formatTimeBoxStatus,
  parseTimeBoxDuration,
  resolveEffectiveDeadline,
  type TimeBoxState,
} from "./time-box.js";
import {
  buildLocalSessionSummary,
  detectDeferral,
  normalizeAutopilotDeferralConfig,
  pickDecisionCategory,
  pickDecisionKind,
  pickUrgencyBucket,
  type AutopilotDeferralConfig,
  type AutopilotDeferralUrgencyBucket,
} from "./autopilot-deferral.js";

// === State ===

interface ProposalRecord {
  id: string;
  decision: "approved" | "deferred";
  description: string;
  evaluatedAt: string;
  estimatedFiles?: number;
  estimatedMinutes?: number;
  scopeSummary?: string;
  sourceRef?: string;
  reportedAt?: string;
}

interface ProposalState {
  proposals: ProposalRecord[];
}

interface ProposeToolParams {
  description: string;
  estimated_files?: number;
  estimated_minutes?: number;
  scope_summary?: string;
  source_ref?: string;
  idempotency_key?: string;
  delivery_mode?: "auto" | "wrap_up" | "full_depth";
}

interface LocalRefereeToolParams {
  contract_path?: string;
  share_outcome?: LocalRefereeOutcomeShareChoice;
  confirm_share_preview?: boolean;
  share_preview_token?: string;
  evidence?: {
    files_touched?: number;
    tool_calls?: number;
    validation_status?: string;
    tests_run?: boolean;
    network_required?: boolean;
    elapsed_minutes?: number;
    outcome?: string;
  };
}

interface ProposalScopeSnapshot {
  proposalId: string;
  modifiedFiles: string[];
  warningSent: boolean;
  updatedAt: string;
}

type PiProgressState = "working" | "validating" | "ready_for_review";

interface PiRunTelemetry {
  runId: string;
  proposalId: string;
  startedAt: number;
  sequence: number;
  toolCallsCount: number;
  toolReadCount: number;
  toolWriteCount: number;
  toolExternalCount: number;
  failureCount: number;
  retryCount: number;
  redirectCount: number;
  filesRead: Set<string>;
  filesModified: Set<string>;
  progressState: PiProgressState;
  startedReported: boolean;
  scopeDriftReported: boolean;
  completedReported: boolean;
  deferredDecisionsCount: number;
}

interface PiAgentRunEventContext {
  runId: string;
  proposalId?: string;
  sequence?: number;
  idempotencyKey?: string;
}

interface AvailabilitySnapshot {
  contract: Contract | null;
  calendar: unknown | null;
  schedule: ScheduleResolution | null;
  summary: string;
  wrapUpInstruction: string | null;
  fetchedAt: number;
}

interface AvailabilityContext {
  contract: Contract | null;
  calendar: unknown | null;
  schedule: ScheduleResolution | null;
}

interface AvailabilityOverride {
  id: string;
  mode: string;
  reason: string | null;
  source: string;
  expiresAt: string;
  cancelledAt: string | null;
  expiredAt: string | null;
  createdById: string;
  cancelledById: string | null;
  insertedAt: string;
  updatedAt: string;
}

interface HeadsDownCallPayload {
  key: string | null;
  title: string | null;
  body: string | null;
  recommendedActionKey: HeadsDownActionKey | null;
  allowedActionKeys: HeadsDownActionKey[];
  reasonCodes: string[];
}

interface AgentRunSummaryPayload {
  runId: string;
  callKey: string | null;
  actionState: string | null;
  allowedActionKeys: HeadsDownActionKey[];
  safeTitle: string | null;
  clientLabel: string | null;
  resumeEligibleAt: string | null;
  nextWorkWindowStartsAt: string | null;
  handoffAvailable: boolean;
  handoffState: string | null;
}

interface AgentControlOverviewPayload {
  headsdownCall: HeadsDownCallPayload | null;
  runSummaries: AgentRunSummaryPayload[];
}

interface ApplyHeadsDownActionInput {
  runId: string;
  actionKey: HeadsDownActionKey;
  sourceState?: string;
  reason?: string;
  source?: string;
  client?: string;
  durationMinutes?: number;
  idempotencyKey?: string;
  nextWorkWindowStartsAt?: string;
  handoffAvailable?: boolean;
  handoffState?: string;
  handoffSource?: string;
  handoffKind?: string;
  handoffCapturedAt?: string;
}

interface ApplyHeadsDownActionPayload {
  ok: boolean;
  runSummary: AgentRunSummaryPayload | null;
}

interface QueueForMorningResult {
  queued: boolean;
  runId: string | null;
  handoffSaved: boolean;
  message: string;
}

interface ContinuationArtifact {
  branch: string | null;
  runId: string | null;
  approvedProposalId: string | null;
  approvedProposalDescription: string | null;
  estimatedFiles: number | null;
  modifiedFiles: string[];
  openDecisions: string[];
  pendingSteps: string[];
  completedSteps: string[];
  resumeInstruction: string | null;
  wrapUpInstruction: string | null;
  savedAt: string;
  reason: string;
}

interface HeadsDownCompactionDetails {
  v: 1;
  headsdown: {
    summary: string | null;
    wrapUpInstruction: string | null;
    timeBox?: TimeBoxState | null;
    proposal: {
      id: string;
      description: string;
      estimatedFiles: number | null;
      estimatedMinutes: number | null;
      scopeSummary: string | null;
      sourceRef: string | null;
    } | null;
    scope: {
      modifiedFiles: string[];
      warningSent: boolean;
      updatedAt: string;
    } | null;
    savedAt: string;
  };
}

interface HeadsDownCompactionInput {
  availabilitySummary: string | null;
  wrapUpInstruction: string | null;
  timeBox: TimeBoxState | null;
  proposal: ProposalRecord | null;
  scope: ProposalScopeSnapshot | null;
  firstKeptEntryId: string;
  tokensBefore: number;
}

interface TimeBoxSessionState {
  state: TimeBoxState | null;
  updatedAt: string;
}

interface LocalRefereeOutcomeSharingState {
  privacyBoundaryVersion: string;
  payloadSchemaVersion: 1;
  workspaces: Record<string, LocalRefereeOutcomeSharingPreference>;
}

interface HeadsDownPiConfig extends HeadsDownConfig {
  autoThinking: AutoThinkingConfig;
  autopilotDeferral: AutopilotDeferralConfig;
  localRefereeOutcomeSharing: LocalRefereeOutcomeSharingState;
}

const HEADSDOWN_PI_CLIENT_VERSION = "0.2.0";
const LOCAL_REFEREE_OUTCOME_PRIVACY_BOUNDARY_VERSION = "local_referee_outcome_v1";
const OPAQUE_WORKSPACE_REF_PATTERN = /^workspace_[0-9a-f]{16}$/;

const MAX_PROPOSAL_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
const AVAILABILITY_CACHE_TTL_MS = 90 * 1000; // 90 seconds
const ATTENTION_WINDOW_POLL_COOLDOWN_MS = 30 * 1000;
const ATTENTION_WINDOW_STATUS_KEY = "headsdown:attention-window";
const TIME_BOX_STATUS_KEY = "headsdown:time-box";
const TIME_BOX_WIDGET_KEY = "headsdown:time-box";
const TIME_BOX_WIDGET_THRESHOLD_MINUTES = 3;
const DEFAULT_ATTENTION_WINDOW_THRESHOLD_MINUTES = 15;
const SCOPE_WARNING_MULTIPLIER = 1.5;
const CONTINUATION_PATH = join(homedir(), ".config", "headsdown", "continuation.json");

const AVAILABILITY_COMPAT_QUERY = `
  query AvailabilityCompat {
    activeContract {
      id
      mode
      status
      statusEmoji
      statusText
      autoRespond
      lock
      duration
      expiresAt
      insertedAt
    }
    availability {
      inReachableHours
      nextTransitionAt
      attentionDeadlineAt
      wrapUpGuidance {
        active
        deadlineAt
        remainingMinutes
        profile
        source
        reason
        hints
        thresholdMinutes
        selectedMode
      }
      activeWindow {
        id
        label
        priority
        startTime
        endTime
        days
        mode
        alertsPolicy
        snooze
        status
        statusEmoji
        statusText
        autoActivate
      }
      nextWindow {
        id
        label
        priority
        startTime
        endTime
        days
        mode
        alertsPolicy
        snooze
        status
        statusEmoji
        statusText
        autoActivate
      }
    }
  }
`;

const ACTIVE_AVAILABILITY_OVERRIDE_QUERY = `
  query ActiveAvailabilityOverride {
    activeAvailabilityOverride {
      id
      mode
      reason
      source
      expiresAt
      cancelledAt
      expiredAt
      createdById
      cancelledById
      insertedAt
      updatedAt
    }
  }
`;

const CREATE_AVAILABILITY_OVERRIDE_MUTATION = `
  mutation CreateAvailabilityOverride($input: AvailabilityOverrideInput!) {
    createAvailabilityOverride(input: $input) {
      id
      mode
      reason
      source
      expiresAt
      cancelledAt
      expiredAt
      createdById
      cancelledById
      insertedAt
      updatedAt
    }
  }
`;

const CANCEL_AVAILABILITY_OVERRIDE_MUTATION = `
  mutation CancelAvailabilityOverride($id: ID!, $reason: String, $source: String) {
    cancelAvailabilityOverride(id: $id, reason: $reason, source: $source) {
      id
      mode
      reason
      source
      expiresAt
      cancelledAt
      expiredAt
      createdById
      cancelledById
      insertedAt
      updatedAt
    }
  }
`;

const AGENT_CONTROL_OVERVIEW_QUERY = `
  query AgentControlOverviewForPi {
    agentControlOverview {
      headsdownCall {
        key
        title
        body
        recommendedActionKey
        allowedActionKeys
        reasonCodes
      }
      runSummaries {
        runId
        callKey
        actionState
        allowedActionKeys
        safeTitle
        clientLabel
        resumeEligibleAt
        nextWorkWindowStartsAt
        handoffAvailable
        handoffState
      }
    }
  }
`;

const APPLY_HEADSDOWN_ACTION_MUTATION = `
  mutation ApplyHeadsDownActionForPi($input: ApplyHeadsdownActionInput!) {
    applyHeadsdownAction(input: $input) {
      ok
      runSummary {
        runId
        callKey
        actionState
        allowedActionKeys
        safeTitle
        clientLabel
        resumeEligibleAt
        nextWorkWindowStartsAt
        handoffAvailable
        handoffState
      }
    }
  }
`;

function getLowLevelGraphQLClient(client: HeadsDownClient): {
  request: (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;
} | null {
  const maybeGraphQL = (client as unknown as { graphql?: unknown }).graphql;
  if (!maybeGraphQL || typeof maybeGraphQL !== "object") return null;

  const request = (maybeGraphQL as { request?: unknown }).request;
  if (typeof request !== "function") return null;

  return {
    request: request.bind(maybeGraphQL) as (
      query: string,
      variables?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  };
}

async function getAvailabilityContext(client: HeadsDownClient): Promise<AvailabilityContext> {
  try {
    const result = await client.getAvailability();
    const typedResult = result as {
      contract: Contract | null;
      calendar?: unknown;
      schedule?: ScheduleResolution;
    };

    return {
      contract: typedResult.contract,
      calendar: typedResult.calendar ?? null,
      schedule: typedResult.schedule ?? null,
    };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Cannot query field "calendar"')) {
      throw error;
    }

    const graphql = getLowLevelGraphQLClient(client);
    if (!graphql) {
      throw error;
    }

    const data = await graphql.request(AVAILABILITY_COMPAT_QUERY);
    return {
      contract: (data.activeContract as Contract | null | undefined) ?? null,
      calendar: null,
      schedule: (data.availability as ScheduleResolution | null | undefined) ?? null,
    };
  }
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  const sessionManager = ctx.sessionManager as { getSessionId?: () => string };
  return typeof sessionManager.getSessionId === "function"
    ? sessionManager.getSessionId()
    : undefined;
}

function toOpaqueWorkspaceRef(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "workspace_unknown";
  }

  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `workspace_${digest}`;
}

function buildActorContext(ctx: ExtensionContext): ActorContext {
  const sessionId = getSessionId(ctx);
  return {
    source: "pi",
    agentId: "pi-agent",
    sessionId,
    workspaceRef: toOpaqueWorkspaceRef(ctx.cwd),
  };
}

function withActorContext(client: HeadsDownClient, ctx: ExtensionContext): HeadsDownClient {
  return client.withActor(buildActorContext(ctx));
}

function resolveExecutionInstruction(input: {
  contract?: Contract | null;
  schedule?: ScheduleResolution | null;
  verdict?: Pick<Verdict, "decision" | "reason" | "wrapUpGuidance"> | null;
}): string | null {
  const describeExecutionDirective = (
    HeadsDownSDK as unknown as {
      describeExecutionDirective?: (value: {
        contract?: Contract | null;
        schedule?: ScheduleResolution | null;
        verdict?: Pick<Verdict, "decision" | "reason" | "wrapUpGuidance"> | null;
      }) => { primaryDirective?: string };
    }
  ).describeExecutionDirective;

  if (typeof describeExecutionDirective === "function") {
    const directive = describeExecutionDirective(input);
    return directive.primaryDirective ?? null;
  }

  return formatWrapUpInstruction(input.verdict?.wrapUpGuidance ?? input.schedule?.wrapUpGuidance);
}

function isSessionTokenOnlyGrantError(message: string): boolean {
  return (
    message.includes("session-token auth path") ||
    message.includes("session-token auth") ||
    message.includes("Delegation grants require session-token auth")
  );
}

type AvailabilityOverrideInput = {
  mode: "online" | "busy" | "limited" | "offline";
  durationMinutes?: number;
  expiresAt?: string;
  reason?: string;
  source?: string;
};

async function createAvailabilityOverrideCompat(
  client: HeadsDownClient,
  input: AvailabilityOverrideInput,
): Promise<AvailabilityOverride> {
  const nativeMethod = (
    client as unknown as {
      createAvailabilityOverride?: (
        value: AvailabilityOverrideInput,
      ) => Promise<AvailabilityOverride>;
    }
  ).createAvailabilityOverride;

  if (typeof nativeMethod === "function") {
    return nativeMethod(input);
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("Availability override APIs are unavailable in this @headsdown/sdk version.");
  }

  const graphQLMode = toGraphQLEnumValue(input.mode);
  if (!graphQLMode) {
    throw new Error("Invalid availability override mode.");
  }

  const data = await graphql.request(CREATE_AVAILABILITY_OVERRIDE_MUTATION, {
    input: stripUndefinedValues({
      ...input,
      mode: graphQLMode,
    }),
  });

  const override =
    (data.createAvailabilityOverride as AvailabilityOverride | null | undefined) ?? null;
  if (!override) {
    throw new Error("HeadsDown API returned no availability override data.");
  }

  return override;
}

async function getActiveAvailabilityOverrideCompat(
  client: HeadsDownClient,
): Promise<AvailabilityOverride | null> {
  const nativeMethod = (
    client as unknown as {
      getActiveAvailabilityOverride?: () => Promise<AvailabilityOverride | null>;
    }
  ).getActiveAvailabilityOverride;

  if (typeof nativeMethod === "function") {
    return nativeMethod();
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("Availability override APIs are unavailable in this @headsdown/sdk version.");
  }

  const data = await graphql.request(ACTIVE_AVAILABILITY_OVERRIDE_QUERY);
  return (data.activeAvailabilityOverride as AvailabilityOverride | null | undefined) ?? null;
}

async function cancelAvailabilityOverrideCompat(
  client: HeadsDownClient,
  id: string,
  reason?: string,
): Promise<AvailabilityOverride> {
  const nativeMethod = (
    client as unknown as {
      cancelAvailabilityOverride?: (id: string, reason?: string) => Promise<AvailabilityOverride>;
    }
  ).cancelAvailabilityOverride;

  if (typeof nativeMethod === "function") {
    return nativeMethod(id, reason);
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("Availability override APIs are unavailable in this @headsdown/sdk version.");
  }

  const data = await graphql.request(CANCEL_AVAILABILITY_OVERRIDE_MUTATION, {
    id,
    reason,
    source: "pi",
  });

  const override =
    (data.cancelAvailabilityOverride as AvailabilityOverride | null | undefined) ?? null;
  if (!override) {
    throw new Error("HeadsDown API returned no cancelled availability override data.");
  }

  return override;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeEnumKey(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const snakeCase = trimmed
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/__+/g, "_")
    .toLowerCase();

  return snakeCase.length > 0 ? snakeCase : null;
}

const HEADSDOWN_ACTION_KEYS = [
  "continue",
  "continue_with_limit",
  "narrow_scope",
  "ask_user",
  "queue_for_later",
  "queue_for_morning",
  "pause_and_summarize",
  "stop_run",
  "resume_run",
  "allow_once",
  "allow_for_duration",
  "create_temporary_exception",
  "keep_queued",
] as const satisfies readonly HeadsDownActionKey[];

function isHeadsDownActionKey(value: string): value is HeadsDownActionKey {
  return (HEADSDOWN_ACTION_KEYS as readonly string[]).includes(value);
}

function normalizeCallKey(value: unknown): string | null {
  return normalizeEnumKey(value);
}

function normalizeActionKey(value: unknown): HeadsDownActionKey | null {
  const normalized = normalizeEnumKey(value);
  return normalized && isHeadsDownActionKey(normalized) ? normalized : null;
}

function normalizeRunState(value: unknown): string | null {
  return normalizeEnumKey(value);
}

function toGraphQLEnumValue(value: unknown): string | undefined {
  const normalized = normalizeEnumKey(value);
  return normalized ? normalized.toUpperCase() : undefined;
}

function normalizeActionKeyList(value: unknown): HeadsDownActionKey[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => normalizeActionKey(item))
    .filter((item): item is HeadsDownActionKey => item !== null);
}

function normalizeHeadsDownCallPayload(value: unknown): HeadsDownCallPayload | null {
  if (!value || typeof value !== "object") return null;

  const payload = value as Record<string, unknown>;
  return {
    key: normalizeCallKey(payload.key),
    title: toStringOrNull(payload.title),
    body: toStringOrNull(payload.body),
    recommendedActionKey: normalizeActionKey(payload.recommendedActionKey),
    allowedActionKeys: normalizeActionKeyList(payload.allowedActionKeys),
    reasonCodes: normalizeActionKeyList(payload.reasonCodes),
  };
}

function normalizeRunSummaryPayload(value: unknown): AgentRunSummaryPayload | null {
  if (!value || typeof value !== "object") return null;

  const summary = value as Record<string, unknown>;
  const runId = toStringOrNull(summary.runId);
  if (!runId) return null;

  return {
    runId,
    callKey: normalizeCallKey(summary.callKey),
    actionState: normalizeRunState(summary.actionState),
    allowedActionKeys: normalizeActionKeyList(summary.allowedActionKeys),
    safeTitle: toStringOrNull(summary.safeTitle),
    clientLabel: toStringOrNull(summary.clientLabel),
    resumeEligibleAt: toStringOrNull(summary.resumeEligibleAt),
    nextWorkWindowStartsAt: toStringOrNull(summary.nextWorkWindowStartsAt),
    handoffAvailable: summary.handoffAvailable === true,
    handoffState: normalizeRunState(summary.handoffState),
  };
}

function normalizeAgentControlOverviewPayload(value: unknown): AgentControlOverviewPayload | null {
  if (!value || typeof value !== "object") return null;

  const payload = value as Record<string, unknown>;
  const runSummaries = Array.isArray(payload.runSummaries)
    ? payload.runSummaries
        .map((item) => normalizeRunSummaryPayload(item))
        .filter((item): item is AgentRunSummaryPayload => item !== null)
    : [];

  return {
    headsdownCall: normalizeHeadsDownCallPayload(payload.headsdownCall),
    runSummaries,
  };
}

async function getAgentControlOverviewCompat(
  client: HeadsDownClient,
): Promise<AgentControlOverviewPayload | null> {
  const nativeMethod = (
    client as unknown as {
      getAgentControlOverview?: () => Promise<unknown>;
    }
  ).getAgentControlOverview;

  if (typeof nativeMethod === "function") {
    const nativePayload = await nativeMethod.call(client);
    return normalizeAgentControlOverviewPayload(nativePayload);
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    return null;
  }

  try {
    const data = await graphql.request(AGENT_CONTROL_OVERVIEW_QUERY);
    return normalizeAgentControlOverviewPayload(data.agentControlOverview);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("agentControlOverview") || message.includes("headsdownCall")) {
      return null;
    }
    throw error;
  }
}

type AgentControlOverviewResult =
  | { ok: true; overview: AgentControlOverviewPayload | null }
  | { ok: false; reason: "overview_failed"; message: string };

async function getAgentControlOverviewResult(
  client: HeadsDownClient,
): Promise<AgentControlOverviewResult> {
  try {
    return { ok: true, overview: await getAgentControlOverviewCompat(client) };
  } catch (error) {
    return { ok: false, reason: "overview_failed", message: sanitizeErrorMessage(error) };
  }
}

async function callNativeApplyHeadsDownAction(
  client: HeadsDownClient,
  method: (
    actionKeyOrPayload: HeadsDownActionKey | ApplyHeadsDownActionInput,
    payload?: ApplyHeadsDownActionInput,
  ) => Promise<unknown>,
  input: ApplyHeadsDownActionInput,
): Promise<ApplyHeadsDownActionPayload> {
  const result = (await (method.length >= 2
    ? method.call(client, input.actionKey, input)
    : method.call(client, input))) as Record<string, unknown>;

  return {
    ok: result.ok === true,
    runSummary: normalizeRunSummaryPayload(result.runSummary),
  };
}

async function applyHeadsDownActionCompat(
  client: HeadsDownClient,
  input: ApplyHeadsDownActionInput,
): Promise<ApplyHeadsDownActionPayload> {
  const nativeMethod = (
    client as unknown as {
      applyHeadsDownAction?: (
        actionKeyOrPayload: HeadsDownActionKey | ApplyHeadsDownActionInput,
        payload?: ApplyHeadsDownActionInput,
      ) => Promise<unknown>;
      applyHeadsdownAction?: (
        actionKeyOrPayload: HeadsDownActionKey | ApplyHeadsDownActionInput,
        payload?: ApplyHeadsDownActionInput,
      ) => Promise<unknown>;
    }
  ).applyHeadsDownAction;

  if (typeof nativeMethod === "function") {
    return callNativeApplyHeadsDownAction(client, nativeMethod, input);
  }

  const fallbackNativeMethod = (
    client as unknown as {
      applyHeadsdownAction?: (
        actionKeyOrPayload: HeadsDownActionKey | ApplyHeadsDownActionInput,
        payload?: ApplyHeadsDownActionInput,
      ) => Promise<unknown>;
    }
  ).applyHeadsdownAction;

  if (typeof fallbackNativeMethod === "function") {
    return callNativeApplyHeadsDownAction(client, fallbackNativeMethod, input);
  }

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    throw new Error("HeadsDown action APIs are unavailable in this @headsdown/sdk version.");
  }

  const payload = await graphql.request(APPLY_HEADSDOWN_ACTION_MUTATION, {
    input: stripUndefinedValues({
      runId: input.runId,
      actionKey: input.actionKey,
      sourceState: input.sourceState,
      reason: input.reason,
      source: input.source,
      client: input.client,
      durationMinutes: normalizeDurationMinutes(input.durationMinutes),
      idempotencyKey: input.idempotencyKey,
      nextWorkWindowStartsAt: input.nextWorkWindowStartsAt,
      handoffAvailable: input.handoffAvailable,
      handoffState: toGraphQLEnumValue(input.handoffState),
      handoffSource: input.handoffSource,
      handoffKind: input.handoffKind,
      handoffCapturedAt: input.handoffCapturedAt,
    }),
  });

  const result =
    (payload.applyHeadsdownAction as Record<string, unknown> | null | undefined) ?? null;
  if (!result) {
    throw new Error("HeadsDown API returned no applyHeadsdownAction payload.");
  }

  return {
    ok: result.ok === true,
    runSummary: normalizeRunSummaryPayload(result.runSummary),
  };
}

function pickQueueForMorningRun(
  runSummaries: AgentRunSummaryPayload[],
): AgentRunSummaryPayload | null {
  const candidate = runSummaries.find(
    (summary) =>
      summary.callKey === "off_the_clock" &&
      summary.allowedActionKeys.includes("queue_for_morning"),
  );

  return candidate ?? null;
}

function isAlreadyQueuedForMorning(summary: AgentRunSummaryPayload): boolean {
  const actionState = (summary.actionState ?? "").toLowerCase();
  const handoffState = (summary.handoffState ?? "").toLowerCase();

  return (
    actionState === "queued_for_morning" ||
    actionState === "queued" ||
    actionState === "ready_to_resume" ||
    (summary.handoffAvailable && handoffState === "saved")
  );
}

function shouldAutoQueueForMorning(
  summary: AgentRunSummaryPayload,
  queuedRunIds: Set<string>,
): boolean {
  if (summary.callKey !== "off_the_clock") return false;
  if (!summary.allowedActionKeys.includes("queue_for_morning")) return false;
  if (queuedRunIds.has(summary.runId)) return false;
  if (isAlreadyQueuedForMorning(summary)) return false;
  return true;
}

interface AllowedRunActionResolution {
  allowed: boolean;
  runSummary: AgentRunSummaryPayload | null;
  reason: "missing_overview" | "missing_run" | "call_mismatch" | "action_not_allowed" | "allowed";
}

function resolveAllowedRunAction(input: {
  overview: AgentControlOverviewPayload | null | undefined;
  candidateRunIds: string[];
  actionKey: HeadsDownActionKey;
  expectedCallKeys?: CanonicalHeadsDownCallKey[];
}): AllowedRunActionResolution {
  if (!input.overview) {
    return { allowed: false, runSummary: null, reason: "missing_overview" };
  }

  const candidateRunIds = buildCandidateRunIdSet(input.candidateRunIds);
  const runSummary =
    input.overview.runSummaries.find((summary) => candidateRunIds.has(summary.runId)) ?? null;

  if (!runSummary) {
    return { allowed: false, runSummary: null, reason: "missing_run" };
  }

  const expectedCallKeys = input.expectedCallKeys ?? [];
  if (
    expectedCallKeys.length > 0 &&
    (!runSummary.callKey || !expectedCallKeys.some((callKey) => callKey === runSummary.callKey))
  ) {
    return { allowed: false, runSummary, reason: "call_mismatch" };
  }

  if (!runSummary.allowedActionKeys.includes(input.actionKey)) {
    return { allowed: false, runSummary, reason: "action_not_allowed" };
  }

  return { allowed: true, runSummary, reason: "allowed" };
}

function allowedRunActionFailureMessage(
  actionLabel: string,
  resolution: AllowedRunActionResolution,
): string {
  switch (resolution.reason) {
    case "missing_overview":
      return `[HeadsDown] Cannot verify backend-allowed actions for ${actionLabel}. Re-check the current HeadsDown call before acting.`;
    case "missing_run":
      return `[HeadsDown] Cannot find the active run in backend action data for ${actionLabel}. Re-check the current HeadsDown call before acting.`;
    case "call_mismatch":
      return `[HeadsDown] The active run is no longer in the expected call state for ${actionLabel}. Re-check before acting.`;
    case "action_not_allowed":
      return `[HeadsDown] Backend did not allow ${actionLabel} for this run. Keep the run contained and re-check the current call.`;
    case "allowed":
      return `[HeadsDown] ${actionLabel} is allowed.`;
  }
}

function allowedActionKeysForCallPrompt(
  overview: AgentControlOverviewPayload,
  callKey: string,
  candidateRunIds: string[] = [],
): HeadsDownActionKey[] {
  const candidateRunIdSet = buildCandidateRunIdSet(candidateRunIds);
  const matchingRuns = overview.runSummaries.filter((summary) => summary.callKey === callKey);

  if (candidateRunIdSet.size > 0) {
    const candidate = matchingRuns.find((summary) => candidateRunIdSet.has(summary.runId));
    return candidate?.allowedActionKeys ?? [];
  }

  if (matchingRuns.length === 1) {
    return matchingRuns[0]!.allowedActionKeys;
  }

  return overview.headsdownCall?.allowedActionKeys ?? [];
}

function filterRenderedCallActions(
  rendered: RenderedHeadsDownCallCopy,
  allowedActionKeys: HeadsDownActionKey[],
): RenderedHeadsDownCallCopy {
  const filterAction = (
    label: string | null,
    actionKey: HeadsDownActionKey | null,
    uiIntent: HeadsDownUiIntent | null,
  ) => {
    if (!actionKey || allowedActionKeys.includes(actionKey)) {
      return { label, actionKey, uiIntent };
    }

    return { label: null, actionKey: null, uiIntent: null };
  };

  const primary = filterAction(
    rendered.primaryLabel,
    rendered.primaryActionKey,
    rendered.primaryUiIntent,
  );
  const secondary = filterAction(
    rendered.secondaryLabel,
    rendered.secondaryActionKey,
    rendered.secondaryUiIntent,
  );

  return {
    ...rendered,
    primaryLabel: primary.label,
    primaryActionKey: primary.actionKey,
    primaryUiIntent: primary.uiIntent,
    secondaryLabel: secondary.label,
    secondaryActionKey: secondary.actionKey,
    secondaryUiIntent: secondary.uiIntent,
  };
}

function pickReadyToResumeRun(
  runSummaries: AgentRunSummaryPayload[],
  candidateRunIds: string[] = [],
): AgentRunSummaryPayload | null {
  const candidateRunIdSet = buildCandidateRunIdSet(candidateRunIds);
  const readyRuns = runSummaries.filter(
    (summary) =>
      summary.callKey === "ready_to_resume" && summary.allowedActionKeys.includes("resume_run"),
  );

  if (candidateRunIdSet.size > 0) {
    return readyRuns.find((summary) => candidateRunIdSet.has(summary.runId)) ?? null;
  }

  return readyRuns.length === 1 ? readyRuns[0] : null;
}

interface AttentionWindowRunResolution {
  runId: string | null;
  runSummary: AgentRunSummaryPayload | null;
  reason:
    | "matched_proposal_run"
    | "single_attention_window_run"
    | "no_matching_run"
    | "ambiguous_attention_window_runs"
    | "overview_unavailable";
}

function resolveAttentionWindowRun(input: {
  activeProposalId: string | null;
  overview: AgentControlOverviewPayload | null | undefined;
}): AttentionWindowRunResolution {
  if (!input.overview) {
    return { runId: null, runSummary: null, reason: "overview_unavailable" };
  }

  const proposalRunId = input.activeProposalId ? runIdForProposal(input.activeProposalId) : null;
  if (proposalRunId) {
    const matchingProposalRun =
      input.overview.runSummaries.find((summary) => summary.runId === proposalRunId) ?? null;
    if (matchingProposalRun) {
      return {
        runId: matchingProposalRun.runId,
        runSummary: matchingProposalRun,
        reason: "matched_proposal_run",
      };
    }
  }

  const attentionWindowRuns = input.overview.runSummaries.filter(
    (summary) => summary.callKey === "attention_window_closing",
  );
  if (attentionWindowRuns.length === 1) {
    return {
      runId: attentionWindowRuns[0]!.runId,
      runSummary: attentionWindowRuns[0]!,
      reason: "single_attention_window_run",
    };
  }

  if (attentionWindowRuns.length > 1) {
    return { runId: null, runSummary: null, reason: "ambiguous_attention_window_runs" };
  }

  return { runId: null, runSummary: null, reason: "no_matching_run" };
}

function normalizeDurationMinutes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.ceil(value);
  if (rounded <= 0) return undefined;
  return rounded;
}

function parseExtendDurationMinutes(args: string): number | null {
  if (args.trim().length === 0) return 15;
  const durationMs = parseTimeBoxDuration(args);
  if (!durationMs) return null;
  return Math.max(1, Math.ceil(durationMs / 60_000));
}

function attentionCountdownText(remainingMinutes: number | null | undefined): string {
  return typeof remainingMinutes === "number" && Number.isFinite(remainingMinutes)
    ? `${Math.max(0, Math.ceil(remainingMinutes))}m left.`
    : "Closing soon.";
}

function attentionWindowStatusText(remainingMinutes: number | null | undefined): string {
  return `Window closing: ${attentionCountdownText(remainingMinutes)} /headsdown extend or /headsdown wrap`;
}

function localTimeBoxStatusText(remainingMinutes: number | null | undefined): string {
  return `Box deadline: ${attentionCountdownText(remainingMinutes)} Wrap cleanly or clear with /headsdown box clear`;
}

type ResumeContinuationResult = {
  consumed: boolean;
  resumeAction: Record<string, unknown>;
};

async function resumeContinuationArtifact(input: {
  artifact: ContinuationArtifact;
  actorClient: HeadsDownClient | null;
  loadOverview: (client: HeadsDownClient) => Promise<AgentControlOverviewResult>;
  applyAction: (
    client: HeadsDownClient,
    actionInput: ApplyHeadsDownActionInput,
  ) => Promise<ApplyHeadsDownActionPayload>;
  clearContinuation: () => Promise<boolean>;
  reportResumed: () => Promise<void>;
}): Promise<ResumeContinuationResult> {
  if (!input.actorClient) {
    return { consumed: false, resumeAction: { attempted: false, reason: "not_authenticated" } };
  }

  const overviewResult = await input.loadOverview(input.actorClient);
  if (!overviewResult.ok) {
    return {
      consumed: false,
      resumeAction: {
        attempted: false,
        reason: overviewResult.reason,
        message: overviewResult.message,
      },
    };
  }

  const candidateRunIds = [
    input.artifact.runId ?? "",
    input.artifact.approvedProposalId ?? "",
    input.artifact.approvedProposalId ? runIdForProposal(input.artifact.approvedProposalId) : "",
  ];
  const readyRun = pickReadyToResumeRun(
    overviewResult.overview?.runSummaries ?? [],
    candidateRunIds,
  );

  if (!readyRun) {
    return {
      consumed: false,
      resumeAction: { attempted: false, reason: "resume_run_not_allowed" },
    };
  }

  let result: ApplyHeadsDownActionPayload;
  try {
    result = await input.applyAction(input.actorClient, {
      runId: readyRun.runId,
      actionKey: "resume_run",
      source: "pi",
      client: "pi",
      reason: "Ready to resume. Resume approved work.",
    });
  } catch (error) {
    return {
      consumed: false,
      resumeAction: {
        attempted: true,
        ok: false,
        runId: readyRun.runId,
        reason: "apply_failed",
        message: sanitizeErrorMessage(error),
      },
    };
  }

  if (!result.ok) {
    return {
      consumed: false,
      resumeAction: {
        attempted: true,
        ok: false,
        runId: readyRun.runId,
        reason: "apply_not_ok",
      },
    };
  }

  const consumed = await input.clearContinuation();
  if (!consumed) {
    return {
      consumed: false,
      resumeAction: {
        attempted: true,
        ok: true,
        runId: readyRun.runId,
        reason: "clear_failed",
      },
    };
  }

  await input.reportResumed();
  return { consumed: true, resumeAction: { attempted: true, ok: true, runId: readyRun.runId } };
}

function buildQueuedForMorningContinuationArtifact(
  runSummary: AgentRunSummaryPayload,
  branch: string | null,
): ContinuationArtifact {
  const safeTitle = runSummary.safeTitle ?? "approved run";
  return {
    branch,
    runId: runSummary.runId,
    approvedProposalId: null,
    approvedProposalDescription: safeTitle,
    estimatedFiles: null,
    modifiedFiles: [],
    openDecisions: ["Resume approved work when the next work window starts."],
    pendingSteps: ["Resume approved work."],
    completedSteps: ["Queued for morning."],
    resumeInstruction: "Ready to resume. Resume approved work.",
    wrapUpInstruction: "Off the clock. Queued for morning. Your night stays yours.",
    savedAt: new Date().toISOString(),
    reason: "queue-for-morning",
  };
}

async function queueForMorningWithHandoff(input: {
  actorClient: HeadsDownClient;
  runSummary: AgentRunSummaryPayload;
  branch: string | null;
  saveContinuation: (artifact: ContinuationArtifact) => Promise<void>;
}): Promise<QueueForMorningResult> {
  const artifact = buildQueuedForMorningContinuationArtifact(input.runSummary, input.branch);
  await input.saveContinuation(artifact);

  const result = await applyHeadsDownActionCompat(input.actorClient, {
    runId: input.runSummary.runId,
    actionKey: "queue_for_morning",
    source: "pi",
    client: "pi",
    reason: "Off the clock. Queued for morning. Your night stays yours.",
    nextWorkWindowStartsAt: input.runSummary.nextWorkWindowStartsAt ?? undefined,
    handoffAvailable: true,
    handoffState: "saved",
    handoffSource: "pi",
    handoffKind: "continuation",
    handoffCapturedAt: new Date().toISOString(),
  });

  if (!result.ok) {
    return {
      queued: false,
      runId: input.runSummary.runId,
      handoffSaved: false,
      message: "Off the clock call received, but queue_for_morning did not complete.",
    };
  }

  return {
    queued: true,
    runId: input.runSummary.runId,
    handoffSaved: true,
    message: "Off the clock. Queued for morning. Your night stays yours.",
  };
}

function normalizeToolPath(input: string | undefined): string {
  if (!input) return "";
  const path = input.trim();
  return path.startsWith("@") ? path.slice(1) : path;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function randomHex(length: number): string {
  return randomUUID().replace(/-/g, "").slice(0, length);
}

function stripUndefinedValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  const message = String(error).trim();
  return message.length > 0 ? message : "unknown error";
}

function buildCandidateRunIdSet(candidateRunIds: string[]): Set<string> {
  return new Set(candidateRunIds.filter((id) => id.trim().length > 0));
}

export function deriveProposalIdempotencyKey(
  params: ProposeToolParams,
  toolCallId?: string,
): string {
  const explicit = params.idempotency_key?.trim();
  if (explicit) {
    return explicit;
  }

  const normalizedToolCallId = toolCallId?.trim();
  if (normalizedToolCallId) {
    return `pi-toolcall-${normalizedToolCallId}`;
  }

  return `pi-toolcall-${randomUUID()}`;
}

export function buildProposalInput(params: ProposeToolParams, toolCallId?: string): ProposalInput {
  const input: ProposalInput = {
    agentRef: "pi-agent",
    framework: "pi",
    description: params.description,
    estimatedFiles: params.estimated_files,
    estimatedMinutes: params.estimated_minutes,
    scopeSummary: params.scope_summary,
    sourceRef: params.source_ref,
    deliveryMode: params.delivery_mode,
  };
  (input as ProposalInput & { idempotencyKey?: string }).idempotencyKey =
    deriveProposalIdempotencyKey(params, toolCallId);
  return input;
}

function safeIdToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 96);
}

function runIdForProposal(proposalId: string): string {
  return `run_${safeIdToken(proposalId)}`;
}

function bucketFileCount(count: number | undefined): string {
  if (count === undefined || count < 0) return "unknown";
  if (count === 0) return "0";
  if (count <= 2) return "1_to_2";
  if (count <= 5) return "3_to_5";
  if (count <= 10) return "6_to_10";
  return "over_10";
}

function bucketScopeGrowth(count: number | undefined): string {
  if (count === undefined || count < 0) return "unknown";
  if (count === 0) return "none";
  if (count <= 2) return "1_to_2_files";
  if (count <= 5) return "3_to_5_files";
  if (count <= 10) return "6_to_10_files";
  return "over_10_files";
}

function normalizeSafeReasonCode(value: string | undefined, fallback: string): string {
  const raw = value?.trim().toLowerCase().replace(/-/g, "_");
  const normalized = raw
    ?.replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64);
  const allowed = new Set([
    "manual_save",
    "session_switch",
    "session_shutdown",
    "session_compact",
    "before_switch",
    "before_tree",
    "before_compact",
    "unknown",
  ]);
  return normalized && allowed.has(normalized) ? normalized : fallback;
}

function normalizeFailureCategory(value: string | undefined): string {
  const normalized = normalizeSafeReasonCode(value, "unknown");
  const allowed = new Set([
    "validation_failed",
    "compilation_error",
    "test_failure",
    "auth_error",
    "external_service_error",
    "timeout",
    "cancelled",
    "unknown",
  ]);
  return allowed.has(normalized) ? normalized : "unknown";
}

function mapTaskOutcomeToAgentRunOutcome(outcome: string): string {
  switch (outcome) {
    case "completed":
      return "succeeded";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "partially_completed":
      return "paused";
    default:
      return "failed";
  }
}

function bucketMinutes(minutes: number | undefined): string {
  if (minutes === undefined || minutes < 0) return "unknown";
  if (minutes < 15) return "under_15";
  if (minutes <= 30) return "15_to_30";
  if (minutes <= 60) return "30_to_60";
  if (minutes <= 120) return "60_to_120";
  return "over_120";
}

function normalizeGraphQLEnumOutput(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null;
}

function basePiAgentRunEvent(context: PiAgentRunEventContext): Record<string, unknown> {
  return stripUndefinedValues({
    runId: context.runId,
    workspaceRef: "unknown",
    source: "pi_skill",
    client: { kind: "pi", name: "Pi", version: "0.2.0" },
    actor: { kind: "agent", ref: "pi" },
    proposalRef: context.proposalId,
    correlationId: context.proposalId,
    sequence: context.sequence,
    idempotencyKey: context.idempotencyKey,
  });
}

function buildStartedEventInput(proposal: ProposalRecord): Record<string, unknown> {
  const runId = runIdForProposal(proposal.id);
  return {
    ...basePiAgentRunEvent({
      runId,
      proposalId: proposal.id,
      sequence: 1,
      idempotencyKey: `${runId}:agent_run.started:1`,
    }),
    eventType: "agent_run.started",
    payload: {
      task_category: "coding_agent_change",
      task_size_bucket:
        proposal.estimatedMinutes && proposal.estimatedMinutes > 60 ? "medium" : "small",
      started_by: "agent",
      initial_call_key: "good_to_run",
      estimated_minutes_bucket: bucketMinutes(proposal.estimatedMinutes),
      estimated_files_bucket: bucketFileCount(proposal.estimatedFiles),
      delivery_mode: "auto",
    },
  };
}

function progressConfidenceBucket(input: {
  elapsedSeconds: number;
  estimatedMinutes?: number;
  scopeGrowth: number | undefined;
  retryCount: number;
  failureCount: number;
}): string {
  if (typeof input.scopeGrowth === "number" && input.scopeGrowth > 0) return "medium";
  if (input.retryCount >= 3 || input.failureCount >= 3) return "medium";

  const estimatedSeconds =
    typeof input.estimatedMinutes === "number" && input.estimatedMinutes > 0
      ? input.estimatedMinutes * 60
      : null;
  if (estimatedSeconds) {
    const threshold = Math.max(Math.round(estimatedSeconds * 1.25), estimatedSeconds + 300);
    if (input.elapsedSeconds >= threshold) return "medium";
  }

  return "low";
}

function buildProgressEventInput(
  telemetry: PiRunTelemetry,
  scopeChanged: boolean,
  estimatedFiles?: number,
  estimatedMinutes?: number,
): Record<string, unknown> {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - telemetry.startedAt) / 1000));
  const filesModified = telemetry.filesModified.size;
  const scopeGrowth =
    typeof estimatedFiles === "number" && estimatedFiles >= 0
      ? Math.max(filesModified - estimatedFiles, 0)
      : undefined;
  const confidenceBucket = progressConfidenceBucket({
    elapsedSeconds,
    estimatedMinutes,
    scopeGrowth,
    retryCount: telemetry.retryCount,
    failureCount: telemetry.failureCount,
  });

  return {
    ...basePiAgentRunEvent({
      runId: telemetry.runId,
      proposalId: telemetry.proposalId,
      sequence: telemetry.sequence,
      idempotencyKey: `${telemetry.runId}:agent_run.progress_reported:${telemetry.sequence}`,
    }),
    eventType: "agent_run.progress_reported",
    progressPayload: {
      elapsedSeconds,
      toolCallsCount: telemetry.toolCallsCount,
      toolReadCount: telemetry.toolReadCount,
      toolWriteCount: telemetry.toolWriteCount,
      toolExternalCount: telemetry.toolExternalCount,
      filesReadBucket: bucketFileCount(telemetry.filesRead.size),
      filesModifiedBucket: bucketFileCount(filesModified),
      validationLevel: "unknown",
      validationStatus: "unknown",
      retryCount: telemetry.retryCount,
      failureCount: telemetry.failureCount,
      scopeChanged,
      redirectCount: telemetry.redirectCount,
      progressState: telemetry.progressState,
      scopeGrowthBucket: bucketScopeGrowth(scopeGrowth),
      confidenceBucket,
      spendEstimateBucket: "unknown",
    },
  };
}

function buildScopeDriftEventInput(
  telemetry: PiRunTelemetry,
  estimatedFiles: number,
): Record<string, unknown> {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - telemetry.startedAt) / 1000));
  return {
    ...basePiAgentRunEvent({
      runId: telemetry.runId,
      proposalId: telemetry.proposalId,
      sequence: telemetry.sequence,
      idempotencyKey: `${telemetry.runId}:scope_drift.detected`,
    }),
    eventType: "scope_drift.detected",
    payload: {
      drift_type: "scope_grew",
      approved_scope_bucket: bucketScopeGrowth(estimatedFiles),
      observed_scope_bucket: bucketScopeGrowth(telemetry.filesModified.size),
      reason_codes: ["modified_files_exceeded_estimate"],
      files_touched_count: telemetry.filesModified.size,
      tool_calls_count: telemetry.toolCallsCount,
      elapsed_seconds: elapsedSeconds,
    },
  };
}

function buildContinuationSavedEventInput(
  telemetry: PiRunTelemetry,
  artifact: ContinuationArtifact,
): Record<string, unknown> {
  const continuationId = artifact.approvedProposalId
    ? `cont_${safeIdToken(artifact.approvedProposalId)}`
    : `cont_${safeIdToken(telemetry.runId)}`;
  const saveReason = normalizeSafeReasonCode(artifact.reason, "manual_save");
  return {
    ...basePiAgentRunEvent({
      runId: telemetry.runId,
      proposalId: telemetry.proposalId,
      sequence: telemetry.sequence,
      idempotencyKey: `${telemetry.runId}:agent_run.continuation_saved:${saveReason}:${telemetry.sequence}`,
    }),
    eventType: "agent_run.continuation_saved",
    payload: {
      continuation_id: continuationId,
      save_reason: saveReason,
      handoff_quality: artifact.resumeInstruction ? "partial" : "unknown",
      pending_steps_count: artifact.pendingSteps.length,
      completed_steps_count: artifact.completedSteps.length,
      dirty_files_count: artifact.modifiedFiles.length,
      validation_status: "unknown",
    },
  };
}

function buildResumedEventInput(artifact: ContinuationArtifact): Record<string, unknown> | null {
  if (!artifact.approvedProposalId) return null;
  const runId = runIdForProposal(artifact.approvedProposalId);
  return {
    ...basePiAgentRunEvent({
      runId,
      proposalId: artifact.approvedProposalId,
      sequence: 1,
      idempotencyKey: `${runId}:agent_run.resumed`,
    }),
    eventType: "agent_run.resumed",
    payload: {
      continuation_id: `cont_${safeIdToken(artifact.approvedProposalId)}`,
      resumed_by: "agent",
      resume_source: "saved_continuation",
      validation_status: "unknown",
      call_key: "ready_to_resume",
      action_key: "resume_run",
    },
  };
}

function buildQueuedForMorningEventInput(
  proposal: ProposalRecord,
  nextWindowStartsAt: string,
): Record<string, unknown> {
  const runId = runIdForProposal(proposal.id);
  return {
    ...basePiAgentRunEvent({
      runId,
      proposalId: proposal.id,
      sequence: 1,
      idempotencyKey: `${runId}:agent_run.queued_for_morning`,
    }),
    eventType: "agent_run.queued_for_morning",
    payload: {
      queue_id: `queue_${safeIdToken(proposal.id)}`,
      boundary_type: "off_the_clock",
      next_window_starts_at: nextWindowStartsAt,
      reason_codes: ["outside_work_window", "non_urgent_ask"],
      task_category: "coding_agent_change",
      urgency_bucket: "normal",
      source_ref_type: proposal.sourceRef ? "ticket" : "unknown",
      call_key: "off_the_clock",
      recommended_action_key: "queue_for_morning",
    },
  };
}

function buildDeferredDecisionEventInput(input: {
  telemetry: PiRunTelemetry;
  proposal: ProposalRecord | null;
  decisionId?: string;
  decisionKind: ReturnType<typeof pickDecisionKind>;
  decisionCategory: ReturnType<typeof pickDecisionCategory>;
  urgencyBucket: AutopilotDeferralUrgencyBucket;
  flaggedForReview: boolean;
  localSessionSummary: LocalSessionSummary;
}): Record<string, unknown> {
  const decisionId = input.decisionId ?? `decision_${randomBytes(16).toString("hex")}`;

  return {
    ...basePiAgentRunEvent({
      runId: input.telemetry.runId,
      proposalId: input.proposal?.id ?? input.telemetry.proposalId,
      sequence: input.telemetry.sequence,
      idempotencyKey: `${input.telemetry.runId}:deferred_decision.recorded:${decisionId}`,
    }),
    eventType: "deferred_decision.recorded",
    payload: stripUndefinedValues({
      decision_id: decisionId,
      decision_kind: input.decisionKind,
      decision_category: input.decisionCategory,
      urgency_bucket: input.urgencyBucket,
      flagged_for_review: input.flaggedForReview,
      proposal_id: input.proposal?.id,
      local_session_summary: input.localSessionSummary,
    }),
  };
}

function buildTerminalEventInput(
  telemetry: PiRunTelemetry,
  outcome: "completed" | "failed" | "partially_completed" | "cancelled" | "timed_out",
  errorCategory?: string,
  testsPassed?: boolean,
): Record<string, unknown> {
  const durationSeconds = Math.max(0, Math.floor((Date.now() - telemetry.startedAt) / 1000));
  const validationStatus =
    testsPassed === true ? "passed" : testsPassed === false ? "failed" : "unknown";
  const eventType =
    outcome === "failed" || outcome === "timed_out"
      ? "agent_run.failed"
      : outcome === "cancelled"
        ? "agent_run.cancelled"
        : "agent_run.completed";
  const payload =
    eventType === "agent_run.failed"
      ? {
          failure_category: normalizeFailureCategory(
            errorCategory ?? (outcome === "timed_out" ? "timeout" : "unknown"),
          ),
          duration_seconds: durationSeconds,
          recoverable: true,
          validation_status: validationStatus,
          tool_calls_count: telemetry.toolCallsCount,
          handoff_saved: false,
        }
      : eventType === "agent_run.cancelled"
        ? {
            cancelled_by: "agent",
            reason_code: "user_cancelled",
            duration_seconds: durationSeconds,
            handoff_saved: false,
          }
        : {
            outcome: mapTaskOutcomeToAgentRunOutcome(outcome),
            completed_at: new Date().toISOString(),
            duration_seconds: durationSeconds,
            validation_status: validationStatus,
            files_touched_count: telemetry.filesModified.size,
            tool_calls_count: telemetry.toolCallsCount,
            failure_category: errorCategory ? normalizeFailureCategory(errorCategory) : undefined,
          };

  return {
    ...basePiAgentRunEvent({
      runId: telemetry.runId,
      proposalId: telemetry.proposalId,
      sequence: telemetry.sequence,
      idempotencyKey: `${telemetry.runId}:${eventType}`,
    }),
    eventType,
    payload: stripUndefinedValues(payload),
  };
}

function buildSteeringOutcomeEventInput(
  telemetry: PiRunTelemetry,
  outcome: string,
  errorCategory?: string,
  testsPassed?: boolean,
): Record<string, unknown> {
  const durationSeconds = Math.max(0, Math.floor((Date.now() - telemetry.startedAt) / 1000));
  return {
    ...basePiAgentRunEvent({
      runId: telemetry.runId,
      proposalId: telemetry.proposalId,
      sequence: telemetry.sequence,
      idempotencyKey: `${telemetry.runId}:steering_outcome.reported`,
    }),
    eventType: "steering_outcome.reported",
    payload: stripUndefinedValues({
      outcome: mapTaskOutcomeToAgentRunOutcome(outcome),
      call_key: "good_to_run",
      action_key: "continue",
      validation_status:
        testsPassed === true ? "passed" : testsPassed === false ? "failed" : "unknown",
      validation_kind: testsPassed === undefined ? "unknown" : "targeted_test",
      error_category: errorCategory ? normalizeFailureCategory(errorCategory) : undefined,
      duration_seconds: durationSeconds,
      files_touched_count: telemetry.filesModified.size,
    }),
  };
}

const REPORT_AGENT_RUN_EVENT_MUTATION = `
  mutation ReportAgentRunEvent($input: ReportAgentRunEventInput!) {
    reportAgentRunEvent(input: $input) {
      ok
      error {
        code
        message
        details
      }
      event {
        eventId
        eventType
      }
    }
  }
`;

const SHARE_LOCAL_REFEREE_OUTCOME_SUMMARY_MUTATION = `
  mutation ShareLocalRefereeOutcomeSummary($input: ShareLocalRefereeOutcomeSummaryInput!) {
    shareLocalRefereeOutcomeSummary(input: $input) {
      ok
      error {
        code
        message
      }
    }
  }
`;

const SUBMIT_PROPOSAL_WITH_IDEMPOTENCY_MUTATION = `
  mutation SubmitProposalWithIdempotency($input: ProposalInput!) {
    submitProposal(input: $input) {
      decision
      reason
      proposalId
      evaluatedAt
      wrapUpGuidance {
        active
        deadlineAt
        remainingMinutes
        profile
        source
        reason
        hints
        thresholdMinutes
        selectedMode
      }
    }
  }
`;

function toGraphQLWrapUpMode(
  mode: "auto" | "wrap_up" | "full_depth" | undefined,
): string | undefined {
  if (!mode) return undefined;
  return mode.toUpperCase();
}

function toAgentRunGraphQLEnum(value: string): string {
  return /^\d/.test(value) ? `_${value.toUpperCase()}` : value.toUpperCase();
}

function serializeAgentRunEventForGraphQL(input: Record<string, unknown>): Record<string, unknown> {
  const progressPayload = input.progressPayload as Record<string, unknown> | undefined;
  const serializedProgress = progressPayload
    ? stripUndefinedValues({
        ...progressPayload,
        filesReadBucket: toAgentRunGraphQLEnum(String(progressPayload.filesReadBucket)),
        filesModifiedBucket: toAgentRunGraphQLEnum(String(progressPayload.filesModifiedBucket)),
        validationLevel: String(progressPayload.validationLevel).toUpperCase(),
        validationStatus: String(progressPayload.validationStatus).toUpperCase(),
        progressState: String(progressPayload.progressState).toUpperCase(),
        scopeGrowthBucket: progressPayload.scopeGrowthBucket
          ? toAgentRunGraphQLEnum(String(progressPayload.scopeGrowthBucket))
          : undefined,
        confidenceBucket: progressPayload.confidenceBucket
          ? String(progressPayload.confidenceBucket).toUpperCase()
          : undefined,
        spendEstimateBucket: progressPayload.spendEstimateBucket
          ? toAgentRunGraphQLEnum(String(progressPayload.spendEstimateBucket))
          : undefined,
      })
    : undefined;

  return stripUndefinedValues({
    eventId: input.eventId ?? randomUUID(),
    schemaVersion: input.schemaVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...input,
    privacyMode: "METADATA_ONLY",
    progressPayload: serializedProgress,
  });
}

async function submitProposalCompat(
  client: HeadsDownClient,
  input: ProposalInput,
  idempotencyKey: string,
): Promise<Verdict> {
  const normalizedDescription = input.description?.trim();
  if (!normalizedDescription) {
    throw new Error("Proposal description is required.");
  }

  const normalizedAgentRef = input.agentRef?.trim();
  if (!normalizedAgentRef) {
    throw new Error("Agent reference is required.");
  }

  const sourceRef = input.sourceRef ?? `${normalizedAgentRef}-${Date.now()}-${randomHex(6)}`;

  const normalizedInput: ProposalInput = {
    ...input,
    agentRef: normalizedAgentRef,
    description: normalizedDescription,
    sourceRef,
  };

  const graphql = getLowLevelGraphQLClient(client);
  if (!graphql) {
    return client.submitProposal(normalizedInput);
  }

  const mutationInput = stripUndefinedValues({
    agentRef: normalizedAgentRef,
    model: input.model,
    framework: input.framework,
    description: normalizedDescription,
    estimatedFiles: input.estimatedFiles,
    estimatedMinutes: input.estimatedMinutes,
    scopeSummary: input.scopeSummary,
    sourceRef,
    idempotencyKey,
    deliveryMode: toGraphQLWrapUpMode(input.deliveryMode),
  });

  try {
    const data = await graphql.request(SUBMIT_PROPOSAL_WITH_IDEMPOTENCY_MUTATION, {
      input: mutationInput,
    });

    const verdict = (data.submitProposal as Verdict | null | undefined) ?? null;
    if (!verdict) {
      throw new Error("HeadsDown API returned no submitProposal data.");
    }

    return verdict;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Field "idempotencyKey" is not defined by type "ProposalInput"')) {
      return client.submitProposal(normalizedInput);
    }
    throw error;
  }
}

function progressStateForBashCommand(command: string): PiProgressState | null {
  const normalized = command.trim();
  if (normalized.length === 0) return null;

  if (
    /^(?:env\s+)?(?:npm|pnpm|yarn)\s+(?:test|run\s+test|run\s+lint|run\s+typecheck|run\s+compile)\b/i.test(
      normalized,
    ) ||
    /^(?:env\s+)?(?:vitest|jest|pytest|go\s+test|cargo\s+test|mix\s+(?:test|compile))\b/i.test(
      normalized,
    )
  ) {
    return "validating";
  }

  if (
    /^(?:env\s+)?git\s+(?:commit|push)\b/i.test(normalized) ||
    /^(?:env\s+)?gh\s+pr\s+(?:create|edit|ready|view|checks)\b/i.test(normalized)
  ) {
    return "ready_for_review";
  }

  return null;
}

function isReadonlyBashCommand(command: string): boolean {
  const normalized = command.trim();
  if (normalized.length === 0) return true;

  const readonlyPatterns = [
    /^(?:env\s+)?(?:ls|pwd|cat|grep|rg|find|head|tail|wc|which|whereis|whoami|date)\b/i,
    /^(?:env\s+)?git\s+(?:status|diff|show|log|branch|rev-parse|remote|fetch)\b/i,
    /^(?:env\s+)?(?:npm|pnpm|yarn)\s+(?:test|run\s+test|run\s+lint|run\s+typecheck|list)\b/i,
    /^(?:env\s+)?(?:vitest|jest|pytest|go\s+test|cargo\s+test|mix\s+test)\b/i,
  ];

  return readonlyPatterns.some((pattern) => pattern.test(normalized));
}

function isPotentiallyMutatingBashCommand(command: string): boolean {
  const normalized = command.trim();
  if (normalized.length === 0) return false;
  if (isReadonlyBashCommand(normalized)) return false;

  const mutatingPatterns = [
    /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|truncate|chmod|chown|ln|install)\b/i,
    /(^|[;&|]\s*)git\s+(add|commit|reset|checkout|switch|restore|clean|apply|am|cherry-pick|merge|rebase)\b/i,
    /(^|[;&|]\s*)(npm|pnpm|yarn)\s+(install|add|remove|uninstall|update)\b/i,
    /(^|[;&|]\s*)(pip|pip3|brew|cargo|go\s+mod)\s+(install|add|remove|uninstall|tidy|get)\b/i,
    /(^|[;&|]\s*)(sed|perl)\s+-i\b/i,
    /(^|[;&|]\s*)tee\b/i,
    /(^|[^\\])>>?\s*[^\s]/,
  ];

  return mutatingPatterns.some((pattern) => pattern.test(normalized));
}

async function continuationExists(): Promise<boolean> {
  try {
    await access(CONTINUATION_PATH);
    return true;
  } catch {
    return false;
  }
}

type ContinuationLoadErrorReason = "not_found" | "read_failed" | "parse_failed" | "unlink_failed";

type ContinuationLoadError = {
  reason: ContinuationLoadErrorReason;
  message: string;
};

type ContinuationLoadResult = {
  artifact: ContinuationArtifact | null;
  error: ContinuationLoadError | null;
};

function normalizeContinuationArtifact(value: unknown): ContinuationArtifact | null {
  if (!value || typeof value !== "object") return null;

  const artifact = value as Record<string, unknown>;
  return {
    branch: toStringOrNull(artifact.branch),
    runId: toStringOrNull(artifact.runId),
    approvedProposalId: toStringOrNull(artifact.approvedProposalId),
    approvedProposalDescription: toStringOrNull(artifact.approvedProposalDescription),
    estimatedFiles: typeof artifact.estimatedFiles === "number" ? artifact.estimatedFiles : null,
    modifiedFiles: normalizeStringArray(artifact.modifiedFiles),
    openDecisions: normalizeStringArray(artifact.openDecisions),
    pendingSteps: normalizeStringArray(artifact.pendingSteps),
    completedSteps: normalizeStringArray(artifact.completedSteps),
    resumeInstruction: toStringOrNull(artifact.resumeInstruction),
    wrapUpInstruction: toStringOrNull(artifact.wrapUpInstruction),
    savedAt: toStringOrNull(artifact.savedAt) ?? new Date(0).toISOString(),
    reason: toStringOrNull(artifact.reason) ?? "unknown",
  };
}

async function loadContinuationArtifactFromPath(
  path: string,
  removeAfterRead: boolean,
): Promise<ContinuationLoadResult> {
  let raw: string;

  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return { artifact: null, error: null };
    }

    return {
      artifact: null,
      error: { reason: "read_failed", message: sanitizeErrorMessage(error) },
    };
  }

  let artifact: ContinuationArtifact | null;
  try {
    artifact = normalizeContinuationArtifact(JSON.parse(raw));
  } catch (error) {
    return {
      artifact: null,
      error: { reason: "parse_failed", message: sanitizeErrorMessage(error) },
    };
  }

  if (!artifact) {
    return {
      artifact: null,
      error: { reason: "parse_failed", message: "Continuation artifact is not an object." },
    };
  }

  if (removeAfterRead) {
    try {
      await unlink(path);
    } catch (error) {
      return {
        artifact,
        error: { reason: "unlink_failed", message: sanitizeErrorMessage(error) },
      };
    }
  }

  return { artifact, error: null };
}

async function loadContinuationArtifact(removeAfterRead: boolean): Promise<ContinuationLoadResult> {
  return loadContinuationArtifactFromPath(CONTINUATION_PATH, removeAfterRead);
}

async function clearContinuationArtifact(): Promise<boolean> {
  try {
    await unlink(CONTINUATION_PATH);
    return true;
  } catch {
    return false;
  }
}

async function saveContinuationArtifact(artifact: ContinuationArtifact): Promise<void> {
  await mkdir(dirname(CONTINUATION_PATH), { recursive: true });
  await writeFile(CONTINUATION_PATH, JSON.stringify(artifact, null, 2), { mode: 0o600 });
}

function buildHeadsDownCompaction(input: HeadsDownCompactionInput): {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: HeadsDownCompactionDetails;
} | null {
  const activeTimeBox =
    input.timeBox && input.timeBox.expiresAt > Date.now() ? input.timeBox : null;
  const hasContext =
    Boolean(input.availabilitySummary) ||
    Boolean(input.wrapUpInstruction) ||
    Boolean(activeTimeBox) ||
    Boolean(input.proposal) ||
    Boolean(input.scope && input.scope.modifiedFiles.length > 0);

  if (!hasContext) {
    return null;
  }

  const lines: string[] = [
    "## HeadsDown continuity",
    "Capture this context to preserve task execution constraints after compaction.",
  ];

  if (input.availabilitySummary) {
    lines.push(`- Availability: ${input.availabilitySummary}`);
  }

  if (input.wrapUpInstruction) {
    lines.push(`- Execution policy: ${input.wrapUpInstruction}`);
  }

  if (activeTimeBox) {
    lines.push(`- Active time box expires at ${new Date(activeTimeBox.expiresAt).toISOString()}.`);
  }

  if (input.proposal) {
    lines.push(
      `- Active approved proposal: ${input.proposal.description} (id: ${input.proposal.id})`,
    );

    if (typeof input.proposal.estimatedFiles === "number") {
      const touched = input.scope?.modifiedFiles.length ?? 0;
      lines.push(`- Scope progress: ${touched}/${input.proposal.estimatedFiles} files touched.`);
    }

    if (input.proposal.scopeSummary) {
      lines.push(`- Approved scope summary: ${input.proposal.scopeSummary}`);
    }
  }

  if (input.scope && input.scope.modifiedFiles.length > 0) {
    lines.push(`- Modified files tracked: ${input.scope.modifiedFiles.join(", ")}`);
  }

  if (input.scope?.warningSent) {
    lines.push(
      "- Scope drift warning already triggered. Re-propose if continuing beyond approved scope.",
    );
  }

  lines.push("- Next step: resume from the active proposal before starting unrelated work.");

  return {
    summary: lines.join("\n"),
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    details: {
      v: 1,
      headsdown: {
        summary: input.availabilitySummary,
        wrapUpInstruction: input.wrapUpInstruction,
        timeBox: activeTimeBox,
        proposal: input.proposal
          ? {
              id: input.proposal.id,
              description: input.proposal.description,
              estimatedFiles: input.proposal.estimatedFiles ?? null,
              estimatedMinutes: input.proposal.estimatedMinutes ?? null,
              scopeSummary: input.proposal.scopeSummary ?? null,
              sourceRef: input.proposal.sourceRef ?? null,
            }
          : null,
        scope: input.scope
          ? {
              modifiedFiles: input.scope.modifiedFiles,
              warningSent: input.scope.warningSent,
              updatedAt: input.scope.updatedAt,
            }
          : null,
        savedAt: new Date().toISOString(),
      },
    },
  };
}

interface HeadsDownCommandOption {
  value: string;
  label: string;
  description: string;
  menu?: boolean;
}

const HEADSDOWN_COMMAND_OPTIONS: HeadsDownCommandOption[] = [
  {
    value: "status",
    label: "Status",
    description: "Refresh HeadsDown status and run guidance",
    menu: true,
  },
  { value: "help", label: "Help", description: "Show HeadsDown command help", menu: true },
  { value: "menu", label: "Menu", description: "Open this interactive HeadsDown command picker" },
  {
    value: "digest",
    label: "Digest",
    description: "Show how many digest summaries are waiting",
    menu: true,
  },
  {
    value: "referee",
    label: "Local Referee",
    description: "Verify the current run locally without a HeadsDown account",
    menu: true,
  },
  {
    value: "box 15m",
    label: "Time box: 15 minutes",
    description: "Set a local session time box for 15 minutes",
    menu: true,
  },
  {
    value: "box 1h",
    label: "Time box: 1 hour",
    description: "Set a local session time box for 1 hour",
    menu: true,
  },
  {
    value: "box status",
    label: "Time box status",
    description: "Show the active local session time box",
    menu: true,
  },
  {
    value: "box clear",
    label: "Clear time box",
    description: "Cancel the active local session time box",
    menu: true,
  },
  {
    value: "extend 15m",
    label: "Extend (15m)",
    description: "Extend the active window-closing run by 15 minutes",
    menu: true,
  },
  {
    value: "wrap",
    label: "Wrap",
    description: "Request pause and summarize for the active window-closing run",
    menu: true,
  },
  {
    value: "details on",
    label: "Details on",
    description: "Show the HeadsDown details widget",
    menu: true,
  },
  {
    value: "details off",
    label: "Details off",
    description: "Hide the HeadsDown details widget",
    menu: true,
  },
  {
    value: "details toggle",
    label: "Toggle details",
    description: "Toggle the HeadsDown details widget",
    menu: true,
  },
  {
    value: "theme list",
    label: "List themes",
    description: "List HeadsDown UI themes",
    menu: true,
  },
  {
    value: "theme neo",
    label: "Theme: Neo",
    description: "Switch to the Neo HeadsDown UI theme",
    menu: true,
  },
  {
    value: "theme mono",
    label: "Theme: Mono",
    description: "Switch to the Mono HeadsDown UI theme",
    menu: true,
  },
  {
    value: "theme executive",
    label: "Theme: Executive",
    description: "Switch to the Executive HeadsDown UI theme",
    menu: true,
  },
  {
    value: "theme reset",
    label: "Reset theme",
    description: "Reset HeadsDown UI theme to the configured default",
    menu: true,
  },
];

function normalizeHeadsDownCommandArgs(args: string | null | undefined): string {
  const normalized = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "status" ? "" : normalized;
}

function getHeadsDownCommandCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trim().toLowerCase().replace(/\s+/g, " ");
  const filtered = HEADSDOWN_COMMAND_OPTIONS.filter((option) => option.value.startsWith(prefix));

  if (filtered.length === 0) return null;

  return filtered.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const partRecord = part as Record<string, unknown>;
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function shouldRecordAutopilotDeferral(input: {
  message: unknown;
  mode: string | null | undefined;
  config: AutopilotDeferralConfig;
}): { matched: boolean; matchedPatternKey: string | null } {
  const message = input.message as { role?: string } | null | undefined;
  if (message?.role !== "assistant") return { matched: false, matchedPatternKey: null };
  if (!input.config.enabled) return { matched: false, matchedPatternKey: null };
  if (input.mode !== "offline" && input.mode !== "limited") {
    return { matched: false, matchedPatternKey: null };
  }

  return detectDeferral(extractAssistantText(input.message), input.config.patterns);
}

function buildHeadsDownCommandHelp(): string {
  return [
    "HeadsDown commands:",
    "",
    "Status",
    "  /headsdown",
    "  /headsdown status",
    "  /headsdown digest",
    "",
    "Local verification",
    "  /headsdown referee",
    "",
    "Local time box",
    "  /headsdown box <duration>  (examples: 15m, 1h, 90m, 1h30m)",
    "  /headsdown box status",
    "  /headsdown box clear",
    "",
    "Run actions",
    "  /headsdown extend [duration]  (default: 15m)",
    "  /headsdown wrap",
    "",
    "Display",
    "  /headsdown details <on|off|toggle>",
    "  /headsdown theme <neo|mono|executive|list|reset>",
    "",
    "Discovery",
    "  /headsdown help",
    "  /headsdown menu",
  ].join("\n");
}

export const __internal = {
  AVAILABILITY_COMPAT_QUERY,
  ACTIVE_AVAILABILITY_OVERRIDE_QUERY,
  CREATE_AVAILABILITY_OVERRIDE_MUTATION,
  CANCEL_AVAILABILITY_OVERRIDE_MUTATION,
  AGENT_CONTROL_OVERVIEW_QUERY,
  APPLY_HEADSDOWN_ACTION_MUTATION,
  getLowLevelGraphQLClient,
  getAvailabilityContext,
  getAgentControlOverviewCompat,
  getAgentControlOverviewResult,
  applyHeadsDownActionCompat,
  buildActorContext,
  withActorContext,
  createAvailabilityOverrideCompat,
  getActiveAvailabilityOverrideCompat,
  cancelAvailabilityOverrideCompat,
  normalizeToolPath,
  normalizeCallKey,
  normalizeActionKey,
  normalizeRunState,
  toGraphQLEnumValue,
  normalizeHeadsDownCallPayload,
  normalizeRunSummaryPayload,
  normalizeAgentControlOverviewPayload,
  pickQueueForMorningRun,
  isAlreadyQueuedForMorning,
  shouldAutoQueueForMorning,
  allowedActionKeysForCallPrompt,
  filterRenderedCallActions,
  pickReadyToResumeRun,
  normalizeContinuationArtifact,
  loadContinuationArtifactFromPath,
  resumeContinuationArtifact,
  buildQueuedForMorningContinuationArtifact,
  queueForMorningWithHandoff,
  resolveAllowedRunAction,
  allowedRunActionFailureMessage,
  isPotentiallyMutatingBashCommand,
  isReadonlyBashCommand,
  progressStateForBashCommand,
  buildHeadsDownCompaction,
  buildStartedEventInput,
  progressConfidenceBucket,
  buildProgressEventInput,
  buildScopeDriftEventInput,
  buildContinuationSavedEventInput,
  buildResumedEventInput,
  buildQueuedForMorningEventInput,
  buildTerminalEventInput,
  buildSteeringOutcomeEventInput,
  serializeAgentRunEventForGraphQL,
  buildDeferredDecisionEventInput,
  buildLocalSessionSummary,
  detectDeferral,
  normalizeAutopilotDeferralConfig,
  mapTaskOutcomeToAgentRunOutcome,
  runIdForProposal,
  resolveAttentionWindowRun,
  parseExtendDurationMinutes,
  attentionWindowStatusText,
  ATTENTION_WINDOW_POLL_COOLDOWN_MS,
  ATTENTION_WINDOW_STATUS_KEY,
  TIME_BOX_STATUS_KEY,
  TIME_BOX_WIDGET_KEY,
  advanceTimeBoxForPrompt,
  createTimeBox,
  formatTimeBoxConfirmation,
  formatTimeBoxStatus,
  parseTimeBoxDuration,
  resolveEffectiveDeadline,
  HEADSDOWN_COMMAND_OPTIONS,
  buildHeadsDownCommandHelp,
  getHeadsDownCommandCompletions,
  normalizeHeadsDownCommandArgs,
  extractAssistantText,
  shouldRecordAutopilotDeferral,
  toOpaqueWorkspaceRef,
  runLocalReferee,
  CONTINUATION_PATH,
};

export default function headsdownExtension(pi: ExtensionAPI) {
  let approvedProposals: ProposalRecord[] = [];
  let proposalScopes = new Map<string, ProposalScopeSnapshot>();
  let cachedConfig: HeadsDownPiConfig | null = null;
  let cachedClient: HeadsDownClient | null = null;
  let lastApprovedProposalId: string | null = null;
  let lastAutoThinkingLevel: ThinkingLevel | null = null;
  let availabilitySnapshot: AvailabilitySnapshot | null = null;
  const runTelemetry = new Map<string, PiRunTelemetry>();
  let autoQueuedRunIds = new Set<string>();
  let activeTimeBox: TimeBoxState | null = null;
  const attentionWindowDedupe = new Map<string, string>();
  let lastAttentionWindowPollAt = 0;
  let lastAttentionWindowPollFailureNoticeAt = 0;
  const pendingOutcomeSharePreviews = new Map<
    string,
    {
      workspaceRef: string;
      payloadHash: string;
      createdAt: number;
    }
  >();

  function getLatestApprovedProposal(): ProposalRecord | null {
    const now = Date.now();
    const approved = approvedProposals.filter(
      (proposal) =>
        proposal.decision === "approved" &&
        now - new Date(proposal.evaluatedAt).getTime() < MAX_PROPOSAL_AGE_MS,
    );
    if (approved.length === 0) return null;
    return approved.reduce((latest, current) => {
      return new Date(current.evaluatedAt).getTime() > new Date(latest.evaluatedAt).getTime()
        ? current
        : latest;
    });
  }

  function hasApprovedProposal(): boolean {
    return getLatestApprovedProposal() !== null;
  }

  function getScopeSnapshot(proposalId: string): ProposalScopeSnapshot {
    const existing = proposalScopes.get(proposalId);
    if (existing) return existing;

    const snapshot: ProposalScopeSnapshot = {
      proposalId,
      modifiedFiles: [],
      warningSent: false,
      updatedAt: new Date().toISOString(),
    };

    proposalScopes.set(proposalId, snapshot);
    return snapshot;
  }

  function restoreProposalState(ctx: ExtensionContext) {
    approvedProposals = [];
    proposalScopes = new Map<string, ProposalScopeSnapshot>();
    const now = Date.now();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;

      if (entry.customType === "headsdown-proposal") {
        const data = entry.data as ProposalState | undefined;
        if (data?.proposals) {
          approvedProposals = data.proposals
            .filter(
              (proposal) => now - new Date(proposal.evaluatedAt).getTime() < MAX_PROPOSAL_AGE_MS,
            )
            .map((proposal) => ({
              ...proposal,
              estimatedFiles:
                typeof proposal.estimatedFiles === "number" ? proposal.estimatedFiles : undefined,
              estimatedMinutes:
                typeof proposal.estimatedMinutes === "number"
                  ? proposal.estimatedMinutes
                  : undefined,
            }));
        }
      }

      if (entry.customType === "headsdown-scope") {
        const data = entry.data as ProposalScopeSnapshot | undefined;
        if (!data?.proposalId) continue;
        proposalScopes.set(data.proposalId, {
          proposalId: data.proposalId,
          modifiedFiles: normalizeStringArray(data.modifiedFiles),
          warningSent: data.warningSent === true,
          updatedAt: data.updatedAt ?? new Date().toISOString(),
        });
      }
    }

    lastApprovedProposalId = getLatestApprovedProposal()?.id ?? null;
  }

  function persistProposals() {
    pi.appendEntry<ProposalState>("headsdown-proposal", {
      proposals: approvedProposals,
    });
  }

  function persistScope(snapshot: ProposalScopeSnapshot) {
    pi.appendEntry<ProposalScopeSnapshot>("headsdown-scope", snapshot);
  }

  function normalizeTimeBoxState(value: unknown): TimeBoxState | null {
    if (!value || typeof value !== "object") return null;
    const state = value as Partial<TimeBoxState>;
    if (
      !Number.isFinite(state.startedAt) ||
      !Number.isFinite(state.windDownAt) ||
      !Number.isFinite(state.expiresAt) ||
      state.startedAt! > state.windDownAt! ||
      state.windDownAt! > state.expiresAt!
    ) {
      return null;
    }

    return {
      startedAt: state.startedAt!,
      windDownAt: state.windDownAt!,
      expiresAt: state.expiresAt!,
      windDownFired: state.windDownFired === true,
    };
  }

  function restoreTimeBoxState(ctx: ExtensionContext) {
    activeTimeBox = null;
    const now = Date.now();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "headsdown-time-box") {
        const data = entry.data as TimeBoxSessionState | undefined;
        const state = normalizeTimeBoxState(data?.state);
        activeTimeBox = state && state.expiresAt > now ? state : null;
        continue;
      }

      const compactionTimeBox = extractCompactionTimeBox(entry);
      if (compactionTimeBox) {
        activeTimeBox = compactionTimeBox.expiresAt > now ? compactionTimeBox : null;
      }
    }
  }

  function extractCompactionTimeBox(entry: unknown): TimeBoxState | null {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (record.type !== "compaction" && record.type !== "branch_summary") return null;
    const details = record.details as HeadsDownCompactionDetails | undefined;
    if (!details || details.v !== 1 || !details.headsdown) return null;
    return normalizeTimeBoxState(details.headsdown.timeBox);
  }

  function persistTimeBox(): boolean {
    const appendEntry = (pi as ExtensionAPI & { appendEntry?: ExtensionAPI["appendEntry"] })
      .appendEntry;
    if (typeof appendEntry !== "function") return false;
    appendEntry<TimeBoxSessionState>("headsdown-time-box", {
      state: activeTimeBox,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  function clearTimeBoxUI(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(TIME_BOX_STATUS_KEY, undefined);
    ctx.ui.setWidget(TIME_BOX_WIDGET_KEY, undefined);
  }

  function refreshActiveTimeBox(): TimeBoxState | null {
    if (activeTimeBox && Date.now() >= activeTimeBox.expiresAt) {
      activeTimeBox = null;
      persistTimeBox();
    }
    return activeTimeBox;
  }

  function formatRemainingMinutesLabel(remainingMinutes: number): string {
    return remainingMinutes <= 1 ? "<1" : String(remainingMinutes);
  }

  function updateTimeBoxUI(ctx: ExtensionContext, backendDeadlineAt: string | null = null) {
    if (!ctx.hasUI) return;
    const box = refreshActiveTimeBox();
    if (!box) {
      clearTimeBoxUI(ctx);
      return;
    }

    const now = Date.now();
    const boxRemainingMinutes = Math.max(0, Math.ceil((box.expiresAt - now) / 60_000));
    ctx.ui.setStatus(
      TIME_BOX_STATUS_KEY,
      `Box: ${formatRemainingMinutesLabel(boxRemainingMinutes)}m left`,
    );

    const effective = resolveEffectiveDeadline(box, backendDeadlineAt, now);
    if (
      effective.source === "none" ||
      effective.remainingMinutes > TIME_BOX_WIDGET_THRESHOLD_MINUTES
    ) {
      ctx.ui.setWidget(TIME_BOX_WIDGET_KEY, undefined);
      return;
    }

    if (effective.source === "backend") {
      ctx.ui.setWidget(TIME_BOX_WIDGET_KEY, [
        `Service deadline arrives in ${formatRemainingMinutesLabel(effective.remainingMinutes)}m`,
        "/headsdown extend 15m  /  /headsdown wrap",
      ]);
      return;
    }

    ctx.ui.setWidget(TIME_BOX_WIDGET_KEY, [
      `Box expires in ${formatRemainingMinutesLabel(effective.remainingMinutes)}m`,
      "Wrap cleanly, or clear the box with /headsdown box clear",
    ]);
  }

  function getTelemetryForProposal(proposal: ProposalRecord): PiRunTelemetry {
    const existing = runTelemetry.get(proposal.id);
    if (existing) return existing;

    const telemetry: PiRunTelemetry = {
      runId: `${runIdForProposal(proposal.id)}_${randomHex(8)}`,
      proposalId: proposal.id,
      startedAt: Date.now(),
      sequence: 1,
      toolCallsCount: 0,
      toolReadCount: 0,
      toolWriteCount: 0,
      toolExternalCount: 0,
      failureCount: 0,
      retryCount: 0,
      redirectCount: 0,
      filesRead: new Set(),
      filesModified: new Set(getScopeSnapshot(proposal.id).modifiedFiles),
      progressState: "working",
      startedReported: false,
      scopeDriftReported: false,
      completedReported: false,
      deferredDecisionsCount: 0,
    };
    runTelemetry.set(proposal.id, telemetry);
    return telemetry;
  }

  async function getAgentControlOverviewSafe(
    ctx: ExtensionContext,
  ): Promise<AgentControlOverview | null> {
    try {
      const client = await getClient();
      if (!client) return null;
      const actorClient = withActorContext(client, ctx);
      const method = (
        actorClient as unknown as {
          getAgentControlOverview?: () => Promise<AgentControlOverview>;
        }
      ).getAgentControlOverview;
      if (typeof method !== "function") return null;
      return await method.call(actorClient);
    } catch {
      return null;
    }
  }

  async function reportPiAgentRunEvent(_ctx: ExtensionContext, input: Record<string, unknown>) {
    try {
      const client = await getClient();
      if (!client) return;
      const eventClient = client as unknown as {
        reportAgentRunEvent?: (input: Record<string, unknown>) => Promise<unknown>;
      };
      if (typeof eventClient.reportAgentRunEvent === "function") {
        await eventClient.reportAgentRunEvent(input);
        return;
      }

      const graphql = getLowLevelGraphQLClient(client);
      if (!graphql) return;
      await graphql.request(REPORT_AGENT_RUN_EVENT_MUTATION, {
        input: serializeAgentRunEventForGraphQL(input),
      });
    } catch {
      // Event telemetry must never interrupt the agent run.
    }
  }

  async function reportStartedIfNeeded(ctx: ExtensionContext, proposal: ProposalRecord) {
    const telemetry = getTelemetryForProposal(proposal);
    if (telemetry.startedReported) return;
    telemetry.startedReported = true;
    telemetry.sequence += 1;
    await reportPiAgentRunEvent(ctx, buildStartedEventInput(proposal));
  }

  async function reportProgress(ctx: ExtensionContext, proposal: ProposalRecord) {
    const telemetry = getTelemetryForProposal(proposal);
    telemetry.sequence += 1;
    const scope = getScopeSnapshot(proposal.id);
    await reportPiAgentRunEvent(
      ctx,
      buildProgressEventInput(
        telemetry,
        scope.warningSent || telemetry.scopeDriftReported,
        proposal.estimatedFiles,
        proposal.estimatedMinutes,
      ),
    );
  }

  function defaultLocalRefereeOutcomeSharingState(): LocalRefereeOutcomeSharingState {
    return {
      privacyBoundaryVersion: LOCAL_REFEREE_OUTCOME_PRIVACY_BOUNDARY_VERSION,
      payloadSchemaVersion: 1,
      workspaces: {},
    };
  }

  function normalizeLocalRefereeOutcomeSharingState(raw: unknown): LocalRefereeOutcomeSharingState {
    const defaults = defaultLocalRefereeOutcomeSharingState();
    if (!raw || typeof raw !== "object") return defaults;

    const value = raw as Record<string, unknown>;
    if (value.privacyBoundaryVersion !== LOCAL_REFEREE_OUTCOME_PRIVACY_BOUNDARY_VERSION) {
      return defaults;
    }
    if (value.payloadSchemaVersion !== 1) return defaults;
    if (!value.workspaces || typeof value.workspaces !== "object") return defaults;

    const workspaces = Object.fromEntries(
      Object.entries(value.workspaces as Record<string, unknown>).filter(
        ([key, preference]) =>
          OPAQUE_WORKSPACE_REF_PATTERN.test(key) &&
          (preference === "local_only" || preference === "always_share"),
      ),
    ) as Record<string, LocalRefereeOutcomeSharingPreference>;

    return {
      privacyBoundaryVersion: value.privacyBoundaryVersion,
      payloadSchemaVersion: 1,
      workspaces,
    };
  }

  function isMissingFileError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
  }

  async function loadConfig(): Promise<HeadsDownPiConfig> {
    if (!cachedConfig) {
      const store = new ConfigStore();
      const baseConfig = await store.load();
      let rawAutoThinking: unknown;
      let rawAutopilotDeferral: unknown;
      let rawLocalRefereeOutcomeSharing: unknown;
      let configReadFailed = false;

      try {
        const rawConfig = JSON.parse(await readFile(store.filePath, "utf-8")) as Record<
          string,
          unknown
        >;
        rawAutoThinking = rawConfig.autoThinking;
        rawAutopilotDeferral = rawConfig.autopilotDeferral;
        rawLocalRefereeOutcomeSharing = rawConfig.localRefereeOutcomeSharing;
      } catch (error) {
        configReadFailed = !isMissingFileError(error);
        rawAutoThinking = undefined;
        rawAutopilotDeferral = undefined;
        rawLocalRefereeOutcomeSharing = undefined;
      }

      cachedConfig = {
        ...baseConfig,
        autoThinking: normalizeAutoThinkingConfig(rawAutoThinking),
        autopilotDeferral: normalizeAutopilotDeferralConfig(
          configReadFailed ? { enabled: false } : rawAutopilotDeferral,
        ),
        localRefereeOutcomeSharing: normalizeLocalRefereeOutcomeSharingState(
          rawLocalRefereeOutcomeSharing,
        ),
      };
    }
    return cachedConfig;
  }

  function workspaceOutcomeSharingPreference(
    config: HeadsDownPiConfig,
    workspaceRef: string,
  ): LocalRefereeOutcomeSharingPreference {
    if (
      config.localRefereeOutcomeSharing.privacyBoundaryVersion !==
      LOCAL_REFEREE_OUTCOME_PRIVACY_BOUNDARY_VERSION
    ) {
      return "local_only";
    }

    if (config.localRefereeOutcomeSharing.payloadSchemaVersion !== 1) {
      return "local_only";
    }

    return config.localRefereeOutcomeSharing.workspaces[workspaceRef] ?? "local_only";
  }

  async function updateLocalRefereeOutcomeSharingPreference(
    ctx: ExtensionContext,
    preference: LocalRefereeOutcomeSharingPreference,
  ): Promise<void> {
    const workspaceRef = toOpaqueWorkspaceRef(ctx.cwd);
    const store = new ConfigStore();
    const baseConfig = await store.load();
    let rawConfig: Record<string, unknown> = {};

    try {
      rawConfig = JSON.parse(await readFile(store.filePath, "utf-8")) as Record<string, unknown>;
    } catch {
      rawConfig = {};
    }

    const currentState = normalizeLocalRefereeOutcomeSharingState(
      rawConfig.localRefereeOutcomeSharing,
    );
    const nextWorkspaces = { ...currentState.workspaces };

    if (preference === "always_share") {
      nextWorkspaces[workspaceRef] = "always_share";
    } else {
      delete nextWorkspaces[workspaceRef];
    }

    const nextState: LocalRefereeOutcomeSharingState = {
      privacyBoundaryVersion: LOCAL_REFEREE_OUTCOME_PRIVACY_BOUNDARY_VERSION,
      payloadSchemaVersion: 1,
      workspaces: nextWorkspaces,
    };

    const updated = {
      ...rawConfig,
      ...baseConfig,
      localRefereeOutcomeSharing: nextState,
    };

    await mkdir(dirname(store.filePath), { recursive: true });
    await writeFile(store.filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");

    cachedConfig = {
      ...(cachedConfig ?? (await loadConfig())),
      localRefereeOutcomeSharing: nextState,
    };
  }

  function isHighSignalOutcomeSummary(
    result: Awaited<ReturnType<typeof runLocalReferee>>,
  ): boolean {
    return result.evaluation.verdict !== "passed" || result.evidence.outcome !== "unknown";
  }

  function issueOutcomeSharePreviewToken(workspaceRef: string, payloadHash: string): string {
    const now = Date.now();
    for (const [token, pending] of pendingOutcomeSharePreviews.entries()) {
      if (now - pending.createdAt > 15 * 60 * 1000) {
        pendingOutcomeSharePreviews.delete(token);
      }
    }

    const token = randomUUID();
    pendingOutcomeSharePreviews.set(token, { workspaceRef, payloadHash, createdAt: now });
    return token;
  }

  function consumeOutcomeSharePreviewToken(
    token: string | undefined,
    workspaceRef: string,
    payloadHash: string,
  ): boolean {
    if (!token) return false;

    const pending = pendingOutcomeSharePreviews.get(token);
    if (!pending) return false;

    pendingOutcomeSharePreviews.delete(token);
    return pending.workspaceRef === workspaceRef && pending.payloadHash === payloadHash;
  }

  function normalizeOutcomeShareFailureReason(code: unknown): string {
    const normalized = typeof code === "string" ? normalizeEnumKey(code) : null;
    if (normalized === "not_authenticated") return "not_authenticated";
    return "hosted_sync_unavailable";
  }

  async function shareLocalRefereeOutcomeSummary(
    payload: ReturnType<typeof buildLocalRefereeOutcomeSummaryPayload>,
  ): Promise<{ shared: boolean; reason: string }> {
    const client = await getClient();
    if (!client) {
      return { shared: false, reason: "not_authenticated" };
    }

    const graphql = getLowLevelGraphQLClient(client);
    if (!graphql) {
      return { shared: false, reason: "hosted_sync_unavailable" };
    }

    try {
      const data = await graphql.request(SHARE_LOCAL_REFEREE_OUTCOME_SUMMARY_MUTATION, {
        input: {
          summary: payload,
        },
      });
      const response = (data as Record<string, unknown>).shareLocalRefereeOutcomeSummary as
        | { ok?: boolean; error?: { code?: string | null } | null }
        | null
        | undefined;

      if (response?.ok) {
        return { shared: true, reason: "shared" };
      }

      return {
        shared: false,
        reason: normalizeOutcomeShareFailureReason(response?.error?.code),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("shareLocalRefereeOutcomeSummary") ||
        message.includes("ShareLocalRefereeOutcomeSummaryInput")
      ) {
        return { shared: false, reason: "hosted_sync_unavailable" };
      }

      return { shared: false, reason: "submit_failed" };
    }
  }

  async function getClient(): Promise<HeadsDownClient | null> {
    if (cachedClient) return cachedClient;
    try {
      cachedClient = await HeadsDownClient.fromCredentials();
      return cachedClient;
    } catch {
      return null;
    }
  }

  async function getClientOrThrow(): Promise<HeadsDownClient> {
    const client = await getClient();
    if (!client) {
      throw new Error(
        "Not authenticated with HeadsDown. Run the headsdown_auth tool to connect your account.",
      );
    }
    return client;
  }

  async function refreshAvailability(
    ctx: ExtensionContext,
    options: { force?: boolean; requireFresh?: boolean } = {},
  ): Promise<AvailabilitySnapshot | null> {
    const force = options.force === true;
    const requireFresh = options.requireFresh === true;
    const now = Date.now();

    if (
      !force &&
      availabilitySnapshot &&
      now - availabilitySnapshot.fetchedAt < AVAILABILITY_CACHE_TTL_MS
    ) {
      return availabilitySnapshot;
    }

    const client = await getClient();
    if (!client) {
      availabilitySnapshot = null;
      return null;
    }

    try {
      const actorClient = withActorContext(client, ctx);
      const availability = await getAvailabilityContext(actorClient);
      const summary = formatSummary(
        availability.contract,
        availability.calendar ?? availability.schedule,
      );
      const wrapUpInstruction = resolveExecutionInstruction({
        contract: availability.contract,
        schedule: availability.schedule,
      });

      availabilitySnapshot = {
        contract: availability.contract,
        calendar: availability.calendar,
        schedule: availability.schedule,
        summary,
        wrapUpInstruction,
        fetchedAt: now,
      };

      return availabilitySnapshot;
    } catch {
      return requireFresh ? null : availabilitySnapshot;
    }
  }

  type HeadsDownUIThemeName = "neo" | "mono" | "executive";

  type HeadsDownUITheme = {
    name: string;
    separator: string;
    modeIcons: Record<string, string>;
    frame: { top: string; side: string; bottom: string };
    glyphs: {
      policy: string;
      task: string;
      scope: string;
      hours: string;
      resume: string;
      lock: string;
      progressFull: string;
      progressEmpty: string;
    };
  };

  const HEADSDOWN_UI_THEMES: Record<HeadsDownUIThemeName, HeadsDownUITheme> = {
    neo: {
      name: "Neo",
      separator: " │ ",
      modeIcons: { online: "◉", busy: "◔", limited: "◑", offline: "○", none: "◌" },
      frame: { top: "╭─", side: "│", bottom: "╰─" },
      glyphs: {
        policy: "◈",
        task: "◎",
        scope: "◔",
        hours: "◷",
        resume: "✦",
        lock: "🔒",
        progressFull: "█",
        progressEmpty: "░",
      },
    },
    mono: {
      name: "Mono",
      separator: " | ",
      modeIcons: { online: "●", busy: "◐", limited: "◒", offline: "○", none: "·" },
      frame: { top: "+-", side: "|", bottom: "`-" },
      glyphs: {
        policy: "*",
        task: ">",
        scope: "=",
        hours: "~",
        resume: "+",
        lock: "!",
        progressFull: "#",
        progressEmpty: ".",
      },
    },
    executive: {
      name: "Executive",
      separator: " · ",
      modeIcons: { online: "◆", busy: "◈", limited: "◇", offline: "◻", none: "◻" },
      frame: { top: "┌─", side: "│", bottom: "└─" },
      glyphs: {
        policy: "◆",
        task: "◈",
        scope: "▣",
        hours: "◷",
        resume: "✶",
        lock: "🔐",
        progressFull: "▰",
        progressEmpty: "▱",
      },
    },
  };

  function normalizeUITheme(value: string | null | undefined): HeadsDownUIThemeName | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "neo" || normalized === "mono" || normalized === "executive") {
      return normalized;
    }
    return null;
  }

  const defaultUITheme: HeadsDownUIThemeName =
    normalizeUITheme(process.env.HEADSDOWN_UI_THEME) ?? "neo";
  let activeUITheme: HeadsDownUIThemeName = defaultUITheme;
  let detailsWidgetVisible = false;

  function getActiveUITheme(): HeadsDownUITheme {
    return HEADSDOWN_UI_THEMES[activeUITheme];
  }

  function truncateText(input: string, maxLength: number): string {
    const trimmed = input.trim();
    if (trimmed.length <= maxLength) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function formatClockZ(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return null;
    const hh = String(parsed.getUTCHours()).padStart(2, "0");
    const mm = String(parsed.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}Z`;
  }

  function formatCompactDuration(totalMinutes: number): string {
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
  }

  function formatRemainingMinutes(expiresAt: string | null | undefined): string | null {
    if (!expiresAt) return null;
    const expires = new Date(expiresAt);
    if (Number.isNaN(expires.getTime())) return null;

    const minutes = Math.round((expires.getTime() - Date.now()) / 60000);
    return minutes > 0 ? formatCompactDuration(minutes) : null;
  }

  function summarizeWrapUpInstruction(instruction: string): string {
    const normalized = instruction.trim().replace(/\s+/g, " ");

    if (normalized.toLowerCase().includes("proceed normally")) {
      return "Proceed normally";
    }

    if (normalized.toLowerCase().includes("keep scope minimal")) {
      return "Wrap-up mode, keep scope tight";
    }

    if (normalized.toLowerCase().includes("full implementation depth")) {
      return "Full-depth execution";
    }

    return truncateText(normalized, 56);
  }

  function renderScopeMeter(
    touched: number,
    estimatedFiles: number | undefined,
    theme: HeadsDownUITheme,
  ): string {
    const slots = 5;
    const ratio =
      typeof estimatedFiles === "number" && estimatedFiles > 0
        ? Math.min(1, touched / estimatedFiles)
        : Math.min(1, touched / slots);
    const filled = Math.max(0, Math.min(slots, Math.round(ratio * slots)));
    const empty = slots - filled;
    return `${theme.glyphs.progressFull.repeat(filled)}${theme.glyphs.progressEmpty.repeat(empty)}`;
  }

  function buildModeChip(
    mode: string | undefined,
    locked: boolean,
    theme: HeadsDownUITheme,
  ): string {
    const normalizedMode = (mode ?? "none").toLowerCase();
    const icon = theme.modeIcons[normalizedMode] ?? theme.modeIcons.none;
    return `${icon} HD ${(mode ?? "unknown").toUpperCase()}${locked ? ` ${theme.glyphs.lock}` : ""}`;
  }

  function buildStatusLine(input: {
    snapshot: AvailabilitySnapshot;
    activeProposal: ProposalRecord | null;
    proposalScope: ProposalScopeSnapshot | null;
    hasContinuation: boolean;
    theme: HeadsDownUITheme;
  }): string {
    const { snapshot, activeProposal, proposalScope, hasContinuation, theme } = input;
    const schedule = snapshot.schedule as
      | {
          inReachableHours?: boolean | null;
          nextTransitionAt?: string | null;
          wrapUpGuidance?: { active?: boolean | null; remainingMinutes?: number | null } | null;
        }
      | null
      | undefined;

    const mode = snapshot.contract?.mode;
    const locked = snapshot.contract?.lock === true;
    const statusText = snapshot.contract?.statusText
      ? truncateText(snapshot.contract.statusText.replace(/\s+/g, " "), 30)
      : null;
    const remaining = formatRemainingMinutes(snapshot.contract?.expiresAt);

    const badges: string[] = [buildModeChip(mode, locked, theme)];

    if (statusText) {
      badges.push(statusText);
    }

    if (remaining) {
      badges.push(remaining);
    }

    if (activeProposal) {
      const touched = proposalScope?.modifiedFiles.length ?? 0;
      const meter = renderScopeMeter(touched, activeProposal.estimatedFiles, theme);
      const progress =
        typeof activeProposal.estimatedFiles === "number"
          ? `${touched}/${activeProposal.estimatedFiles}`
          : `${touched}`;
      badges.push(`${theme.glyphs.scope} ${meter} ${progress}`);
    }

    if (schedule?.inReachableHours === false) {
      badges.push("OFF HOURS");
    }

    const nextTransition = formatClockZ(schedule?.nextTransitionAt);
    if (nextTransition) {
      badges.push(`NEXT ${nextTransition}`);
    }

    if (schedule?.wrapUpGuidance?.active) {
      const remainingWrapUp =
        typeof schedule.wrapUpGuidance.remainingMinutes === "number"
          ? formatCompactDuration(schedule.wrapUpGuidance.remainingMinutes)
          : null;
      badges.push(remainingWrapUp ? `WRAP ${remainingWrapUp}` : "WRAP");
    }

    if (hasContinuation) {
      badges.push(`${theme.glyphs.resume} RESUME`);
    }

    return badges.join(theme.separator);
  }

  function buildDetailsWidget(input: {
    snapshot: AvailabilitySnapshot;
    activeProposal: ProposalRecord | null;
    proposalScope: ProposalScopeSnapshot | null;
    hasContinuation: boolean;
    theme: HeadsDownUITheme;
  }): string[] {
    const { snapshot, activeProposal, proposalScope, hasContinuation, theme } = input;
    const schedule = snapshot.schedule as
      | {
          inReachableHours?: boolean | null;
          nextTransitionAt?: string | null;
        }
      | null
      | undefined;

    const lines = [`${theme.frame.top} HeadsDown · ${theme.name}`];

    if (snapshot.wrapUpInstruction) {
      lines.push(
        `${theme.frame.side} ${theme.glyphs.policy} policy  ${summarizeWrapUpInstruction(snapshot.wrapUpInstruction)}`,
      );
    }

    if (activeProposal) {
      const touched = proposalScope?.modifiedFiles.length ?? 0;
      const scopeText =
        typeof activeProposal.estimatedFiles === "number"
          ? `${touched}/${activeProposal.estimatedFiles} files`
          : `${touched} files touched`;
      const meter = renderScopeMeter(touched, activeProposal.estimatedFiles, theme);
      lines.push(
        `${theme.frame.side} ${theme.glyphs.task} task    ${truncateText(activeProposal.description, 52)}`,
      );
      lines.push(`${theme.frame.side} ${theme.glyphs.scope} scope   ${meter} ${scopeText}`);
    }

    if (snapshot.contract?.lock === true) {
      lines.push(
        `${theme.frame.side} ${theme.glyphs.lock} lock    Mutating changes require explicit user confirmation`,
      );
    }

    if (schedule?.inReachableHours === false) {
      const nextTransition = formatClockZ(schedule.nextTransitionAt);
      const hoursText = nextTransition
        ? `Outside reachable hours, next ${nextTransition}`
        : "Outside reachable hours";
      lines.push(`${theme.frame.side} ${theme.glyphs.hours} hours   ${hoursText}`);
    }

    if (hasContinuation) {
      lines.push(
        `${theme.frame.side} ${theme.glyphs.resume} resume  Saved state available via headsdown_continuation action=load`,
      );
    }

    if (lines.length === 1) {
      return [];
    }

    lines.push(
      `${theme.frame.bottom} /headsdown for full details · /headsdown details off · /headsdown theme <neo|mono|executive>`,
    );
    return lines;
  }

  async function updateStatusUI(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const snapshot = await refreshAvailability(ctx);
    const activeProposal = getLatestApprovedProposal();
    const proposalScope = activeProposal ? getScopeSnapshot(activeProposal.id) : null;
    const hasContinuation = await continuationExists();
    const theme = getActiveUITheme();

    if (!snapshot) {
      ctx.ui.setStatus("headsdown", "○ HD unavailable");
      ctx.ui.setWidget("headsdown", undefined);
      return;
    }

    const statusLine = buildStatusLine({
      snapshot,
      activeProposal,
      proposalScope,
      hasContinuation,
      theme,
    });

    ctx.ui.setStatus("headsdown", statusLine);

    const detailsWidget = buildDetailsWidget({
      snapshot,
      activeProposal,
      proposalScope,
      hasContinuation,
      theme,
    });

    ctx.ui.setWidget(
      "headsdown",
      detailsWidgetVisible && detailsWidget.length > 0 ? detailsWidget : undefined,
    );
  }

  async function checkPendingDigestCount(ctx: ExtensionContext): Promise<number> {
    try {
      const client = await getClient();
      if (!client) return 0;
      const actorClient = withActorContext(client, ctx);
      const summaries = await actorClient.listDigestSummaries({ latest: 20 });
      return summaries.length;
    } catch {
      return 0;
    }
  }

  async function currentBranchName(): Promise<string | null> {
    try {
      const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 5_000,
      });
      if (result.code !== 0) return null;
      const branch = result.stdout.trim();
      return branch.length > 0 ? branch : null;
    } catch {
      return null;
    }
  }

  async function createContinuationArtifact(reason: string): Promise<ContinuationArtifact | null> {
    const activeProposal = getLatestApprovedProposal();
    if (!activeProposal) return null;

    const scope = getScopeSnapshot(activeProposal.id);
    const wrapUpInstruction = availabilitySnapshot?.wrapUpInstruction ?? null;

    return {
      branch: await currentBranchName(),
      runId: getTelemetryForProposal(activeProposal).runId,
      approvedProposalId: activeProposal.id,
      approvedProposalDescription: activeProposal.description,
      estimatedFiles: activeProposal.estimatedFiles ?? null,
      modifiedFiles: [...scope.modifiedFiles],
      openDecisions: [],
      pendingSteps: [],
      completedSteps:
        scope.modifiedFiles.length > 0 ? ["Implemented part of approved proposal scope"] : [],
      resumeInstruction:
        scope.modifiedFiles.length > 0
          ? "Resume by reviewing modified files and finishing the remaining approved proposal scope."
          : "Resume by starting the approved proposal scope.",
      wrapUpInstruction,
      savedAt: new Date().toISOString(),
      reason,
    };
  }

  async function saveAutomaticContinuation(
    reason: string,
    ctx?: ExtensionContext,
  ): Promise<boolean> {
    const artifact = await createContinuationArtifact(reason);
    if (!artifact) return false;

    try {
      await saveContinuationArtifact(artifact);
      const proposal = getLatestApprovedProposal();
      if (ctx && proposal) {
        const telemetry = getTelemetryForProposal(proposal);
        telemetry.sequence += 1;
        await reportPiAgentRunEvent(ctx, buildContinuationSavedEventInput(telemetry, artifact));
      }
      return true;
    } catch {
      return false;
    }
  }

  function appendContinuityEntry(reason: string, details: Record<string, unknown> = {}) {
    const activeProposal = getLatestApprovedProposal();
    const scope = activeProposal ? getScopeSnapshot(activeProposal.id) : null;

    pi.appendEntry("headsdown-continuity", {
      reason,
      summary: availabilitySnapshot?.summary ?? null,
      wrapUpInstruction: availabilitySnapshot?.wrapUpInstruction ?? null,
      proposal: activeProposal
        ? {
            id: activeProposal.id,
            description: activeProposal.description,
            estimatedFiles: activeProposal.estimatedFiles ?? null,
            modifiedFiles: scope?.modifiedFiles ?? [],
            warningSent: scope?.warningSent ?? false,
          }
        : null,
      savedAt: new Date().toISOString(),
      ...details,
    });
  }

  function maybeUpdateAutoThinkingStatus(ctx: ExtensionContext, status: string | null) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("headsdown-auto-thinking", status ?? undefined);
  }

  async function applyAutoThinkingForTurn(ctx: ExtensionContext, prompt: string) {
    const config = await loadConfig();
    const autoThinking = config.autoThinking;

    if (!autoThinking.enabled) {
      maybeUpdateAutoThinkingStatus(ctx, null);
      return;
    }

    const schedule = availabilitySnapshot?.schedule as
      | {
          inReachableHours?: boolean | null;
          wrapUpGuidance?: { selectedMode?: string | null } | null;
        }
      | null
      | undefined;
    const currentLevel = pi.getThinkingLevel() as ThinkingLevel;
    const decision = decideAutoThinking({
      prompt,
      currentLevel,
      lastAutoLevel: lastAutoThinkingLevel,
      config: autoThinking,
      mode: availabilitySnapshot?.contract?.mode ?? null,
      inReachableHours: schedule?.inReachableHours ?? null,
      wrapUpSelectedMode: schedule?.wrapUpGuidance?.selectedMode ?? null,
      hasActiveProposal: hasApprovedProposal(),
    });

    let status = decision.status;

    if (decision.level) {
      pi.setThinkingLevel(decision.level);
      const effectiveLevel = pi.getThinkingLevel() as ThinkingLevel;
      lastAutoThinkingLevel = effectiveLevel;
      status = autoThinking.showStatus ? `thinking:auto ${effectiveLevel}` : null;
    } else if (decision.reason === "already_selected" || decision.reason === "downgrade_skipped") {
      lastAutoThinkingLevel = currentLevel;
    }

    maybeUpdateAutoThinkingStatus(ctx, autoThinking.showStatus ? status : null);
  }

  function policyInstructionForPrompt(): string | null {
    if (!availabilitySnapshot) return null;

    const policyLines = [`[HeadsDown] ${availabilitySnapshot.summary}`];

    if (availabilitySnapshot.wrapUpInstruction) {
      policyLines.push(
        `[HeadsDown] Wrap-Up instruction: ${availabilitySnapshot.wrapUpInstruction}`,
      );
    }

    const activeProposal = getLatestApprovedProposal();
    if (activeProposal) {
      const scope = getScopeSnapshot(activeProposal.id);
      const filesTouched = scope.modifiedFiles.length;
      const estimate =
        typeof activeProposal.estimatedFiles === "number"
          ? `${filesTouched}/${activeProposal.estimatedFiles} files touched`
          : `${filesTouched} files touched`;
      policyLines.push(
        `[HeadsDown] Active approved proposal: ${activeProposal.description} (${estimate}).`,
      );
    }

    return policyLines.join("\n");
  }

  function clearAttentionWindowWarning(ctx: ExtensionContext, runId?: string | null): void {
    if (runId) {
      attentionWindowDedupe.delete(runId);
    } else {
      attentionWindowDedupe.clear();
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus(ATTENTION_WINDOW_STATUS_KEY, undefined);
    }
  }

  function buildWrapUpGuidanceContextMessage(wrapUpHintInstruction: string) {
    return {
      role: "custom" as const,
      customType: "headsdown-wrap-up-guidance",
      content: `[HeadsDown] Wrap-Up hints: ${wrapUpHintInstruction}`,
      display: false,
      timestamp: Date.now(),
    };
  }

  function activeWrapUpDeadlineAt(
    guidance: ScheduleResolution["wrapUpGuidance"] | null | undefined,
  ): string | null {
    return guidance?.active === true ? (guidance.deadlineAt ?? null) : null;
  }

  function buildEffectiveWrapUpInstruction(
    guidance: ScheduleResolution["wrapUpGuidance"] | null | undefined,
  ): string | null {
    const effective = resolveEffectiveDeadline(
      activeTimeBox,
      activeWrapUpDeadlineAt(guidance),
      Date.now(),
    );
    if (effective.source !== "box") return formatWrapUpInstruction(guidance);

    const syntheticGuidance = {
      active: true,
      deadlineAt: effective.effectiveDeadlineAt,
      remainingMinutes: effective.remainingMinutes,
      thresholdMinutes: guidance?.thresholdMinutes ?? DEFAULT_ATTENTION_WINDOW_THRESHOLD_MINUTES,
      profile: guidance?.profile ?? "wrap_up",
      source: "time_box",
      reason: "Local time box is active",
      hints: guidance?.hints?.length ? guidance.hints : ["completion_first"],
      selectedMode: guidance?.selectedMode ?? "wrap_up",
    };
    const baseInstruction = formatWrapUpInstruction(
      syntheticGuidance as ScheduleResolution["wrapUpGuidance"],
    );
    const prefix = `You declared a local work box; about ${effective.remainingMinutes} minutes remain. Treat that as the primary deadline.`;
    return baseInstruction ? `${prefix} ${baseInstruction}` : prefix;
  }

  function shouldNotifyAttentionWindow(ctx: ExtensionContext): boolean {
    const isIdle = (ctx as ExtensionContext & { isIdle?: () => boolean }).isIdle;
    return typeof isIdle !== "function" || isIdle();
  }

  function deliverAttentionWindowWarning(
    ctx: ExtensionContext,
    input: {
      source: "box" | "backend";
      remainingMinutes: number | null | undefined;
      runKey: string;
      fingerprint: string;
    },
  ): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        ATTENTION_WINDOW_STATUS_KEY,
        input.source === "box"
          ? localTimeBoxStatusText(input.remainingMinutes)
          : attentionWindowStatusText(input.remainingMinutes),
      );
    }

    if (attentionWindowDedupe.get(input.runKey) === input.fingerprint) return;
    if (!ctx.hasUI || !shouldNotifyAttentionWindow(ctx)) return;

    ctx.ui.notify(
      input.source === "box"
        ? "[HeadsDown] Box deadline closing. Wrap cleanly, or clear the box with /headsdown box clear. Doing nothing keeps the agent running with tighter wrap-up hints, the deadline does not force a stop."
        : "[HeadsDown] Window closing. Extend with /headsdown extend [15m] or Wrap with /headsdown wrap. Doing nothing keeps the agent running with tighter wrap-up hints, the deadline does not force a stop.",
      "warning",
    );
    attentionWindowDedupe.set(input.runKey, input.fingerprint);
  }

  function buildAutopilotGuidanceContextMessage(autopilotGuidance: string) {
    return {
      role: "custom" as const,
      customType: "headsdown-autopilot-guidance",
      content: `[HeadsDown] ${autopilotGuidance}`,
      display: false,
      timestamp: Date.now(),
    };
  }

  async function pollAttentionWindowWarning(
    ctx: ExtensionContext,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const now = Date.now();
    updateTimeBoxUI(ctx);

    const localOnlyEffective = resolveEffectiveDeadline(activeTimeBox, null, now);
    const localOnlyWarningActive =
      localOnlyEffective.source === "box" &&
      localOnlyEffective.remainingMinutes <= DEFAULT_ATTENTION_WINDOW_THRESHOLD_MINUTES;
    const activeProposal = getLatestApprovedProposal();

    if (!activeProposal) {
      if (localOnlyWarningActive) {
        deliverAttentionWindowWarning(ctx, {
          source: "box",
          remainingMinutes: localOnlyEffective.remainingMinutes,
          runKey: "local-time-box",
          fingerprint: `${localOnlyEffective.effectiveDeadlineAt}:${DEFAULT_ATTENTION_WINDOW_THRESHOLD_MINUTES}`,
        });
        return;
      }

      clearAttentionWindowWarning(ctx);
      return;
    }

    if (!options.force && now - lastAttentionWindowPollAt < ATTENTION_WINDOW_POLL_COOLDOWN_MS) {
      return;
    }

    const client = await getClient();
    if (!client) {
      if (localOnlyWarningActive) {
        deliverAttentionWindowWarning(ctx, {
          source: "box",
          remainingMinutes: localOnlyEffective.remainingMinutes,
          runKey: runIdForProposal(activeProposal.id),
          fingerprint: `${localOnlyEffective.effectiveDeadlineAt}:${DEFAULT_ATTENTION_WINDOW_THRESHOLD_MINUTES}`,
        });
      }
      return;
    }

    try {
      const actorClient = withActorContext(client, ctx);
      const overview = await getAgentControlOverviewCompat(actorClient);
      lastAttentionWindowPollAt = now;

      const refreshedAvailability = await refreshAvailability(ctx, { force: true });
      const guidance = refreshedAvailability?.schedule?.wrapUpGuidance;
      const backendDeadlineAt = activeWrapUpDeadlineAt(guidance);
      updateTimeBoxUI(ctx, backendDeadlineAt);
      const resolution = resolveAttentionWindowRun({
        activeProposalId: activeProposal.id,
        overview,
      });
      const effective = resolveEffectiveDeadline(activeTimeBox, backendDeadlineAt, now);
      const thresholdMinutes =
        guidance?.thresholdMinutes ?? DEFAULT_ATTENTION_WINDOW_THRESHOLD_MINUTES;
      const backendWarningActive =
        guidance?.active === true &&
        resolution.runId !== null &&
        resolution.runSummary?.callKey === "attention_window_closing";
      const localWarningActive =
        effective.source === "box" && effective.remainingMinutes <= thresholdMinutes;
      const warningActive = backendWarningActive || localWarningActive;
      const runKey = resolution.runId ?? runIdForProposal(activeProposal.id);

      if (!warningActive) {
        clearAttentionWindowWarning(ctx, runKey);
        return;
      }

      const warningSource: "box" | "backend" = localWarningActive ? "box" : "backend";
      const displayRemainingMinutes =
        warningSource === "backend" && typeof guidance?.remainingMinutes === "number"
          ? guidance.remainingMinutes
          : effective.source === "none"
            ? null
            : effective.remainingMinutes;
      const fingerprintDeadline =
        effective.source === "none"
          ? `backend:${runKey}:${displayRemainingMinutes ?? "soon"}`
          : effective.effectiveDeadlineAt;

      deliverAttentionWindowWarning(ctx, {
        source: warningSource,
        remainingMinutes: displayRemainingMinutes,
        runKey,
        fingerprint: `${fingerprintDeadline}:${thresholdMinutes}`,
      });
    } catch (error) {
      if (
        ctx.hasUI &&
        (options.force === true ||
          now - lastAttentionWindowPollFailureNoticeAt >= ATTENTION_WINDOW_POLL_COOLDOWN_MS)
      ) {
        lastAttentionWindowPollFailureNoticeAt = now;
        ctx.ui.notify(
          `[HeadsDown] Warning checks are temporarily unavailable: ${sanitizeErrorMessage(error)}.`,
          "warning",
        );
      }
    }
  }

  async function maybeWarnScopeDrift(
    ctx: ExtensionContext,
    activeProposal: ProposalRecord,
    scope: ProposalScopeSnapshot,
  ) {
    if (typeof activeProposal.estimatedFiles !== "number" || activeProposal.estimatedFiles <= 0) {
      return;
    }

    const threshold = Math.ceil(activeProposal.estimatedFiles * SCOPE_WARNING_MULTIPLIER);
    if (scope.modifiedFiles.length <= threshold || scope.warningSent) {
      return;
    }

    scope.warningSent = true;
    scope.updatedAt = new Date().toISOString();
    persistScope(scope);

    const message =
      `[HeadsDown] Scope drift detected: ${scope.modifiedFiles.length} files touched for an approved estimate ` +
      `of ${activeProposal.estimatedFiles}. Re-submit headsdown_propose with updated estimates before continuing.`;

    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    }

    pi.sendMessage(
      {
        customType: "headsdown-scope-warning",
        content: message,
        display: false,
        details: {
          proposalId: activeProposal.id,
          estimatedFiles: activeProposal.estimatedFiles,
          modifiedFiles: scope.modifiedFiles.length,
        },
      },
      { deliverAs: "steer" },
    );

    const telemetry = getTelemetryForProposal(activeProposal);
    if (!telemetry.scopeDriftReported) {
      telemetry.scopeDriftReported = true;
      telemetry.sequence += 1;
      await reportPiAgentRunEvent(
        ctx,
        buildScopeDriftEventInput(telemetry, activeProposal.estimatedFiles),
      );
    }
  }

  // === Session events ===

  pi.on("session_start", async (event, ctx) => {
    const sessionStartReason = (event as { reason?: string }).reason;
    restoreProposalState(ctx);
    restoreTimeBoxState(ctx);
    cachedConfig = null;
    cachedClient = null;
    availabilitySnapshot = null;
    autoQueuedRunIds = new Set<string>();
    attentionWindowDedupe.clear();
    lastAttentionWindowPollAt = 0;
    lastAttentionWindowPollFailureNoticeAt = 0;
    clearAttentionWindowWarning(ctx);

    const refreshedAvailability = await refreshAvailability(ctx, { force: true });
    await updateStatusUI(ctx);
    updateTimeBoxUI(ctx, activeWrapUpDeadlineAt(refreshedAvailability?.schedule?.wrapUpGuidance));

    const digestCount = await checkPendingDigestCount(ctx);
    if (digestCount > 0 && ctx.hasUI) {
      const noun = digestCount === 1 ? "digest summary" : "digest summaries";
      ctx.ui.notify(
        `[HeadsDown] You have ${digestCount} pending ${noun}. Use headsdown_digest.`,
        "info",
      );
    }

    if (sessionStartReason === "resume" && (await continuationExists()) && ctx.hasUI) {
      ctx.ui.notify(
        "[HeadsDown] Continuation artifact found. Load it with headsdown_continuation.",
        "info",
      );
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreProposalState(ctx);
    restoreTimeBoxState(ctx);
    await updateStatusUI(ctx);
    updateTimeBoxUI(ctx, activeWrapUpDeadlineAt(availabilitySnapshot?.schedule?.wrapUpGuidance));
  });

  pi.on("session_before_switch", async (event, ctx) => {
    if (!hasApprovedProposal()) return undefined;

    appendContinuityEntry("before_switch", { switchReason: event.reason });
    await saveAutomaticContinuation("session-switch", ctx);

    if (ctx.hasUI) {
      ctx.ui.notify("[HeadsDown] Saved continuation snapshot before session switch.", "info");
    }

    return undefined;
  });

  pi.on("session_before_tree", async (event, _ctx) => {
    appendContinuityEntry("before_tree", {
      targetId: event.preparation.targetId,
      oldLeafId: event.preparation.oldLeafId,
      userWantsSummary: event.preparation.userWantsSummary,
    });
    return undefined;
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    const activeProposal = getLatestApprovedProposal();
    const scope = activeProposal ? getScopeSnapshot(activeProposal.id) : null;

    appendContinuityEntry("before_compact", {
      tokensBefore: event.preparation.tokensBefore,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      messagesToSummarize: event.preparation.messagesToSummarize.length,
    });

    const compaction = buildHeadsDownCompaction({
      availabilitySummary: availabilitySnapshot?.summary ?? null,
      wrapUpInstruction: availabilitySnapshot?.wrapUpInstruction ?? null,
      timeBox: refreshActiveTimeBox(),
      proposal: activeProposal,
      scope,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    });

    if (!compaction) {
      return undefined;
    }

    return { compaction };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const shutdownReason = (event as { reason?: string }).reason;
    appendContinuityEntry("shutdown", { shutdownReason });
    await saveAutomaticContinuation("session-shutdown", ctx);

    const latest = getLatestApprovedProposal();
    if (!latest || latest.reportedAt) return;

    if (ctx.hasUI) {
      ctx.ui.notify(
        "[HeadsDown] Approved proposal has no reported outcome yet. Consider calling headsdown_report.",
        "warning",
      );
    }
  });

  // Inject availability and HeadsDown call context into the turn system prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    await refreshAvailability(ctx);
    await updateStatusUI(ctx);
    await applyAutoThinkingForTurn(ctx, event.prompt);

    const activeProposal = getLatestApprovedProposal();
    if (activeProposal) {
      await reportStartedIfNeeded(ctx, activeProposal);
    }

    const instructionBlocks: string[] = [];
    const timeBoxResult = advanceTimeBoxForPrompt(activeTimeBox);
    if (timeBoxResult.state !== activeTimeBox) {
      activeTimeBox = timeBoxResult.state;
      persistTimeBox();
    } else {
      activeTimeBox = timeBoxResult.state;
    }
    updateTimeBoxUI(ctx, activeWrapUpDeadlineAt(availabilitySnapshot?.schedule?.wrapUpGuidance));
    if (timeBoxResult.instruction) {
      instructionBlocks.push(timeBoxResult.instruction);
    }

    const policyInstruction = policyInstructionForPrompt();
    if (policyInstruction) {
      instructionBlocks.push(policyInstruction);
    }

    const wrapUpHintInstruction = buildEffectiveWrapUpInstruction(
      availabilitySnapshot?.schedule?.wrapUpGuidance,
    );
    if (
      wrapUpHintInstruction &&
      (!availabilitySnapshot?.wrapUpInstruction ||
        availabilitySnapshot.wrapUpInstruction !== wrapUpHintInstruction)
    ) {
      instructionBlocks.push(`[HeadsDown] Wrap-Up hints: ${wrapUpHintInstruction}`);
    }

    const client = await getClient();
    if (client) {
      try {
        const actorClient = withActorContext(client, ctx);
        const overview = await getAgentControlOverviewCompat(actorClient);
        if (overview?.headsdownCall) {
          const renderedCallCopy = renderHeadsDownCallCopy({
            key: overview.headsdownCall.key,
            title: overview.headsdownCall.title,
            body: overview.headsdownCall.body,
          });
          if (renderedCallCopy) {
            const activeProposalRunIds = activeProposal
              ? [
                  getTelemetryForProposal(activeProposal).runId,
                  activeProposal.id,
                  runIdForProposal(activeProposal.id),
                ]
              : [];
            const renderedCall = filterRenderedCallActions(
              renderedCallCopy,
              allowedActionKeysForCallPrompt(overview, renderedCallCopy.key, activeProposalRunIds),
            );
            instructionBlocks.push(formatHeadsDownCallForPrompt(renderedCall));

            if (renderedCall.key === "off_the_clock") {
              const queueTarget = pickQueueForMorningRun(overview.runSummaries);
              if (queueTarget) {
                if (shouldAutoQueueForMorning(queueTarget, autoQueuedRunIds)) {
                  const queueResult = await queueForMorningWithHandoff({
                    actorClient,
                    runSummary: queueTarget,
                    branch: await currentBranchName(),
                    saveContinuation: saveContinuationArtifact,
                  });

                  instructionBlocks.push(`[HeadsDown] ${queueResult.message}`);
                  if (queueResult.queued) {
                    autoQueuedRunIds.add(queueTarget.runId);
                  }
                  if (ctx.hasUI) {
                    ctx.ui.notify(`[HeadsDown] ${queueResult.message}`, "info");
                  }
                } else {
                  instructionBlocks.push(
                    "[HeadsDown] Off the clock. Keep queued. Ready to resume guidance is active when work windows reopen.",
                  );
                }
              }
            }

            if (renderedCall.key === "ready_to_resume") {
              const resumeInstruction =
                renderedCall.primaryActionKey === "resume_run"
                  ? "[HeadsDown] Ready to resume. Load saved context with headsdown_continuation action=load before continuing."
                  : "[HeadsDown] Ready to resume state is visible, but the backend has not allowed a resume action yet. Re-check before continuing.";
              instructionBlocks.push(resumeInstruction);
            }
          }
        }
      } catch (error) {
        if (ctx.hasUI) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`[HeadsDown] Unable to load agent-control call: ${message}`, "warning");
        }
      }
    }

    if (instructionBlocks.length === 0) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructionBlocks.join("\n\n")}`,
    };
  });

  pi.on("context", async (event, ctx) => {
    const snapshotBeforeRefresh = availabilitySnapshot;
    const refreshedSnapshot = await refreshAvailability(ctx, { force: true });
    const staleAfterRefresh =
      snapshotBeforeRefresh !== null && refreshedSnapshot === snapshotBeforeRefresh;
    if (staleAfterRefresh) {
      return undefined;
    }

    const wrapUpHintInstruction = buildEffectiveWrapUpInstruction(
      refreshedSnapshot?.schedule?.wrapUpGuidance,
    );
    const autopilotGuidance = formatAutopilotGuidance({
      mode: refreshedSnapshot?.contract?.mode ?? null,
      hasActiveProposal: hasApprovedProposal(),
    });
    if (!wrapUpHintInstruction && !autopilotGuidance) return undefined;

    const messages = [...event.messages];
    if (wrapUpHintInstruction) {
      messages.push(buildWrapUpGuidanceContextMessage(wrapUpHintInstruction));
    }
    if (autopilotGuidance) {
      messages.push(buildAutopilotGuidanceContextMessage(autopilotGuidance));
    }

    return { messages };
  });

  pi.on("message_end", async (event, ctx) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role !== "assistant") return undefined;

    const config = await loadConfig();

    const snapshot = await refreshAvailability(ctx, { force: true, requireFresh: true });
    const detection = shouldRecordAutopilotDeferral({
      message,
      mode: snapshot?.contract?.mode,
      config: config.autopilotDeferral,
    });
    if (!detection.matched) return undefined;

    const proposal = getLatestApprovedProposal();
    if (!proposal) return undefined;

    const telemetry = getTelemetryForProposal(proposal);
    telemetry.deferredDecisionsCount += 1;
    telemetry.sequence += 1;

    const localSessionSummary = buildLocalSessionSummary({
      runId: telemetry.runId,
      approvedProposalId: proposal.id,
      toolCallCount: telemetry.toolCallsCount,
      fileChangeCount: telemetry.filesModified.size,
      deferredDecisionCount: telemetry.deferredDecisionsCount,
      continuationArtifactAvailable: await continuationExists(),
      validationLocallyPassed: false,
      now: new Date(),
    });

    await reportPiAgentRunEvent(
      ctx,
      buildDeferredDecisionEventInput({
        telemetry,
        proposal,
        decisionKind: pickDecisionKind(),
        decisionCategory: pickDecisionCategory(),
        urgencyBucket: pickUrgencyBucket(config.autopilotDeferral),
        flaggedForReview: true,
        localSessionSummary,
      }),
    );

    return undefined;
  });

  // === Tool call interception ===

  pi.on("tool_call", async (event, ctx) => {
    const activeProposal = getLatestApprovedProposal();
    if (activeProposal) {
      const telemetry = getTelemetryForProposal(activeProposal);
      telemetry.toolCallsCount += 1;
      if (event.toolName === "read") {
        telemetry.toolReadCount += 1;
        const readPath = normalizeToolPath((event.input as { path?: string }).path);
        if (readPath) telemetry.filesRead.add(readPath);
      } else if (event.toolName === "write" || event.toolName === "edit") {
        telemetry.toolWriteCount += 1;
      } else if (event.toolName === "bash") {
        telemetry.toolExternalCount += 1;
      }
    }

    await pollAttentionWindowWarning(ctx);

    let mutating = false;
    let filePath = "";
    let command = "";

    if (event.toolName === "write" || event.toolName === "edit") {
      filePath = normalizeToolPath((event.input as { path?: string }).path);
      mutating = true;
    } else if (event.toolName === "bash") {
      command = (event.input as { command?: string }).command ?? "";
      mutating = isPotentiallyMutatingBashCommand(command);
    }

    if (!mutating) {
      return undefined;
    }

    const config = await loadConfig();

    if (filePath && isSensitivePath(filePath, config.sensitivePaths) && ctx.hasUI) {
      ctx.ui.notify(`[HeadsDown] Sensitive file: ${filePath}. Requires extra care.`, "warning");
    }

    const snapshot = await refreshAvailability(ctx, { force: true });
    if (!snapshot) return undefined;

    const mode = snapshot.contract?.mode ?? "none";
    const locked = snapshot.contract?.lock === true;
    const decision = applyTrustPolicy(config.trustLevel, mode, locked, hasApprovedProposal());

    if (decision && event.toolName === "bash") {
      return {
        block: true,
        reason: `${decision.reason} Mutating bash command blocked: ${command}`,
      };
    }

    if (!decision && config.trustLevel === "advisory" && ctx.hasUI) {
      if (locked) {
        ctx.ui.notify(
          "[HeadsDown] User status is locked. Confirm before mutating files.",
          "warning",
        );
      } else if (mode === "offline") {
        ctx.ui.notify("[HeadsDown] User is offline. Consider deferring mutating work.", "warning");
      }
    }

    return decision;
  });

  // Track realized scope from successful tool results.
  pi.on("tool_result", async (event, ctx) => {
    const activeProposalForTelemetry = getLatestApprovedProposal();
    if (activeProposalForTelemetry) {
      const telemetry = getTelemetryForProposal(activeProposalForTelemetry);
      if (event.isError) {
        telemetry.failureCount += 1;
      }
    }

    await pollAttentionWindowWarning(ctx);

    if (event.isError) return undefined;

    if (event.toolName === "bash") {
      const activeProposal = getLatestApprovedProposal();
      const command = (event.input as { command?: string }).command ?? "";
      const progressState = progressStateForBashCommand(command);

      if (activeProposal && progressState) {
        const telemetry = getTelemetryForProposal(activeProposal);
        telemetry.progressState = progressState;
        await reportProgress(ctx, activeProposal);
      }
    }

    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    const activeProposal = getLatestApprovedProposal();
    if (!activeProposal) return undefined;

    const path = normalizeToolPath((event.input as { path?: string }).path);
    if (!path) return undefined;

    const scope = getScopeSnapshot(activeProposal.id);
    if (!scope.modifiedFiles.includes(path)) {
      scope.modifiedFiles = [...scope.modifiedFiles, path];
    }
    scope.updatedAt = new Date().toISOString();

    persistScope(scope);
    await updateStatusUI(ctx);
    const telemetry = getTelemetryForProposal(activeProposal);
    telemetry.filesModified.add(path);

    await maybeWarnScopeDrift(ctx, activeProposal, scope);
    await reportProgress(ctx, activeProposal);

    return undefined;
  });

  // === Custom tools ===

  pi.registerTool({
    name: "headsdown_referee",
    label: "HeadsDown Local Referee",
    description:
      "Verify the current run locally from a repo-local completion contract. Runs without HeadsDown credentials or required network calls.",
    promptSnippet: "Run local HeadsDown Referee verification without requiring an account",
    parameters: Type.Object({
      contract_path: Type.Optional(
        Type.String({
          description:
            "Optional path to the local Referee JSON contract. Defaults to .headsdown/referee.json.",
        }),
      ),
      share_outcome: Type.Optional(
        StringEnum(["preview", "share_once", "always_share", "keep_local"] as const, {
          description:
            "Optional outcome sharing action. Use preview to show the summary, share_once to share this run, always_share to persist workspace preference, or keep_local to disable persistent sharing.",
        }),
      ),
      confirm_share_preview: Type.Optional(
        Type.Boolean({
          description:
            "Confirm that you reviewed the preview and privacy boundary before sharing or persisting always_share.",
        }),
      ),
      share_preview_token: Type.Optional(
        Type.String({
          description:
            "Preview token from a prior headsdown_referee call. Required with confirm_share_preview=true before sharing occurs.",
        }),
      ),
      evidence: Type.Optional(
        Type.Object({
          files_touched: Type.Optional(
            Type.Number({ description: "Local count of touched files." }),
          ),
          tool_calls: Type.Optional(Type.Number({ description: "Local count of tool calls." })),
          validation_status: Type.Optional(
            StringEnum(["passed", "failed", "unknown"] as const, {
              description: "Local validation status for this run.",
            }),
          ),
          tests_run: Type.Optional(
            Type.Boolean({ description: "Whether tests or validation ran locally." }),
          ),
          network_required: Type.Optional(
            Type.Boolean({ description: "Whether the local run required network access." }),
          ),
          elapsed_minutes: Type.Optional(
            Type.Number({ description: "Elapsed local run time in minutes." }),
          ),
          outcome: Type.Optional(
            StringEnum(["completed", "partially_completed", "blocked", "unknown"] as const, {
              description: "Local run outcome category.",
            }),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params: LocalRefereeToolParams, _signal, _onUpdate, ctx) {
      const result = await runLocalReferee({
        cwd: ctx.cwd,
        contractPath: params.contract_path,
        evidence: {
          filesTouched: params.evidence?.files_touched,
          toolCalls: params.evidence?.tool_calls,
          validationStatus: params.evidence?.validation_status,
          testsRun: params.evidence?.tests_run,
          networkRequired: params.evidence?.network_required,
          elapsedMinutes: params.evidence?.elapsed_minutes,
          outcome: params.evidence?.outcome,
        },
      });

      const config = await loadConfig();
      const workspaceRef = toOpaqueWorkspaceRef(ctx.cwd);
      const currentPreference = workspaceOutcomeSharingPreference(config, workspaceRef);
      const outcomePayload = buildLocalRefereeOutcomeSummaryPayload({
        receipt: result.receipt,
        clientVersion: HEADSDOWN_PI_CLIENT_VERSION,
        executionMode: "local_only",
      });
      const previewText = renderLocalRefereeOutcomeSharePreview(outcomePayload);
      const highSignalSummary = isHighSignalOutcomeSummary(result);
      const payloadHash = createHash("sha256").update(JSON.stringify(outcomePayload)).digest("hex");
      const requestedChoice = params.share_outcome;
      const shouldShare = shouldShareLocalRefereeOutcomeSummary({
        choice: requestedChoice,
        config: { preference: currentPreference },
      });
      const shouldShowSharePreview =
        highSignalSummary || requestedChoice !== undefined || currentPreference === "always_share";
      const requiresPreviewConfirmation =
        requestedChoice === "share_once" || requestedChoice === "always_share";
      const hasPreviewConfirmation = params.confirm_share_preview === true;
      const hasValidPreviewToken =
        requiresPreviewConfirmation && hasPreviewConfirmation
          ? consumeOutcomeSharePreviewToken(params.share_preview_token, workspaceRef, payloadHash)
          : false;
      const previewToken =
        shouldShowSharePreview && !hasValidPreviewToken
          ? issueOutcomeSharePreviewToken(workspaceRef, payloadHash)
          : null;

      let persistedPreference = currentPreference;
      let shareResult: { shared: boolean; reason: string } = {
        shared: false,
        reason: "kept_local",
      };

      if (requestedChoice === "keep_local" && currentPreference !== "local_only") {
        await updateLocalRefereeOutcomeSharingPreference(ctx, "local_only");
        persistedPreference = "local_only";
      }

      if (shouldShare) {
        if (requiresPreviewConfirmation && !hasPreviewConfirmation) {
          shareResult = { shared: false, reason: "preview_confirmation_required" };
        } else if (requiresPreviewConfirmation && !hasValidPreviewToken) {
          shareResult = { shared: false, reason: "preview_token_required" };
        } else {
          shareResult = await shareLocalRefereeOutcomeSummary(outcomePayload);
          if (shareResult.shared && requestedChoice === "always_share") {
            await updateLocalRefereeOutcomeSharingPreference(ctx, "always_share");
            persistedPreference = "always_share";
          }
        }
      }

      const lines = [result.renderedReceipt];

      if (shouldShowSharePreview) {
        lines.push("");
        lines.push(previewText);
        if (previewToken) {
          lines.push("");
          lines.push(`Preview token: ${previewToken}`);
        }
      }

      lines.push("");
      lines.push(`Workspace sharing preference: ${persistedPreference}.`);

      if (shareResult.shared) {
        lines.push("Outcome summary shared successfully.");
      } else if (shareResult.reason === "preview_confirmation_required") {
        lines.push(
          "Preview confirmation required. Re-run with share_outcome and confirm_share_preview=true after reviewing the summary above.",
        );
      } else if (shareResult.reason === "preview_token_required") {
        lines.push(
          "Preview token required. Re-run with share_outcome, confirm_share_preview=true, and share_preview_token from a previous preview call.",
        );
      } else if (shareResult.reason === "not_authenticated") {
        lines.push("Sharing unavailable: not signed in. Run stays local.");
      } else if (shareResult.reason === "hosted_sync_unavailable") {
        lines.push("Sharing unavailable: hosted sync endpoint is not available. Run stays local.");
      } else if (shareResult.reason === "submit_failed") {
        lines.push("Sharing unavailable: hosted submission failed. Run stays local.");
      } else if (highSignalSummary && requestedChoice === undefined) {
        lines.push(
          "To share this run summary, first run headsdown_referee to get a preview token, then re-run with share_outcome=share_once (or always_share), confirm_share_preview=true, and share_preview_token.",
        );
      } else {
        lines.push("Run summary kept local.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          receipt: result.receipt,
          evaluation: result.evaluation,
          outcomeSharing: {
            suggested: highSignalSummary,
            choice: requestedChoice ?? null,
            shared: shareResult.shared,
            reason: shareResult.reason,
            preference: persistedPreference,
            privacyBoundaryVersion: LOCAL_REFEREE_OUTCOME_PRIVACY_BOUNDARY_VERSION,
            payloadSchemaVersion: 1,
            preview: previewText,
            previewToken,
            payload: outcomePayload,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_status",
    label: "HeadsDown Status",
    description:
      "Check the user's current availability on HeadsDown. Returns their focus mode " +
      "(online/busy/limited/offline), status message, time remaining, and work schedule.",
    promptSnippet: "Check user's HeadsDown availability before starting significant tasks",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);
      const availability = await getAvailabilityContext(actorClient);
      const summary = formatSummary(
        availability.contract,
        availability.calendar ?? availability.schedule,
      );
      const wrapUpInstruction = resolveExecutionInstruction({
        contract: availability.contract,
        schedule: availability.schedule,
      });

      availabilitySnapshot = {
        contract: availability.contract,
        calendar: availability.calendar,
        schedule: availability.schedule,
        summary,
        wrapUpInstruction,
        fetchedAt: Date.now(),
      };

      const activeProposal = getLatestApprovedProposal();
      const proposalScope = activeProposal ? getScopeSnapshot(activeProposal.id) : null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                contract: availability.contract,
                calendar: availability.calendar,
                schedule: availability.schedule,
                summary,
                wrapUpInstruction,
                activeProposal,
                proposalScope,
              },
              null,
              2,
            ),
          },
        ],
        details: {
          contract: availability.contract,
          calendar: availability.calendar,
          schedule: availability.schedule,
          activeProposal,
          proposalScope,
        },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_presets",
    label: "HeadsDown Presets",
    description:
      "List your saved HeadsDown presets or apply one to set your current mode. " +
      "Only apply a preset when the user explicitly asks to change availability.",
    promptSnippet: "List or apply availability presets when user asks to change mode",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["list", "apply"] as const, {
          description: "Use 'list' to view presets (default), or 'apply' to activate one.",
        }),
      ),
      id: Type.Optional(Type.String({ description: "Preset ID to apply." })),
      name: Type.Optional(
        Type.String({
          description: "Preset name to apply (case-insensitive exact match).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);
      const action = params.action ?? "list";
      const presets = await actorClient.listPresets();

      if (action === "list") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  presets: presets.map((preset) => ({
                    id: preset.id,
                    name: preset.name,
                    statusText: preset.statusText,
                    statusEmoji: preset.statusEmoji,
                    duration: preset.duration,
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: { presets },
        };
      }

      let selected = presets.find((preset) => params.id && preset.id === params.id) ?? null;

      if (!selected && params.name) {
        const byName = presets.filter(
          (preset) => preset.name.trim().toLowerCase() === params.name!.trim().toLowerCase(),
        );
        if (byName.length > 1) {
          throw new Error(
            `Multiple presets match name '${params.name}'. Please apply by preset id instead.`,
          );
        }
        selected = byName[0] ?? null;
      }

      if (!selected) {
        throw new Error(
          "Preset not found. Provide a valid 'id' or exact preset 'name'. Run with action='list' to view options.",
        );
      }

      const contract = await actorClient.applyPreset(selected.id);
      const availability = await getAvailabilityContext(actorClient);
      const summary = formatSummary(contract, availability.calendar ?? availability.schedule);

      availabilitySnapshot = {
        contract,
        calendar: availability.calendar,
        schedule: availability.schedule,
        summary,
        wrapUpInstruction: resolveExecutionInstruction({
          contract,
          schedule: availability.schedule,
        }),
        fetchedAt: Date.now(),
      };

      await updateStatusUI(_ctx);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                appliedPreset: { id: selected.id, name: selected.name },
                contract,
                calendar: availability.calendar,
                schedule: availability.schedule,
                summary,
              },
              null,
              2,
            ),
          },
        ],
        details: {
          appliedPreset: selected,
          contract,
          calendar: availability.calendar,
          schedule: availability.schedule,
        },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_propose",
    label: "HeadsDown Propose",
    description:
      "Submit a task proposal to HeadsDown for a verdict before starting work. " +
      "Returns APPROVED (proceed) or DEFERRED (postpone or reduce scope).",
    promptSnippet: "Submit task proposals to HeadsDown before non-trivial work",
    parameters: Type.Object({
      description: Type.String({
        description: "What you plan to do. Be specific: 'Refactor auth module' not 'make changes'.",
      }),
      estimated_files: Type.Optional(
        Type.Number({ description: "Estimated number of files to modify." }),
      ),
      estimated_minutes: Type.Optional(Type.Number({ description: "Estimated time in minutes." })),
      scope_summary: Type.Optional(Type.String({ description: "Brief scope summary." })),
      source_ref: Type.Optional(
        Type.String({ description: "Task source: ticket number, PR URL, etc." }),
      ),
      idempotency_key: Type.Optional(
        Type.String({
          description:
            "Optional idempotency key for retry safety. If omitted, pi derives a key from this tool call id.",
        }),
      ),
      delivery_mode: Type.Optional(
        StringEnum(["auto", "wrap_up", "full_depth"] as const, {
          description: "Optional Wrap-Up delivery mode override for this task.",
        }),
      ),
    }),
    async execute(_toolCallId, params: ProposeToolParams, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);

      const input = buildProposalInput(params, _toolCallId);
      const idempotencyKey = (input as ProposalInput & { idempotencyKey?: string }).idempotencyKey;
      const verdict = await submitProposalCompat(
        actorClient,
        input,
        idempotencyKey ?? deriveProposalIdempotencyKey(params),
      );

      const proposalRecord: ProposalRecord = {
        id: verdict.proposalId,
        decision: verdict.decision,
        description: params.description,
        evaluatedAt: verdict.evaluatedAt,
        estimatedFiles: params.estimated_files,
        estimatedMinutes: params.estimated_minutes,
        scopeSummary: params.scope_summary,
        sourceRef: params.source_ref,
      };

      approvedProposals = [...approvedProposals, proposalRecord];
      persistProposals();

      if (verdict.decision === "approved") {
        lastApprovedProposalId = verdict.proposalId;

        const scope: ProposalScopeSnapshot = {
          proposalId: verdict.proposalId,
          modifiedFiles: [],
          warningSent: false,
          updatedAt: new Date().toISOString(),
        };
        proposalScopes.set(verdict.proposalId, scope);
        persistScope(scope);
        await reportStartedIfNeeded(_ctx, proposalRecord);
      } else {
        const snapshot = await refreshAvailability(_ctx, { force: true });
        const nextWindowStartsAt = snapshot?.schedule?.nextTransitionAt ?? null;
        if (nextWindowStartsAt) {
          await reportPiAgentRunEvent(
            _ctx,
            buildQueuedForMorningEventInput(proposalRecord, nextWindowStartsAt),
          );
        }
      }

      await updateStatusUI(_ctx);

      const guidance =
        verdict.decision === "approved"
          ? "The task was approved. Proceed with the work as described."
          : "The task was deferred. Inform the user and suggest postponing or reducing scope.";
      const wrapUpInstruction = resolveExecutionInstruction({
        verdict: {
          decision: verdict.decision,
          reason: verdict.reason,
          wrapUpGuidance: verdict.wrapUpGuidance,
        },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                decision: verdict.decision,
                reason: verdict.reason,
                guidance,
                proposalId: verdict.proposalId,
                evaluatedAt: verdict.evaluatedAt,
                wrapUpGuidance: verdict.wrapUpGuidance,
                wrapUpInstruction,
              },
              null,
              2,
            ),
          },
        ],
        details: { verdict },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_digest",
    label: "HeadsDown Digest",
    description:
      "View notifications and messages that arrived during focus time. Returns grouped summaries by source and actor.",
    promptSnippet: "Review digest summaries of what arrived during focus windows",
    parameters: Type.Object({
      latest: Type.Optional(
        Type.Number({ description: "Limit to N most recent summaries (default: 20)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);
      const latest = typeof params.latest === "number" ? params.latest : 20;
      const summaries = await actorClient.listDigestSummaries({ latest });

      if (summaries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summaries: [],
                  message: "No digest entries. Nothing arrived during your focus windows.",
                },
                null,
                2,
              ),
            },
          ],
          details: { summaries: [] },
        };
      }

      const formatted = summaries.map((summary) => ({
        id: summary.id,
        source: summary.sourceType,
        actor: summary.actorLabel,
        action: summary.action,
        channel: summary.channelRef,
        entryCount: summary.entryCount,
        firstEventAt: summary.firstEventAt,
        lastEventAt: summary.lastEventAt,
        events: summary.events.map((event) => ({
          description: event.description,
          insertedAt: event.insertedAt,
        })),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                summaries: formatted,
                total: formatted.length,
                message: `Found ${formatted.length} digest ${formatted.length === 1 ? "summary" : "summaries"}.`,
              },
              null,
              2,
            ),
          },
        ],
        details: { summaries: formatted },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_grants",
    label: "HeadsDown Delegation Grants",
    description:
      "Manage delegation grants for actor-scoped authorization. Supports listing, creating, and revoking grants.",
    promptSnippet: "Manage HeadsDown delegation grants for the current workspace/session context",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["list", "list_active", "create", "revoke", "revoke_many"] as const, {
          description:
            "Action to run: list/list_active/create/revoke/revoke_many (default: list_active).",
        }),
      ),
      id: Type.Optional(Type.String({ description: "Delegation grant id (for revoke)." })),
      scope: Type.Optional(
        StringEnum(["session", "workspace", "agent"] as const, {
          description: "Grant scope for create/filter operations.",
        }),
      ),
      session_id: Type.Optional(Type.String({ description: "Session id for session scope." })),
      workspace_ref: Type.Optional(
        Type.String({ description: "Workspace reference for workspace scope." }),
      ),
      agent_id: Type.Optional(Type.String({ description: "Agent id for agent scope." })),
      permissions: Type.Optional(
        Type.Array(
          StringEnum([
            "availability_override_create",
            "availability_override_cancel",
            "preset_apply",
          ] as const),
        ),
      ),
      duration_minutes: Type.Optional(
        Type.Number({ description: "Duration in minutes when creating a grant." }),
      ),
      expires_at: Type.Optional(Type.String({ description: "Absolute ISO expiry for create." })),
      source: Type.Optional(Type.String({ description: "Audit source label." })),
      active: Type.Optional(
        Type.Boolean({ description: "Filter active grants for list/revoke_many." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);
      const action = params.action ?? "list_active";

      try {
        if (action === "list_active") {
          const grants = await actorClient.listActiveDelegationGrants();
          return {
            content: [{ type: "text", text: JSON.stringify({ grants }, null, 2) }],
            details: { grants },
          };
        }

        if (action === "list") {
          const filter: DelegationGrantFilterInput = {
            active: params.active,
            scope: params.scope as DelegationGrantScope | undefined,
            sessionId: params.session_id,
            workspaceRef: params.workspace_ref,
            agentId: params.agent_id,
            source: params.source,
          };
          const hasFilter = Object.values(filter).some((value) => value !== undefined);
          const grants = await actorClient.listDelegationGrants(hasFilter ? filter : undefined);
          return {
            content: [{ type: "text", text: JSON.stringify({ grants }, null, 2) }],
            details: { grants },
          };
        }

        if (action === "create") {
          if (!params.scope) {
            throw new Error("scope is required when action='create'.");
          }
          if (!params.permissions || params.permissions.length === 0) {
            throw new Error("permissions is required when action='create'.");
          }

          const input: DelegationGrantInput = {
            scope: params.scope as DelegationGrantScope,
            sessionId: params.session_id,
            workspaceRef: params.workspace_ref,
            agentId: params.agent_id,
            permissions: params.permissions as DelegationGrantPermission[],
            durationMinutes: params.duration_minutes,
            expiresAt: params.expires_at,
            source: params.source ?? "pi",
          };

          const grant = await actorClient.createDelegationGrant(input);
          return {
            content: [{ type: "text", text: JSON.stringify({ grant }, null, 2) }],
            details: { grant },
          };
        }

        if (action === "revoke") {
          if (!params.id) {
            throw new Error("id is required when action='revoke'.");
          }

          const grant = await actorClient.revokeDelegationGrant(params.id);
          return {
            content: [{ type: "text", text: JSON.stringify({ grant }, null, 2) }],
            details: { grant },
          };
        }

        const filter: DelegationGrantFilterInput = {
          active: params.active,
          scope: params.scope as DelegationGrantScope | undefined,
          sessionId: params.session_id,
          workspaceRef: params.workspace_ref,
          agentId: params.agent_id,
          source: params.source,
        };
        const hasFilter = Object.values(filter).some((value) => value !== undefined);
        const result = await actorClient.revokeDelegationGrants(hasFilter ? filter : undefined);

        return {
          content: [{ type: "text", text: JSON.stringify({ result }, null, 2) }],
          details: { result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSessionTokenOnlyGrantError(message)) {
          throw new Error(
            "Delegation grant management requires a session-token auth path and is unavailable for API-key clients.",
          );
        }

        throw error;
      }
    },
  });

  pi.registerTool({
    name: "headsdown_override",
    label: "HeadsDown Availability Override",
    description:
      "Manage temporary availability overrides. Supports setting, viewing, and cancelling active overrides.",
    promptSnippet: "Manage temporary HeadsDown availability overrides",
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["get", "set", "clear"] as const, {
          description: "Action to run: get/set/clear (default: get).",
        }),
      ),
      id: Type.Optional(Type.String({ description: "Override id for clear (optional)." })),
      mode: Type.Optional(
        StringEnum(["online", "busy", "limited", "offline"] as const, {
          description: "Override mode for action='set'.",
        }),
      ),
      duration_minutes: Type.Optional(
        Type.Number({ description: "Duration in minutes for action='set'." }),
      ),
      expires_at: Type.Optional(
        Type.String({ description: "Absolute ISO expiry for action='set'." }),
      ),
      reason: Type.Optional(Type.String({ description: "Optional reason for set/clear." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);
      const action = params.action ?? "get";

      if (action === "get") {
        const override = await getActiveAvailabilityOverrideCompat(actorClient);
        return {
          content: [{ type: "text", text: JSON.stringify({ override }, null, 2) }],
          details: { override },
        };
      }

      if (action === "set") {
        if (!params.mode) {
          throw new Error("mode is required when action='set'.");
        }

        const override = await createAvailabilityOverrideCompat(actorClient, {
          mode: params.mode,
          durationMinutes: params.duration_minutes,
          expiresAt: params.expires_at,
          reason: params.reason,
          source: "pi",
        });

        await refreshAvailability(_ctx, { force: true });
        await updateStatusUI(_ctx);

        return {
          content: [{ type: "text", text: JSON.stringify({ override }, null, 2) }],
          details: { override },
        };
      }

      const targetId = params.id ?? (await getActiveAvailabilityOverrideCompat(actorClient))?.id;
      if (!targetId) {
        return {
          content: [{ type: "text", text: "No active availability override found to cancel." }],
          details: { override: null },
        };
      }

      const override = await cancelAvailabilityOverrideCompat(actorClient, targetId, params.reason);
      await refreshAvailability(_ctx, { force: true });
      await updateStatusUI(_ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ override }, null, 2) }],
        details: { override },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_continuation",
    label: "HeadsDown Continuation",
    description:
      "Save or load structured continuation artifacts for resumable sessions. Useful when pausing ongoing approved work.",
    promptSnippet: "Save or load HeadsDown continuation artifacts for resumable work sessions",
    parameters: Type.Object({
      action: StringEnum(["save", "load", "check", "clear"] as const, {
        description: "Save continuation data, load and consume it, check existence, or clear it.",
      }),
      branch: Type.Optional(Type.String({ description: "Current branch name for save." })),
      completed_steps: Type.Optional(
        Type.Array(Type.String(), { description: "Completed steps for save." }),
      ),
      pending_steps: Type.Optional(
        Type.Array(Type.String(), { description: "Pending steps for save." }),
      ),
      dirty_files: Type.Optional(
        Type.Array(Type.String(), { description: "Dirty files for save." }),
      ),
      open_decisions: Type.Optional(
        Type.Array(Type.String(), { description: "Open decisions for save." }),
      ),
      resume_instruction: Type.Optional(
        Type.String({ description: "First instruction for resuming work." }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Optional reason metadata for save/clear." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "check") {
        const exists = await continuationExists();
        return {
          content: [
            { type: "text", text: JSON.stringify({ exists, path: CONTINUATION_PATH }, null, 2) },
          ],
          details: { exists, path: CONTINUATION_PATH },
        };
      }

      if (params.action === "clear") {
        const cleared = await clearContinuationArtifact();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  cleared,
                  path: CONTINUATION_PATH,
                  reason: params.reason ?? null,
                },
                null,
                2,
              ),
            },
          ],
          details: { cleared, path: CONTINUATION_PATH },
        };
      }

      if (params.action === "load") {
        const loadResult = await loadContinuationArtifact(false);
        const artifact = loadResult.artifact;
        let consumed = false;
        let resumeAction: Record<string, unknown> = { attempted: false, reason: "no_artifact" };

        if (loadResult.error) {
          resumeAction = {
            attempted: false,
            reason: `artifact_${loadResult.error.reason}`,
            message: loadResult.error.message,
          };
        } else if (artifact) {
          const client = await getClient();
          const actorClient = client ? withActorContext(client, _ctx) : null;
          const resumeResult = await resumeContinuationArtifact({
            artifact,
            actorClient,
            loadOverview: getAgentControlOverviewResult,
            applyAction: applyHeadsDownActionCompat,
            clearContinuation: clearContinuationArtifact,
            reportResumed: async () => {
              const eventInput = buildResumedEventInput(artifact);
              if (eventInput) await reportPiAgentRunEvent(_ctx, eventInput);
            },
          });
          consumed = resumeResult.consumed;
          resumeAction = resumeResult.resumeAction;
        }

        const response = artifact
          ? {
              found: true,
              consumed,
              artifact,
              resumeAction,
              artifactError: loadResult.error,
              path: CONTINUATION_PATH,
            }
          : {
              found: false,
              consumed: false,
              resumeAction,
              artifactError: loadResult.error,
              path: CONTINUATION_PATH,
            };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: response,
        };
      }

      const activeProposal = getLatestApprovedProposal();
      const activeScope = activeProposal ? getScopeSnapshot(activeProposal.id) : null;

      const artifact: ContinuationArtifact = {
        branch: params.branch ?? (await currentBranchName()),
        runId: activeProposal ? getTelemetryForProposal(activeProposal).runId : null,
        approvedProposalId: activeProposal?.id ?? null,
        approvedProposalDescription: activeProposal?.description ?? null,
        estimatedFiles: activeProposal?.estimatedFiles ?? null,
        modifiedFiles: normalizeStringArray(params.dirty_files).length
          ? normalizeStringArray(params.dirty_files)
          : (activeScope?.modifiedFiles ?? []),
        openDecisions: normalizeStringArray(params.open_decisions),
        pendingSteps: normalizeStringArray(params.pending_steps),
        completedSteps: normalizeStringArray(params.completed_steps),
        resumeInstruction:
          params.resume_instruction ??
          (activeProposal
            ? `Resume approved proposal: ${activeProposal.description}`
            : "Resume by reviewing the previous session context."),
        wrapUpInstruction: availabilitySnapshot?.wrapUpInstruction ?? null,
        savedAt: new Date().toISOString(),
        reason: params.reason ?? "manual-save",
      };

      await saveContinuationArtifact(artifact);
      if (activeProposal) {
        const telemetry = getTelemetryForProposal(activeProposal);
        telemetry.sequence += 1;
        await reportPiAgentRunEvent(_ctx, buildContinuationSavedEventInput(telemetry, artifact));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                saved: true,
                path: CONTINUATION_PATH,
                artifact,
              },
              null,
              2,
            ),
          },
        ],
        details: { saved: true, path: CONTINUATION_PATH, artifact },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_report",
    label: "HeadsDown Report Outcome",
    description:
      "Report the outcome of a task that was approved via headsdown_propose. " +
      "Call this when you've finished or failed a task. Helps HeadsDown calibrate future verdicts for better accuracy.",
    promptSnippet: "Report task outcome to HeadsDown after completing work",
    parameters: Type.Object({
      outcome: StringEnum(
        ["completed", "failed", "partially_completed", "cancelled", "timed_out"] as const,
        { description: "What happened with the task." },
      ),
      error_category: Type.Optional(
        Type.String({
          description: "If failed: category like 'compilation_error', 'test_failure'.",
        }),
      ),
      tests_passed: Type.Optional(Type.Boolean({ description: "Whether the changes pass tests." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!lastApprovedProposalId) {
        return {
          content: [
            {
              type: "text",
              text: "No approved proposal found in this session. Submit a proposal via headsdown_propose first.",
            },
          ],
          details: {},
        };
      }

      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);
      const reportOutcomeMethod = (
        actorClient as unknown as {
          reportOutcome?: (input: Record<string, unknown>) => Promise<unknown>;
        }
      ).reportOutcome;
      if (typeof reportOutcomeMethod !== "function") {
        return {
          content: [
            {
              type: "text",
              text: "Outcome reporting is unavailable with the current installed @headsdown/sdk version.",
            },
          ],
          details: { proposalId: lastApprovedProposalId, outcome: params.outcome },
        };
      }

      const reportOutcome = reportOutcomeMethod.bind(actorClient) as (input: {
        proposalId: string;
        outcome: string;
        errorCategory?: string;
        testsPassed?: boolean;
      }) => Promise<unknown>;

      try {
        await reportOutcome({
          proposalId: lastApprovedProposalId,
          outcome: params.outcome,
          errorCategory: params.error_category,
          testsPassed: params.tests_passed,
        });

        const proposal = approvedProposals.find((entry) => entry.id === lastApprovedProposalId);
        if (proposal) {
          const telemetry = getTelemetryForProposal(proposal);
          telemetry.sequence += 1;
          if (!telemetry.completedReported) {
            await reportPiAgentRunEvent(
              _ctx,
              buildTerminalEventInput(
                telemetry,
                params.outcome,
                params.error_category,
                params.tests_passed,
              ),
            );
            telemetry.completedReported = true;
          }
          telemetry.sequence += 1;
          await reportPiAgentRunEvent(
            _ctx,
            buildSteeringOutcomeEventInput(
              telemetry,
              params.outcome,
              params.error_category,
              params.tests_passed,
            ),
          );
        }

        approvedProposals = approvedProposals.map((proposal) =>
          proposal.id === lastApprovedProposalId
            ? {
                ...proposal,
                reportedAt: new Date().toISOString(),
              }
            : proposal,
        );
        persistProposals();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  reported: true,
                  proposalId: lastApprovedProposalId,
                  outcome: params.outcome,
                  message: "Outcome recorded. This helps HeadsDown calibrate future verdicts.",
                },
                null,
                2,
              ),
            },
          ],
          details: { proposalId: lastApprovedProposalId, outcome: params.outcome },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to report outcome: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { proposalId: lastApprovedProposalId, outcome: params.outcome },
        };
      }
    },
  });

  pi.registerTool({
    name: "headsdown_auth",
    label: "HeadsDown Auth",
    description:
      "Authenticate with HeadsDown using Device Flow. Run this if other HeadsDown " +
      "tools report authentication errors.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const existing = await getClient();
      if (existing) {
        try {
          const profile = await existing.getProfile();
          return {
            content: [
              {
                type: "text",
                text: `Already authenticated as ${profile.name ?? profile.email}. API key is valid.`,
              },
            ],
            details: {},
          };
        } catch {
          cachedClient = null;
        }
      }

      const client = await HeadsDownClient.authenticate(
        (auth) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Open ${auth.verificationUriComplete} and approve access`, "info");
          }
        },
        { label: "Pi Agent Extension" },
      );

      cachedClient = client;
      const profile = await client.getProfile();

      return {
        content: [
          {
            type: "text",
            text: [
              "Authentication successful!",
              `Connected as: ${profile.name ?? profile.email}`,
              "Credentials saved to ~/.config/headsdown/credentials.json",
            ].join("\n"),
          },
        ],
        details: {},
      };
    },
  });

  // === /headsdown command ===

  async function runHeadsDownCommand(args: string | null | undefined, ctx: ExtensionContext) {
    const normalizedArgs = normalizeHeadsDownCommandArgs(args);

    if (normalizedArgs === "help") {
      ctx.ui.notify(buildHeadsDownCommandHelp(), "info");
      return;
    }

    if (normalizedArgs === "menu") {
      if (!ctx.hasUI) {
        ctx.ui.notify(buildHeadsDownCommandHelp(), "info");
        return;
      }

      const options = HEADSDOWN_COMMAND_OPTIONS.filter((option) => option.menu);
      const choices = options.map((option) => `${option.label}: /headsdown ${option.value}`);
      const selected = await ctx.ui.select("HeadsDown commands", choices);
      if (!selected) return;

      const selectedIndex = choices.indexOf(selected);
      const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
      if (selectedOption) await runHeadsDownCommand(selectedOption.value, ctx);
      return;
    }

    if (normalizedArgs === "referee") {
      const result = await runLocalReferee({ cwd: ctx.cwd });
      ctx.ui.notify(
        result.renderedReceipt,
        result.evaluation.verdict === "passed" ? "info" : "warning",
      );
      return;
    }

    if (normalizedArgs === "box" || normalizedArgs.startsWith("box ")) {
      const boxArgs = normalizedArgs.slice("box".length).trim();
      refreshActiveTimeBox();

      if (boxArgs === "" || boxArgs === "status") {
        ctx.ui.notify(
          formatTimeBoxStatus(
            activeTimeBox,
            Date.now(),
            activeWrapUpDeadlineAt(availabilitySnapshot?.schedule?.wrapUpGuidance),
          ),
          "info",
        );
        updateTimeBoxUI(
          ctx,
          activeWrapUpDeadlineAt(availabilitySnapshot?.schedule?.wrapUpGuidance),
        );
        return;
      }

      if (boxArgs === "clear") {
        activeTimeBox = null;
        const persisted = persistTimeBox();
        clearTimeBoxUI(ctx);
        clearAttentionWindowWarning(ctx);
        ctx.ui.notify("[HeadsDown] Time box cleared. No active time box.", "info");
        if (!persisted) {
          ctx.ui.notify(
            "[HeadsDown] Time box cleared for this session, but this Pi build could not persist the clear state.",
            "warning",
          );
        }
        return;
      }

      const durationMs = parseTimeBoxDuration(boxArgs);
      if (!durationMs) {
        ctx.ui.notify(
          "[HeadsDown] Invalid time box duration. Use forms like /headsdown box 15m, /headsdown box 1h, /headsdown box 90m, or /headsdown box 1h30m.",
          "warning",
        );
        return;
      }

      const replaced = activeTimeBox !== null;
      activeTimeBox = createTimeBox(durationMs);
      const persisted = persistTimeBox();
      attentionWindowDedupe.clear();
      updateTimeBoxUI(ctx, activeWrapUpDeadlineAt(availabilitySnapshot?.schedule?.wrapUpGuidance));
      ctx.ui.notify(formatTimeBoxConfirmation(activeTimeBox, replaced), "info");
      if (!persisted) {
        ctx.ui.notify(
          "[HeadsDown] Time box is active for this session, but this Pi build cannot persist it across resume.",
          "warning",
        );
      }
      return;
    }

    const requiresClient =
      normalizedArgs === "" ||
      normalizedArgs === "digest" ||
      normalizedArgs.startsWith("theme") ||
      normalizedArgs.startsWith("details") ||
      normalizedArgs.startsWith("extend") ||
      normalizedArgs === "wrap";

    if (!requiresClient) {
      ctx.ui.notify(
        "[HeadsDown] Unknown command. Use /headsdown help or /headsdown menu.",
        "warning",
      );
      return;
    }

    const client = await getClient();
    if (!client) {
      ctx.ui.notify("[HeadsDown] Not authenticated. Ask me to run headsdown_auth.", "warning");
      return;
    }

    if (normalizedArgs.startsWith("extend") || normalizedArgs === "wrap") {
      await pollAttentionWindowWarning(ctx, { force: true });
      const actorClient = withActorContext(client, ctx);
      const overviewResult = await getAgentControlOverviewResult(actorClient);
      if (!overviewResult.ok) {
        ctx.ui.notify(
          `[HeadsDown] Unable to verify warning actions: ${overviewResult.message}`,
          "warning",
        );
        return;
      }

      const activeProposal = getLatestApprovedProposal();
      const resolution = resolveAttentionWindowRun({
        activeProposalId: activeProposal?.id ?? null,
        overview: overviewResult.overview,
      });
      if (!resolution.runId || !resolution.runSummary) {
        if (resolution.reason === "overview_unavailable") {
          ctx.ui.notify(
            "[HeadsDown] Unable to verify warning actions with the current client/backend support. Re-check with /headsdown status.",
            "warning",
          );
          return;
        }

        if (resolution.reason === "ambiguous_attention_window_runs") {
          ctx.ui.notify(
            "[HeadsDown] Multiple window-closing runs are active. Re-check with /headsdown status before choosing Extend or Wrap.",
            "warning",
          );
          return;
        }

        ctx.ui.notify(
          "[HeadsDown] No active window-closing run found. Re-check with /headsdown status.",
          "warning",
        );
        return;
      }

      const candidateRunIds = [
        resolution.runId,
        activeProposal?.id ?? "",
        activeProposal?.id ? runIdForProposal(activeProposal.id) : "",
      ];

      if (normalizedArgs.startsWith("extend")) {
        const durationArg = normalizedArgs.slice("extend".length).trim();
        const durationMinutes = parseExtendDurationMinutes(durationArg);
        if (!durationMinutes) {
          ctx.ui.notify(
            "[HeadsDown] Invalid extend duration. Use /headsdown extend 15m, /headsdown extend 30m, or /headsdown extend 1h.",
            "warning",
          );
          return;
        }

        const allowedResolution = resolveAllowedRunAction({
          overview: overviewResult.overview,
          candidateRunIds,
          actionKey: "allow_for_duration",
          expectedCallKeys: ["attention_window_closing"],
        });
        if (!allowedResolution.allowed) {
          ctx.ui.notify(
            allowedRunActionFailureMessage("allow_for_duration", allowedResolution),
            "warning",
          );
          return;
        }

        const guidance = availabilitySnapshot?.schedule?.wrapUpGuidance;
        const idempotencyKey = `attention-window:${resolution.runId}:${guidance?.deadlineAt ?? "none"}:allow_for_duration:${durationMinutes}`;

        try {
          const result = await applyHeadsDownActionCompat(actorClient, {
            runId: resolution.runId,
            actionKey: "allow_for_duration",
            durationMinutes,
            idempotencyKey,
            source: "pi_extend_command",
            client: `headsdown-pi/${HEADSDOWN_PI_CLIENT_VERSION}`,
            reason: `Window closing warning acknowledged. Extend by ${durationMinutes} minutes.`,
          });

          if (!result.ok) {
            ctx.ui.notify(
              `[HeadsDown] Extend did not complete for run ${resolution.runId}. Please retry.`,
              "warning",
            );
            return;
          }
        } catch (error) {
          ctx.ui.notify(
            `[HeadsDown] Extend failed for run ${resolution.runId}: ${sanitizeErrorMessage(error)}`,
            "warning",
          );
          return;
        }

        clearAttentionWindowWarning(ctx, resolution.runId);
        await refreshAvailability(ctx, { force: true });
        await pollAttentionWindowWarning(ctx, { force: true });
        ctx.ui.notify(`[HeadsDown] Extend submitted for ${durationMinutes} minutes.`, "info");
        return;
      }

      const allowedResolution = resolveAllowedRunAction({
        overview: overviewResult.overview,
        candidateRunIds,
        actionKey: "pause_and_summarize",
        expectedCallKeys: ["attention_window_closing"],
      });
      if (!allowedResolution.allowed) {
        ctx.ui.notify(
          allowedRunActionFailureMessage("pause_and_summarize", allowedResolution),
          "warning",
        );
        return;
      }

      try {
        const result = await applyHeadsDownActionCompat(actorClient, {
          runId: resolution.runId,
          actionKey: "pause_and_summarize",
          source: "pi_wrap_command",
          client: `headsdown-pi/${HEADSDOWN_PI_CLIENT_VERSION}`,
          reason: "Window closing warning acknowledged. Pause and summarize.",
        });

        if (!result.ok) {
          ctx.ui.notify(
            `[HeadsDown] Wrap did not complete for run ${resolution.runId}. Please retry.`,
            "warning",
          );
          return;
        }
      } catch (error) {
        ctx.ui.notify(
          `[HeadsDown] Wrap failed for run ${resolution.runId}: ${sanitizeErrorMessage(error)}`,
          "warning",
        );
        return;
      }

      clearAttentionWindowWarning(ctx, resolution.runId);
      ctx.ui.notify("[HeadsDown] Wrap submitted. Saving handoff.", "info");
      return;
    }

    if (normalizedArgs === "digest") {
      const actorClient = withActorContext(client, ctx);
      const summaries = await actorClient.listDigestSummaries({ latest: 10 });
      const noun = summaries.length === 1 ? "summary" : "summaries";
      ctx.ui.notify(`[HeadsDown] ${summaries.length} digest ${noun} available.`, "info");
      return;
    }

    if (normalizedArgs.startsWith("theme")) {
      const [, themeArgRaw] = normalizedArgs.split(/\s+/, 2);
      const themeArg = themeArgRaw?.trim();

      if (!themeArg || themeArg === "list") {
        ctx.ui.notify(
          `[HeadsDown] Themes: neo, mono, executive. Current: ${activeUITheme}.`,
          "info",
        );
        return;
      }

      if (themeArg === "reset") {
        activeUITheme = defaultUITheme;
        await updateStatusUI(ctx);
        ctx.ui.notify(`[HeadsDown] Theme reset to ${activeUITheme}.`, "info");
        return;
      }

      const parsedTheme = normalizeUITheme(themeArg);
      if (!parsedTheme) {
        ctx.ui.notify(
          "[HeadsDown] Unknown theme. Use /headsdown theme <neo|mono|executive|list|reset>.",
          "warning",
        );
        return;
      }

      activeUITheme = parsedTheme;
      await updateStatusUI(ctx);
      ctx.ui.notify(`[HeadsDown] Theme set to ${activeUITheme}.`, "info");
      return;
    }

    if (normalizedArgs.startsWith("details")) {
      const [, detailsArgRaw] = normalizedArgs.split(/\s+/, 2);
      const detailsArg = detailsArgRaw?.trim();

      if (!detailsArg || detailsArg === "toggle") {
        detailsWidgetVisible = !detailsWidgetVisible;
      } else if (detailsArg === "on") {
        detailsWidgetVisible = true;
      } else if (detailsArg === "off") {
        detailsWidgetVisible = false;
      } else {
        ctx.ui.notify(
          "[HeadsDown] Unknown details mode. Use /headsdown details <on|off|toggle>.",
          "warning",
        );
        return;
      }

      await updateStatusUI(ctx);
      ctx.ui.notify(
        `[HeadsDown] Details ${detailsWidgetVisible ? "enabled" : "hidden"}. Use /headsdown details <on|off|toggle>.`,
        "info",
      );
      return;
    }

    const actorClient = withActorContext(client, ctx);
    const availability = await getAvailabilityContext(actorClient);
    const summary = formatSummary(
      availability.contract,
      availability.calendar ?? availability.schedule,
    );
    const wrapUpInstruction = resolveExecutionInstruction({
      contract: availability.contract,
      schedule: availability.schedule,
    });

    availabilitySnapshot = {
      contract: availability.contract,
      calendar: availability.calendar,
      schedule: availability.schedule,
      summary,
      wrapUpInstruction,
      fetchedAt: Date.now(),
    };

    await updateStatusUI(ctx);
    ctx.ui.notify(`[HeadsDown] ${summary}`, "info");
  }

  pi.registerCommand("headsdown", {
    description: "Check HeadsDown status and session controls",
    getArgumentCompletions: getHeadsDownCommandCompletions,
    handler: async (args, ctx) => {
      try {
        await runHeadsDownCommand(args, ctx);
      } catch (error) {
        ctx.ui.notify(
          `[HeadsDown] Error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
