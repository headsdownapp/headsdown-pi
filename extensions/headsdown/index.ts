/**
 * HeadsDown Availability Extension for Pi
 *
 * Gives Pi awareness of the user's focus mode, schedule, and availability.
 *
 * - Injects availability context at session start
 * - Registers headsdown_status, headsdown_propose, headsdown_auth tools
 * - Intercepts write/edit tool calls to check availability (trust levels)
 * - Registers /headsdown command
 * - Persists proposal state in the session
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { HeadsDownClient, ConfigStore } from "@headsdown/sdk";
import type {
  ActorContext,
  Contract,
  DelegationGrant,
  DelegationGrantFilterInput,
  DelegationGrantInput,
  DelegationGrantPermission,
  DelegationGrantScope,
  HeadsDownConfig,
  ProposalInput,
  ScheduleResolution,
} from "@headsdown/sdk";
import {
  applyTrustPolicy,
  isSensitivePath,
  formatSummary,
  formatWrapUpInstruction,
} from "./policy.js";

// === State ===

interface ProposalState {
  proposals: Array<{
    id: string;
    decision: "approved" | "deferred";
    description: string;
    evaluatedAt: string;
  }>;
}

const MAX_PROPOSAL_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

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
};

export default function headsdownExtension(pi: ExtensionAPI) {
  let approvedProposals: ProposalState["proposals"] = [];
  let cachedConfig: HeadsDownConfig | null = null;
  let cachedClient: HeadsDownClient | null = null;
  let lastApprovedProposalId: string | null = null;

  // === Helpers ===

  function restoreProposals(ctx: ExtensionContext) {
    approvedProposals = [];
    const now = Date.now();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "headsdown-proposal") {
        const data = entry.data as ProposalState | undefined;
        if (data?.proposals) {
          approvedProposals = data.proposals.filter(
            (p) => now - new Date(p.evaluatedAt).getTime() < MAX_PROPOSAL_AGE_MS,
          );
        }
      }
    }
  }

  function hasApprovedProposal(): boolean {
    const now = Date.now();
    return approvedProposals.some(
      (p) =>
        p.decision === "approved" && now - new Date(p.evaluatedAt).getTime() < MAX_PROPOSAL_AGE_MS,
    );
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

  // === Session events ===

  pi.on("session_start", async (_event, ctx) => {
    restoreProposals(ctx);
    lastApprovedProposalId = null;
    cachedConfig = null;
    cachedClient = null; // Re-validate credentials on new session
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreProposals(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    restoreProposals(ctx);
  });

  // Inject availability context at the start of each agent turn
  pi.on("before_agent_start", async (_event, _ctx) => {
    try {
      const client = await getClient();
      if (!client) return undefined;

      const actorClient = withActorContext(client, _ctx);
      const availability = await getAvailabilityContext(actorClient);
      const summary = formatSummary(
        availability.contract,
        availability.calendar ?? availability.schedule,
      );
      const wrapUpInstruction = formatWrapUpInstruction(availability.schedule?.wrapUpGuidance);
      const content = wrapUpInstruction
        ? `[HeadsDown] ${summary}\n[HeadsDown] Wrap-Up instruction: ${wrapUpInstruction}`
        : `[HeadsDown] ${summary}`;

      return {
        message: {
          customType: "headsdown-context",
          content,
          display: false,
        },
      };
    } catch {
      return undefined;
    }
  });

  // === Tool call interception ===

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    const filePath = (event.input as { path?: string }).path ?? "";
    const config = await loadConfig();

    if (isSensitivePath(filePath, config.sensitivePaths)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`[HeadsDown] Sensitive file: ${filePath}. Requires confirmation.`, "warning");
      }
      return undefined; // Notify but don't block (user sees the warning)
    }

    let contract: Contract | null = null;
    try {
      const client = await getClient();
      if (!client) return undefined;
      const actorClient = withActorContext(client, ctx);
      const result = await getAvailabilityContext(actorClient);
      contract = result.contract;
    } catch {
      return undefined;
    }

    const mode = contract?.mode ?? "none";
    const locked = contract?.lock === true;
    const trustLevel = config.trustLevel;
    const decision = applyTrustPolicy(trustLevel, mode, locked, hasApprovedProposal());

    // Show notifications for advisory mode (applyTrustPolicy returns undefined)
    if (!decision && trustLevel === "advisory" && ctx.hasUI) {
      if (locked) {
        ctx.ui.notify("[HeadsDown] User status is locked. Confirm before writing.", "warning");
      } else if (mode === "offline") {
        ctx.ui.notify("[HeadsDown] User is offline. Consider deferring.", "warning");
      }
    }

    return decision;
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
      const wrapUpInstruction = formatWrapUpInstruction(availability.schedule?.wrapUpGuidance);

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

      if (verdict.decision === "approved") {
        lastApprovedProposalId = verdict.proposalId;
        approvedProposals.push({
          id: verdict.proposalId,
          decision: "approved",
          description: params.description,
          evaluatedAt: verdict.evaluatedAt,
        });
        pi.appendEntry<ProposalState>("headsdown-proposal", {
          proposals: approvedProposals,
        });
      }

      const guidance =
        verdict.decision === "approved"
          ? "The task was approved. Proceed with the work as described."
          : "The task was deferred. Inform the user and suggest postponing or reducing scope.";
      const wrapUpInstruction = formatWrapUpInstruction(verdict.wrapUpGuidance);

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
    name: "headsdown_grants",
    label: "HeadsDown Delegation Grants",
    description:
      "Manage delegation grants for actor-scoped authorization. " +
      "Supports listing, creating, and revoking grants.",
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
      "Manage temporary availability overrides. " +
      "Supports setting, viewing, and cancelling active overrides.",
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
      return {
        content: [{ type: "text", text: JSON.stringify({ override }, null, 2) }],
        details: { override },
      };
    },
  });

  pi.registerTool({
    name: "headsdown_report",
    label: "HeadsDown Report Outcome",
    description:
      "Report the outcome of a task that was approved via headsdown_propose. " +
      "Call this when you've finished or failed a task. Helps HeadsDown " +
      "calibrate future verdicts for better accuracy.",
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
      const reportOutcome = (
        actorClient as unknown as {
          reportOutcome?: (input: Record<string, unknown>) => Promise<unknown>;
        }
      ).reportOutcome;
      if (typeof reportOutcome !== "function") {
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

      try {
        await reportOutcome({
          proposalId: lastApprovedProposalId,
          outcome: params.outcome,
          errorCategory: params.error_category,
          testsPassed: params.tests_passed,
        });

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
      // Check if already authenticated
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
          cachedClient = null; // Invalid, clear cache
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

      cachedClient = client; // Cache the new client
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
    handler: async (_args, ctx) => {
      try {
        const client = await getClient();
        if (!client) {
          ctx.ui.notify("[HeadsDown] Not authenticated. Ask me to run headsdown_auth.", "warning");
          return;
        }
        const actorClient = withActorContext(client, ctx);
        const availability = await getAvailabilityContext(actorClient);
        const summary = formatSummary(
          availability.contract,
          availability.calendar ?? availability.schedule,
        );
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
