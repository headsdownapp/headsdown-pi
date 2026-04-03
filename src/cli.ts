#!/usr/bin/env node

import {
  HeadsDownClient,
  CredentialStore,
  AuthError,
  ApiError,
  NetworkError,
  ValidationError,
} from "@headsdown/sdk";
import type { Contract, Calendar, ProposalInput } from "@headsdown/sdk";

// === Main ===

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  status: cmdStatus,
  propose: cmdPropose,
  auth: cmdAuth,
  "auth-check": cmdAuthCheck,
  help: cmdHelp,
};

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    await cmdHelp();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    error(`Unknown command: ${command}. Run 'headsdown help' to see available commands.`);
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (err) {
    if (err instanceof AuthError) {
      error(`Authentication error: ${err.message}\n\nRun 'headsdown auth' to authenticate.`);
    } else if (err instanceof NetworkError) {
      error(`Network error: ${err.message}\n\nCheck your connection and try again.`);
    } else if (err instanceof ValidationError) {
      error(`Invalid input: ${err.message}`);
    } else if (err instanceof ApiError) {
      error(`API error: ${err.message}`);
    } else {
      error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

// === Commands ===

async function cmdStatus() {
  const client = await getClient();
  const { contract, calendar } = await client.getAvailability();

  const result = {
    contract,
    calendar,
    summary: formatSummary(contract, calendar),
  };

  output(result);
}

async function cmdPropose(args: string[]) {
  const description = extractPositional(args);
  if (!description) {
    error(
      'Usage: headsdown propose "description of the task" [--files N] [--minutes N] [--scope TEXT] [--ref TEXT]',
    );
    process.exit(1);
  }

  const client = await getClient();

  const input: ProposalInput = {
    agentRef: "pi-agent",
    framework: "pi",
    description,
    estimatedFiles: parseIntFlag(args, "--files"),
    estimatedMinutes: parseIntFlag(args, "--minutes"),
    scopeSummary: parseStringFlag(args, "--scope"),
    sourceRef: parseStringFlag(args, "--ref"),
  };

  const verdict = await client.submitProposal(input);

  const guidance =
    verdict.decision === "approved"
      ? "Proceed with the task as described."
      : "The task was deferred. Inform the user and suggest postponing or reducing scope.";

  output({
    decision: verdict.decision,
    reason: verdict.reason,
    guidance,
    proposalId: verdict.proposalId,
    evaluatedAt: verdict.evaluatedAt,
  });
}

async function cmdAuth() {
  // Check if already authenticated
  const store = new CredentialStore();
  const existing = await store.load();

  if (existing) {
    try {
      const client = new HeadsDownClient({ apiKey: existing.apiKey });
      const profile = await client.getProfile();
      log(`Already authenticated as ${profile.name ?? profile.email}.`);
      log(
        "Run 'headsdown auth-check' to verify, or delete ~/.config/headsdown/credentials.json to re-authenticate.",
      );
      return;
    } catch {
      log("Existing credentials are invalid. Starting fresh authentication...");
      await store.clear();
    }
  }

  log("Starting HeadsDown authentication...\n");

  const client = await HeadsDownClient.authenticate(
    (auth) => {
      log(`Open this URL in your browser:\n`);
      log(`  ${auth.verificationUriComplete}\n`);
      log(`Or go to ${auth.verificationUri} and enter code: ${auth.userCode}\n`);
      log("Waiting for approval...");
    },
    { label: "Pi Agent Skill" },
  );

  const profile = await client.getProfile();
  log(`\nAuthenticated as ${profile.name ?? profile.email}.`);
  log("Credentials saved to ~/.config/headsdown/credentials.json");
}

async function cmdAuthCheck() {
  const client = await getClient();
  const profile = await client.getProfile();

  output({
    authenticated: true,
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
    },
  });
}

async function cmdHelp() {
  log(`headsdown - HeadsDown availability CLI for Pi agent

Commands:
  status        Check current availability (mode, schedule, time remaining)
  propose TEXT  Submit a task proposal for verdict
  auth          Authenticate with HeadsDown via Device Flow
  auth-check    Verify saved credentials are valid
  help          Show this help message

Examples:
  headsdown status
  headsdown propose "Refactor auth module" --files 4 --minutes 30
  headsdown auth`);
}

// === Helpers ===

async function getClient(): Promise<HeadsDownClient> {
  return await HeadsDownClient.fromCredentials();
}

function formatSummary(contract: Contract | null, calendar: Calendar): string {
  const parts: string[] = [];

  if (!contract) {
    parts.push("No active availability contract.");
  } else {
    parts.push(`Mode: ${contract.mode}`);

    if (contract.statusText) {
      const emoji = contract.statusEmoji ? `${contract.statusEmoji} ` : "";
      parts.push(`Status: ${emoji}${contract.statusText}`);
    }

    if (contract.expiresAt) {
      const expires = new Date(contract.expiresAt);
      const now = new Date();
      const minutesLeft = Math.round((expires.getTime() - now.getTime()) / 60000);
      if (minutesLeft > 0) {
        parts.push(`Time remaining: ${minutesLeft} minutes`);
      }
    }

    if (contract.afk) parts.push("User is AFK");
    if (contract.lock) parts.push("Status is locked");
    if (contract.autoRespond) parts.push("Auto-respond is enabled");
  }

  if (calendar.offHours) {
    parts.push(`Off-hours. Next workday: ${calendar.nextWorkday}`);
  } else if (calendar.workHours) {
    parts.push(`Work hours active (${calendar.day})`);
  }

  return parts.join("; ");
}

/** Extract the first positional argument (not a flag). */
function extractPositional(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("--")) return arg;
  }
  return undefined;
}

/** Parse a --flag N integer value from args. */
function parseIntFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = parseInt(args[index + 1], 10);
  return isNaN(value) ? undefined : value;
}

/** Parse a --flag TEXT string value from args. */
function parseStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

/** Print structured JSON output (for agent consumption). */
function output(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

/** Print a human-readable message to stderr (not captured by agent). */
function log(message: string) {
  console.error(message);
}

/** Print an error message to stderr. */
function error(message: string) {
  console.error(`Error: ${message}`);
}

main();
