/**
 * Pure policy functions for HeadsDown availability enforcement.
 * Extracted from the extension for testability.
 */

import type { TrustLevel, Contract, ScheduleResolution, WrapUpGuidance } from "@headsdown/sdk";

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

// === Auto-Thinking Policy ===

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AutoThinkingConfig {
  enabled: boolean;
  maxLevel: ThinkingLevel;
  respectManualChanges: boolean;
  showStatus: boolean;
  allowDowngrade: boolean;
}

export interface AutoThinkingContext {
  prompt: string;
  currentLevel: ThinkingLevel;
  lastAutoLevel?: ThinkingLevel | null;
  config: AutoThinkingConfig;
  mode?: string | null;
  inReachableHours?: boolean | null;
  wrapUpSelectedMode?: "auto" | "wrap_up" | "full_depth" | string | null;
  hasActiveProposal?: boolean;
}

export interface AutoThinkingDecision {
  level: ThinkingLevel | null;
  reason: string;
  status: string | null;
}

export const DEFAULT_AUTO_THINKING_CONFIG: AutoThinkingConfig = {
  enabled: false,
  maxLevel: "high",
  respectManualChanges: true,
  showStatus: true,
  allowDowngrade: false,
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function rankThinkingLevel(level: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(level);
}

function maxThinkingLevel(left: ThinkingLevel, right: ThinkingLevel): ThinkingLevel {
  return rankThinkingLevel(left) >= rankThinkingLevel(right) ? left : right;
}

function minThinkingLevel(left: ThinkingLevel, right: ThinkingLevel): ThinkingLevel {
  return rankThinkingLevel(left) <= rankThinkingLevel(right) ? left : right;
}

export function normalizeAutoThinkingConfig(value: unknown): AutoThinkingConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_AUTO_THINKING_CONFIG };

  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_AUTO_THINKING_CONFIG.enabled,
    maxLevel: isThinkingLevel(raw.maxLevel) ? raw.maxLevel : DEFAULT_AUTO_THINKING_CONFIG.maxLevel,
    respectManualChanges:
      typeof raw.respectManualChanges === "boolean"
        ? raw.respectManualChanges
        : DEFAULT_AUTO_THINKING_CONFIG.respectManualChanges,
    showStatus:
      typeof raw.showStatus === "boolean"
        ? raw.showStatus
        : DEFAULT_AUTO_THINKING_CONFIG.showStatus,
    allowDowngrade:
      typeof raw.allowDowngrade === "boolean"
        ? raw.allowDowngrade
        : DEFAULT_AUTO_THINKING_CONFIG.allowDowngrade,
  };
}

function classifyPromptForThinking(prompt: string): ThinkingLevel {
  const normalized = prompt.toLowerCase();

  if (
    /\b(architecture|design|refactor|migration|security|performance|concurrency|race condition|deadlock|debug|investigate|root cause|incident|flaky|failing test|test failure)\b/.test(
      normalized,
    )
  ) {
    return "high";
  }

  if (
    /\b(implement|build|fix|add|update|write tests?|integration|api|database|multi-file)\b/.test(
      normalized,
    )
  ) {
    return "medium";
  }

  if (/\b(explain|summarize|review|rename|format|docs?|quick)\b/.test(normalized)) {
    return "low";
  }

  return normalized.trim().length < 120 ? "minimal" : "medium";
}

function availabilityFloor(input: AutoThinkingContext): ThinkingLevel {
  let floor: ThinkingLevel = "off";
  const mode = input.mode?.toLowerCase();

  if (mode === "offline" || input.inReachableHours === false) {
    floor = maxThinkingLevel(floor, "high");
  } else if (mode === "busy") {
    floor = maxThinkingLevel(floor, "high");
  } else if (mode === "limited") {
    floor = maxThinkingLevel(floor, "medium");
  }

  if (input.hasActiveProposal) {
    floor = maxThinkingLevel(floor, "medium");
  }

  if (input.wrapUpSelectedMode === "full_depth") {
    floor = maxThinkingLevel(floor, "high");
  }

  return floor;
}

export function decideAutoThinking(input: AutoThinkingContext): AutoThinkingDecision {
  const config = input.config;

  if (!config.enabled) {
    return { level: null, reason: "disabled", status: null };
  }

  const manualChangeDetected =
    config.respectManualChanges &&
    input.lastAutoLevel !== null &&
    input.lastAutoLevel !== undefined &&
    input.currentLevel !== input.lastAutoLevel;

  if (manualChangeDetected) {
    return {
      level: null,
      reason: "manual_preserved",
      status: config.showStatus ? `thinking:manual ${input.currentLevel}` : null,
    };
  }

  let target = maxThinkingLevel(classifyPromptForThinking(input.prompt), availabilityFloor(input));
  target = minThinkingLevel(target, config.maxLevel);

  if (!config.allowDowngrade && rankThinkingLevel(target) < rankThinkingLevel(input.currentLevel)) {
    return {
      level: null,
      reason: "downgrade_skipped",
      status: config.showStatus ? `thinking:auto ${input.currentLevel}` : null,
    };
  }

  if (target === input.currentLevel) {
    return {
      level: null,
      reason: "already_selected",
      status: config.showStatus ? `thinking:auto ${target}` : null,
    };
  }

  return {
    level: target,
    reason: "auto_selected",
    status: config.showStatus ? `thinking:auto ${target}` : null,
  };
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
export function formatWrapUpInstruction(
  guidance: WrapUpGuidance | null | undefined,
): string | null {
  if (!guidance || !guidance.active) {
    return null;
  }

  let instruction = "";

  if (guidance.selectedMode === "wrap_up") {
    instruction =
      "Execution policy for this task: keep scope minimal, avoid starting new refactors, finish the current slice cleanly, and include clear handoff notes for anything deferred.";
  } else if (guidance.selectedMode === "full_depth") {
    instruction =
      "Execution policy for this task: proceed with full implementation depth, include robust validation and tests, and do not shrink scope only because a deadline is near.";
  } else {
    instruction =
      "Execution policy for this task: follow the provided context to balance scope and depth, stay focused on the requested outcome, and avoid unnecessary expansion.";
  }

  const context: string[] = [];

  if (typeof guidance.remainingMinutes === "number") {
    context.push(
      `About ${guidance.remainingMinutes} minutes remain before the attention deadline.`,
    );
  }

  if (guidance.reason) {
    context.push(`Reason: ${guidance.reason}`);
  }

  if (guidance.hints.length > 0) {
    context.push(`Hints: ${guidance.hints.join("; ")}`);
  }

  return [instruction, ...context].join(" ");
}

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
