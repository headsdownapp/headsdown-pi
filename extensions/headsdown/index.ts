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
import { HeadsDownClient, ConfigStore, AuthError } from "@headsdown/sdk";
import type { Contract, ProposalInput, HeadsDownConfig } from "@headsdown/sdk";
import { applyTrustPolicy, isSensitivePath, formatSummary } from "./policy.js";

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

      const { contract, calendar } = await client.getAvailability();
      const summary = formatSummary(contract, calendar);

      return {
        message: {
          customType: "headsdown-context",
          content: `[HeadsDown] ${summary}`,
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
      const result = await client.getAvailability();
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
      const { contract, calendar } = await client.getAvailability();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { contract, calendar, summary: formatSummary(contract, calendar) },
              null,
              2,
            ),
          },
        ],
        details: { contract, calendar },
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
      const action = params.action ?? "list";

      const presets = await client.listPresets();

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

      const contract = await client.applyPreset(selected.id);
      const calendar = await client.getCalendar();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                appliedPreset: { id: selected.id, name: selected.name },
                contract,
                calendar,
                summary: formatSummary(contract, calendar),
              },
              null,
              2,
            ),
          },
        ],
        details: { appliedPreset: selected, contract, calendar },
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await getClientOrThrow();

      const input: ProposalInput = {
        agentRef: "pi-agent",
        framework: "pi",
        description: params.description,
        estimatedFiles: params.estimated_files,
        estimatedMinutes: params.estimated_minutes,
        scopeSummary: params.scope_summary,
        sourceRef: params.source_ref,
      };

      const verdict = await client.submitProposal(input);

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
      const reportOutcome = (
        client as unknown as {
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
        const { contract, calendar } = await client.getAvailability();
        const summary = formatSummary(contract, calendar);
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
