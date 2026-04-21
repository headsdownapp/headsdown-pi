/**
 * Pure policy functions for HeadsDown availability enforcement.
 * Extracted from the extension for testability.
 */

import type { TrustLevel, Contract, ScheduleResolution } from "@headsdown/sdk";

type ScheduleContext = {
  inReachableHours?: boolean | null;
  nextTransitionAt?: string | null;
};

type CalendarLike = {
  offHours?: boolean;
  workHours?: boolean;
  day?: string;
  nextWorkday?: string;
};

type AvailabilityContext = CalendarLike | ScheduleResolution | ScheduleContext | null | undefined;

function isCalendarContext(context: AvailabilityContext): context is CalendarLike {
  return Boolean(
    context &&
    typeof context === "object" &&
    "offHours" in context &&
    "workHours" in context &&
    "day" in context,
  );
}

function isScheduleContext(context: AvailabilityContext): context is ScheduleContext {
  return Boolean(context && typeof context === "object" && "inReachableHours" in context);
}

// === Trust Policy ===

export interface PolicyDecision {
  block: true;
  reason: string;
}

/**
 * Determine whether a file write should be blocked based on trust level,
 * availability mode, lock status, and proposal state.
 *
 * Returns a block decision or undefined (allow).
 */
export function applyTrustPolicy(
  trustLevel: TrustLevel,
  mode: string,
  locked: boolean,
  hasProposal: boolean,
): PolicyDecision | undefined {
  if (trustLevel === "advisory") {
    // Advisory never blocks. Callers may still show notifications.
    return undefined;
  }

  if (trustLevel === "active") {
    if (locked) {
      return { block: true, reason: "[HeadsDown] User status is locked. Ask before proceeding." };
    }
    if (mode === "offline" && !hasProposal) {
      return {
        block: true,
        reason: "[HeadsDown] User is offline. Submit a proposal via headsdown_propose first.",
      };
    }
    return undefined;
  }

  if (trustLevel === "guarded") {
    if (locked) {
      return {
        block: true,
        reason: "[HeadsDown] User status is locked. Explicit permission required.",
      };
    }
    if ((mode === "busy" || mode === "limited" || mode === "offline") && !hasProposal) {
      return {
        block: true,
        reason: `[HeadsDown] User is in ${mode} mode. No approved proposal found. Submit one via headsdown_propose.`,
      };
    }
    return undefined;
  }

  return undefined;
}

// === Sensitive Path Detection ===

const SENSITIVE_DEFAULTS: RegExp[] = [
  /^\.env/,
  /\/\.env/,
  /^\.ssh\//,
  /\/\.ssh\//,
  /\/secrets?\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^Dockerfile/,
  /^docker-compose/,
  /^\.github\//,
  /^\.gitlab-ci/,
  /^\.circleci\//,
  /^Makefile$/,
  /\/config\/credentials/,
  /id_rsa/,
  /id_ed25519/,
  /authorized_keys/,
  /known_hosts/,
];

/**
 * Check if a file path matches any sensitive path pattern.
 * Checks hardcoded defaults first, then user-configured patterns.
 */
export function isSensitivePath(filePath: string, userPatterns: string[]): boolean {
  if (!filePath) return false;

  for (const re of SENSITIVE_DEFAULTS) {
    if (re.test(filePath)) return true;
  }

  for (const pattern of userPatterns) {
    if (matchGlob(pattern, filePath)) return true;
  }

  return false;
}

/**
 * Simple glob matching. Supports `*` (any segment) and `**` (any path).
 * Anchored to the full path. Safe against ReDoS by limiting pattern complexity.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // Reject patterns that are too long or have suspicious repetition
  if (pattern.length > 200) return false;

  // Convert glob to regex, escaping special chars first
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars (not * or ?)
    .replace(/\*\*/g, "\0") // Placeholder for **
    .replace(/\*/g, "[^/]*") // * matches within a segment
    .replace(/\0/g, ".*") // ** matches across segments
    .replace(/\?/g, "[^/]"); // ? matches single char

  try {
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(filePath);
  } catch {
    // Invalid pattern, treat as non-match
    return false;
  }
}

// === Summary Formatting ===

/**
 * Format a human-readable summary of the user's availability.
 */
export function formatSummary(contract: Contract | null, context: AvailabilityContext): string {
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
      if (minutesLeft > 0) parts.push(`${minutesLeft}min remaining`);
    }
    if (contract.lock) parts.push("locked");
  }

  if (isCalendarContext(context)) {
    if (context.offHours) {
      parts.push(`off-hours, next workday: ${context.nextWorkday}`);
    } else if (context.workHours) {
      parts.push(`work hours (${context.day})`);
    }
  } else if (isScheduleContext(context)) {
    if (context.inReachableHours === true) {
      parts.push("within reachable hours");
    } else if (context.inReachableHours === false) {
      const nextTransition = context.nextTransitionAt
        ? `, next transition: ${context.nextTransitionAt}`
        : "";
      parts.push(`outside reachable hours${nextTransition}`);
    }

    const wrapUpGuidance =
      context && typeof context === "object" && "wrapUpGuidance" in context
        ? (context as { wrapUpGuidance?: { active?: boolean; remainingMinutes?: number | null } })
            .wrapUpGuidance
        : undefined;

    if (wrapUpGuidance?.active) {
      const remaining =
        typeof wrapUpGuidance.remainingMinutes === "number"
          ? `${wrapUpGuidance.remainingMinutes}min left`
          : "active";
      parts.push(`Wrap-Up: ${remaining}`);
    }
  }

  return parts.join(", ");
}
