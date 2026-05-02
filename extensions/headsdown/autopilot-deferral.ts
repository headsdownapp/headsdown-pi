import type {
  ActionShape,
  ClassifiedAction,
  ClassifierEscalationStep,
  ClassifierPolicy,
  IntegrationCapabilities,
  LocalSessionSummary,
  QuestionCategory,
  RecentToolContext,
} from "@headsdown/sdk";
import { LOCAL_SESSION_SUMMARY_VERSION, assertLocalSessionSummary } from "@headsdown/sdk";

export type AutopilotDeferralUrgencyBucket = "low" | "normal" | "high";
export type AutopilotDeferralDetection = { matched: boolean; matchedPatternKey: string | null };
export type AutopilotEscalationOutcome = "succeeded" | "failed" | "unavailable" | "deferred";

export interface AutopilotDeferralPattern {
  readonly key: string;
  readonly regex: RegExp;
}

export interface AutopilotDeferralConfig {
  readonly enabled: boolean;
  readonly defaultUrgencyBucket: AutopilotDeferralUrgencyBucket;
  readonly idleThresholdMs: number;
  readonly nudgeCooldownMs: number;
  readonly maxConsecutiveNudges: number;
  readonly hostedAutopilotContextEnabled: boolean;
  readonly patterns: ReadonlyArray<AutopilotDeferralPattern>;
}

export interface LocalSessionSummaryInput {
  runId: string;
  approvedProposalId: string | null;
  toolCallCount: number;
  fileChangeCount: number;
  deferredDecisionCount: number;
  continuationArtifactAvailable: boolean;
  validationLocallyPassed: boolean;
  now: Date;
}

export interface AutopilotContextInput {
  readonly classifiedAction: ClassifiedAction;
  readonly policy: ClassifierPolicy;
  readonly capabilities: IntegrationCapabilities;
  readonly attempts: ReadonlyArray<{
    readonly step: ClassifierEscalationStep;
    readonly outcome: AutopilotEscalationOutcome;
    readonly reasonCode: string;
  }>;
  readonly classifierDecisionId?: string;
}

export const DEFAULT_IDLE_THRESHOLD_MS = 30_000;
export const DEFAULT_NUDGE_COOLDOWN_MS = 5_000;
export const DEFAULT_MAX_CONSECUTIVE_NUDGES = 4;

export const DEFAULT_DETECTION_PATTERNS: Array<{ key: string; pattern: string }> = [
  {
    key: "explicit_defer_marker",
    pattern: String.raw`\[(?:DEFER|NEEDS_USER)\]`,
  },
  {
    key: "should_i",
    pattern: String.raw`\bshould\s+i\b[^.!?]{0,160}\?`,
  },
  {
    key: "would_you_like",
    pattern: String.raw`\bwould\s+you\s+like\b`,
  },
  {
    key: "do_you_want",
    pattern: String.raw`\bdo\s+you\s+want\b`,
  },
  {
    key: "let_me_know",
    pattern: String.raw`\blet\s+me\s+know\b[^.!?]{0,120}\b(?:which|whether|if\s+you\s+(?:want|would|prefer)|if\s+you['’]?d\s+like|how|what|when)\b`,
  },
  {
    key: "please_confirm",
    pattern: String.raw`\bplease\s+confirm\b`,
  },
  {
    key: "which_would_you_prefer",
    pattern: String.raw`\bwhich\s+would\s+you\s+prefer\b`,
  },
  {
    key: "trailing_second_person_question",
    pattern: String.raw`\b(?:you|your)\b[^.!?]{0,180}\?\s*$`,
  },
];

function compilePattern(key: string, pattern: unknown): AutopilotDeferralPattern | null {
  if (typeof pattern !== "string" || pattern.trim().length === 0) return null;

  try {
    return { key, regex: new RegExp(pattern, "im") };
  } catch {
    return null;
  }
}

function normalizeUrgencyBucket(value: unknown): AutopilotDeferralUrgencyBucket {
  return value === "low" || value === "high" || value === "normal" ? value : "normal";
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (!Number.isFinite(value) || typeof value !== "number") return fallback;
  return Math.max(0, Math.floor(value));
}

export function normalizeAutopilotDeferralConfig(value: unknown): AutopilotDeferralConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawPatternValue = raw.patterns;
  const hasCustomPatterns = Array.isArray(rawPatternValue);
  const rawPatterns: unknown[] = hasCustomPatterns ? rawPatternValue : [];
  const customPatterns = rawPatterns
    .map((entry, index) => {
      if (typeof entry === "string") return compilePattern(`custom_${index + 1}`, entry);
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const key =
        typeof record.key === "string" && record.key.trim()
          ? record.key.trim()
          : `custom_${index + 1}`;
      return compilePattern(key, record.pattern);
    })
    .filter((pattern): pattern is AutopilotDeferralPattern => pattern !== null);

  const defaultPatterns = DEFAULT_DETECTION_PATTERNS.map(({ key, pattern }) =>
    compilePattern(key, pattern),
  ).filter((pattern): pattern is AutopilotDeferralPattern => pattern !== null);

  return {
    enabled: raw.enabled !== false,
    defaultUrgencyBucket: normalizeUrgencyBucket(raw.defaultUrgencyBucket),
    idleThresholdMs: normalizePositiveInteger(raw.idleThresholdMs, DEFAULT_IDLE_THRESHOLD_MS),
    nudgeCooldownMs: normalizePositiveInteger(raw.nudgeCooldownMs, DEFAULT_NUDGE_COOLDOWN_MS),
    maxConsecutiveNudges: Math.max(
      1,
      normalizePositiveInteger(raw.maxConsecutiveNudges, DEFAULT_MAX_CONSECUTIVE_NUDGES),
    ),
    hostedAutopilotContextEnabled: raw.hostedAutopilotContextEnabled !== false,
    patterns: hasCustomPatterns ? customPatterns : defaultPatterns,
  };
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ");
}

export function detectDeferral(
  text: string,
  patterns: ReadonlyArray<AutopilotDeferralPattern>,
): AutopilotDeferralDetection {
  const searchableText = stripCodeFences(text).trim();
  if (!searchableText) return { matched: false, matchedPatternKey: null };

  const matchedPattern = patterns.find((pattern) => pattern.regex.test(searchableText));
  return {
    matched: matchedPattern !== undefined,
    matchedPatternKey: matchedPattern?.key ?? null,
  };
}

export function questionCategoryForPattern(matchedPatternKey: string | null): QuestionCategory {
  switch (matchedPatternKey) {
    case "should_i":
      return "scope_clarification";
    case "please_confirm":
      return "approval_request";
    case "would_you_like":
    case "do_you_want":
    case "which_would_you_prefer":
      return "tooling_choice";
    case "explicit_defer_marker":
      return "recovery_decision";
    case "let_me_know":
    case "trailing_second_person_question":
    default:
      return "other";
  }
}

export function decisionCategoryForQuestionCategory(
  category: QuestionCategory,
): "scope" | "tooling" | "validation" | "data" | "other" | "unknown" {
  switch (category) {
    case "scope_clarification":
      return "scope";
    case "tooling_choice":
      return "tooling";
    case "recovery_decision":
      return "validation";
    case "data_input":
      return "data";
    case "approval_request":
    case "other":
      return "other";
    default:
      return "unknown";
  }
}

export function buildInteractionAskUserActionShape(input: {
  questionCategory: QuestionCategory;
  recentToolContext: RecentToolContext;
}): ActionShape {
  return {
    tool_kind: "interaction.ask_user",
    question_category: input.questionCategory,
    recent_tool_context: input.recentToolContext,
  };
}

export function pickDecisionKind(): "would_have_asked" {
  return "would_have_asked";
}

export function pickDecisionCategory(
  questionCategory?: QuestionCategory,
): "scope" | "tooling" | "validation" | "data" | "other" | "unknown" {
  return questionCategory ? decisionCategoryForQuestionCategory(questionCategory) : "unknown";
}

export function pickUrgencyBucket(config: AutopilotDeferralConfig): AutopilotDeferralUrgencyBucket {
  return config.defaultUrgencyBucket;
}

export function escalationAttemptReasonCode(
  step: ClassifierEscalationStep,
  outcome: AutopilotEscalationOutcome,
): string {
  return `${step}_${outcome}`;
}

export function buildAutopilotContext(input: AutopilotContextInput): Record<string, unknown> {
  const context = {
    classifier_version: input.policy.classifierVersion,
    tool_kind: normalizeSafeToken(input.classifiedAction.toolKind),
    classification_outcome: input.classifiedAction.outcome,
    classifier_reason_code: input.classifiedAction.reasonCode,
    classifier_source: input.classifiedAction.source,
    latitude_at_decision: input.policy.latitude,
    sandbox_preference: input.policy.sandboxPreference,
    classifier_decision_id: input.classifierDecisionId,
    capability_summary: {
      sandbox_available: input.capabilities.sandbox.available,
      sandbox_stale: input.capabilities.stale === true,
      fs_isolation: input.capabilities.sandbox.fsIsolation,
      network_isolation: input.capabilities.sandbox.networkIsolation,
      identity_isolation: input.capabilities.sandbox.identityIsolation,
    },
    escalation_attempts: input.attempts.map((attempt) => ({
      step: attempt.step,
      outcome: attempt.outcome,
      reason_code: attempt.reasonCode,
    })),
  };

  return stripUndefinedValues(context);
}

function normalizeSafeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 96);
}

function safeSummaryToken(value: string): string {
  return normalizeSafeToken(value);
}

function stripUndefinedValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function buildLocalSessionSummary(input: LocalSessionSummaryInput): LocalSessionSummary {
  const summary: LocalSessionSummary = {
    version: LOCAL_SESSION_SUMMARY_VERSION,
    sessionId: safeSummaryToken(input.runId),
    generatedAt: input.now.toISOString(),
    stale: false,
    toolCallCount: Math.max(0, input.toolCallCount),
    fileChangeCount: Math.max(0, input.fileChangeCount),
    deferredDecisionCount: Math.max(0, input.deferredDecisionCount),
    continuationArtifactAvailable: input.continuationArtifactAvailable,
    validationLocallyPassed: input.validationLocallyPassed,
    approvedProposalRef: input.approvedProposalId
      ? safeSummaryToken(input.approvedProposalId)
      : null,
    outcomeCategory: "in_progress",
  };

  assertLocalSessionSummary(summary);
  return summary;
}
