import type { LocalSessionSummary } from "@headsdown/sdk";
import { LOCAL_SESSION_SUMMARY_VERSION, assertLocalSessionSummary } from "@headsdown/sdk";

export type AutopilotDeferralUrgencyBucket = "low" | "normal" | "high";

export interface AutopilotDeferralPattern {
  readonly key: string;
  readonly regex: RegExp;
}

export interface AutopilotDeferralConfig {
  readonly enabled: boolean;
  readonly defaultUrgencyBucket: AutopilotDeferralUrgencyBucket;
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
    pattern: String.raw`\blet\s+me\s+know\b`,
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
    patterns: hasCustomPatterns ? customPatterns : defaultPatterns,
  };
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ");
}

export function detectDeferral(
  text: string,
  patterns: ReadonlyArray<AutopilotDeferralPattern>,
): { matched: boolean; matchedPatternKey: string | null } {
  const searchableText = stripCodeFences(text).trim();
  if (!searchableText) return { matched: false, matchedPatternKey: null };

  const matchedPattern = patterns.find((pattern) => pattern.regex.test(searchableText));
  return {
    matched: matchedPattern !== undefined,
    matchedPatternKey: matchedPattern?.key ?? null,
  };
}

export function pickDecisionKind(): "would_have_asked" {
  return "would_have_asked";
}

export function pickDecisionCategory(): "unknown" {
  return "unknown";
}

export function pickUrgencyBucket(config: AutopilotDeferralConfig): AutopilotDeferralUrgencyBucket {
  return config.defaultUrgencyBucket;
}

function safeSummaryToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 96);
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
