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

import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as HeadsDownSDK from "@headsdown/sdk";
import { HeadsDownClient, ConfigStore } from "@headsdown/sdk";
import type {
  ActorContext,
  Contract,
  DelegationGrantFilterInput,
  DelegationGrantInput,
  DelegationGrantPermission,
  DelegationGrantScope,
  HeadsDownConfig,
  ProposalInput,
  ScheduleResolution,
  Verdict,
} from "@headsdown/sdk";
import {
  applyTrustPolicy,
  formatSummary,
  formatWrapUpInstruction,
  isSensitivePath,
} from "./policy.js";

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

interface ProposalScopeSnapshot {
  proposalId: string;
  modifiedFiles: string[];
  warningSent: boolean;
  updatedAt: string;
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

interface ContinuationArtifact {
  branch: string | null;
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
  proposal: ProposalRecord | null;
  scope: ProposalScopeSnapshot | null;
  firstKeptEntryId: string;
  tokensBefore: number;
}

const MAX_PROPOSAL_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
const AVAILABILITY_CACHE_TTL_MS = 90 * 1000; // 90 seconds
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

function buildActorContext(ctx: ExtensionContext): ActorContext {
  const sessionId = getSessionId(ctx);
  return {
    source: "pi",
    agentId: "pi-agent",
    sessionId,
    workspaceRef: ctx.cwd,
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

  const data = await graphql.request(CREATE_AVAILABILITY_OVERRIDE_MUTATION, {
    input,
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

async function loadContinuationArtifact(
  removeAfterRead: boolean,
): Promise<ContinuationArtifact | null> {
  try {
    const raw = await readFile(CONTINUATION_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ContinuationArtifact;
    if (removeAfterRead) {
      await unlink(CONTINUATION_PATH);
    }
    return parsed;
  } catch {
    return null;
  }
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
  const hasContext =
    Boolean(input.availabilitySummary) ||
    Boolean(input.wrapUpInstruction) ||
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

export const __internal = {
  AVAILABILITY_COMPAT_QUERY,
  ACTIVE_AVAILABILITY_OVERRIDE_QUERY,
  CREATE_AVAILABILITY_OVERRIDE_MUTATION,
  CANCEL_AVAILABILITY_OVERRIDE_MUTATION,
  getLowLevelGraphQLClient,
  getAvailabilityContext,
  buildActorContext,
  withActorContext,
  createAvailabilityOverrideCompat,
  getActiveAvailabilityOverrideCompat,
  cancelAvailabilityOverrideCompat,
  normalizeToolPath,
  isPotentiallyMutatingBashCommand,
  isReadonlyBashCommand,
  buildHeadsDownCompaction,
  CONTINUATION_PATH,
};

export default function headsdownExtension(pi: ExtensionAPI) {
  let approvedProposals: ProposalRecord[] = [];
  let proposalScopes = new Map<string, ProposalScopeSnapshot>();
  let cachedConfig: HeadsDownConfig | null = null;
  let cachedClient: HeadsDownClient | null = null;
  let lastApprovedProposalId: string | null = null;
  let availabilitySnapshot: AvailabilitySnapshot | null = null;

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

  async function loadConfig(): Promise<HeadsDownConfig> {
    if (!cachedConfig) {
      const store = new ConfigStore();
      cachedConfig = await store.load();
    }
    return cachedConfig;
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
    options: { force?: boolean } = {},
  ): Promise<AvailabilitySnapshot | null> {
    const force = options.force === true;
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
      return availabilitySnapshot;
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

  function formatRemainingMinutes(expiresAt: string | null | undefined): string | null {
    if (!expiresAt) return null;
    const expires = new Date(expiresAt);
    if (Number.isNaN(expires.getTime())) return null;

    const minutes = Math.round((expires.getTime() - Date.now()) / 60000);
    return minutes > 0 ? `${minutes}m` : null;
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
          ? `${schedule.wrapUpGuidance.remainingMinutes}m`
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
      `${theme.frame.bottom} /headsdown for full details · /headsdown theme <neo|mono|executive>`,
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

    ctx.ui.setWidget("headsdown", detailsWidget.length > 0 ? detailsWidget : undefined);
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

  async function saveAutomaticContinuation(reason: string) {
    const artifact = await createContinuationArtifact(reason);
    if (!artifact) return;

    try {
      await saveContinuationArtifact(artifact);
    } catch {
      // Ignore persistence failures for automatic lifecycle saves.
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

  function maybeWarnScopeDrift(
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
  }

  // === Session events ===

  pi.on("session_start", async (event, ctx) => {
    const sessionStartReason = (event as { reason?: string }).reason;
    restoreProposalState(ctx);
    cachedConfig = null;
    cachedClient = null;
    availabilitySnapshot = null;

    await refreshAvailability(ctx, { force: true });
    await updateStatusUI(ctx);

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
    await updateStatusUI(ctx);
  });

  pi.on("session_before_switch", async (event, ctx) => {
    if (!hasApprovedProposal()) return undefined;

    appendContinuityEntry("before_switch", { switchReason: event.reason });
    await saveAutomaticContinuation("session-switch");

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
    await saveAutomaticContinuation("session-shutdown");

    const latest = getLatestApprovedProposal();
    if (!latest || latest.reportedAt) return;

    if (ctx.hasUI) {
      ctx.ui.notify(
        "[HeadsDown] Approved proposal has no reported outcome yet. Consider calling headsdown_report.",
        "warning",
      );
    }
  });

  // Inject availability and policy context into the turn system prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    await refreshAvailability(ctx);
    await updateStatusUI(ctx);

    const policyInstruction = policyInstructionForPrompt();
    if (!policyInstruction) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${policyInstruction}`,
    };
  });

  // === Tool call interception ===

  pi.on("tool_call", async (event, ctx) => {
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
    if (event.isError) return undefined;

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
    maybeWarnScopeDrift(ctx, activeProposal, scope);

    return undefined;
  });

  // === Custom tools ===

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
        Type.Union([Type.Literal("list"), Type.Literal("apply")], {
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
      delivery_mode: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("wrap_up"), Type.Literal("full_depth")], {
          description: "Optional Wrap-Up delivery mode override for this task.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();
      const actorClient = withActorContext(client, _ctx);

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

      const verdict = await actorClient.submitProposal(input);

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
        Type.Union(
          [
            Type.Literal("list"),
            Type.Literal("list_active"),
            Type.Literal("create"),
            Type.Literal("revoke"),
            Type.Literal("revoke_many"),
          ],
          {
            description:
              "Action to run: list/list_active/create/revoke/revoke_many (default: list_active).",
          },
        ),
      ),
      id: Type.Optional(Type.String({ description: "Delegation grant id (for revoke)." })),
      scope: Type.Optional(
        Type.Union([Type.Literal("session"), Type.Literal("workspace"), Type.Literal("agent")], {
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
          Type.Union([
            Type.Literal("availability_override_create"),
            Type.Literal("availability_override_cancel"),
            Type.Literal("preset_apply"),
          ]),
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
        Type.Union([Type.Literal("get"), Type.Literal("set"), Type.Literal("clear")], {
          description: "Action to run: get/set/clear (default: get).",
        }),
      ),
      id: Type.Optional(Type.String({ description: "Override id for clear (optional)." })),
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("online"),
            Type.Literal("busy"),
            Type.Literal("limited"),
            Type.Literal("offline"),
          ],
          { description: "Override mode for action='set'." },
        ),
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
      action: Type.Union(
        [Type.Literal("save"), Type.Literal("load"), Type.Literal("check"), Type.Literal("clear")],
        {
          description: "Save continuation data, load and consume it, check existence, or clear it.",
        },
      ),
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
        const artifact = await loadContinuationArtifact(true);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                artifact
                  ? { found: true, consumed: true, artifact, path: CONTINUATION_PATH }
                  : { found: false, consumed: false, path: CONTINUATION_PATH },
                null,
                2,
              ),
            },
          ],
          details: artifact ? { found: true, artifact } : { found: false },
        };
      }

      const activeProposal = getLatestApprovedProposal();
      const activeScope = activeProposal ? getScopeSnapshot(activeProposal.id) : null;

      const artifact: ContinuationArtifact = {
        branch: params.branch ?? (await currentBranchName()),
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
      outcome: Type.Union(
        [
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("partially_completed"),
          Type.Literal("cancelled"),
          Type.Literal("timed_out"),
        ],
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

  pi.registerCommand("headsdown", {
    description: "Check your HeadsDown availability status",
    handler: async (args, ctx) => {
      try {
        const client = await getClient();
        if (!client) {
          ctx.ui.notify("[HeadsDown] Not authenticated. Ask me to run headsdown_auth.", "warning");
          return;
        }

        const normalizedArgs = (args ?? "").trim().toLowerCase();

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
      } catch (error) {
        ctx.ui.notify(
          `[HeadsDown] Error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
