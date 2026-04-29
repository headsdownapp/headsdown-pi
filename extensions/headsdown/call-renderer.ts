export const CANONICAL_HEADSDOWN_CALL_KEYS = [
  "good_to_run",
  "keep_it_tight",
  "not_worth_starting_now",
  "off_the_clock",
  "rabbit_hole_detected",
  "finish_line_friction",
  "ready_to_resume",
  "all_contained",
  "needs_your_yes",
] as const;

export type CanonicalHeadsDownCallKey = (typeof CANONICAL_HEADSDOWN_CALL_KEYS)[number];
export type RenderableHeadsDownCallKey = Exclude<CanonicalHeadsDownCallKey, "rabbit_hole_detected">;

export type HeadsDownActionKey =
  | "continue"
  | "continue_with_limit"
  | "narrow_scope"
  | "ask_user"
  | "queue_for_later"
  | "queue_for_morning"
  | "pause_and_summarize"
  | "stop_run"
  | "resume_run"
  | "allow_once"
  | "allow_for_duration"
  | "create_temporary_exception"
  | "keep_queued";

export type HeadsDownUiIntent =
  | "view_details"
  | "review_request"
  | "review_runs"
  | "review_handoff"
  | "view_queue"
  | "view_receipts"
  | "adjust_playbooks"
  | "start_run";

type RenderLabels = {
  title: string;
  body: string;
  primaryLabel: string | null;
  primaryActionKey: HeadsDownActionKey | null;
  primaryUiIntent: HeadsDownUiIntent | null;
  secondaryLabel: string | null;
  secondaryActionKey: HeadsDownActionKey | null;
  secondaryUiIntent: HeadsDownUiIntent | null;
};

export interface UnknownCallFallbackSignals {
  actionRequired?: boolean;
  approvalRequired?: boolean;
  riskSignal?: boolean;
  boundarySignal?: boolean;
  spendSignal?: boolean;
  externalSideEffectSignal?: boolean;
  escalationSignal?: boolean;
  limitSignal?: boolean;
  scopeUncertainty?: boolean;
  validationUncertainty?: boolean;
  lowConfidence?: boolean;
  noActionNeededExplicit?: boolean;
  inBoundsExplicit?: boolean;
}

export interface RenderHeadsDownCallInput {
  key: string | null | undefined;
  title?: string | null;
  body?: string | null;
  fallbackSignals?: UnknownCallFallbackSignals;
}

export interface RenderedHeadsDownCallCopy extends RenderLabels {
  key: RenderableHeadsDownCallKey;
  sourceKey: string | null;
  fallbackApplied: boolean;
}

const CANONICAL_CALL_COPY: Record<RenderableHeadsDownCallKey, RenderLabels> = {
  good_to_run: {
    title: "Good to run",
    body: "This task fits the time, scope, and attention available right now. Let the agent proceed within the approved bounds.",
    primaryLabel: "Let the agent proceed",
    primaryActionKey: "continue",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  keep_it_tight: {
    title: "Keep it tight",
    body: "There is enough room for a useful slice, not an open-ended run. Ask the agent for the smallest version that still ships value.",
    primaryLabel: "Narrow scope",
    primaryActionKey: "narrow_scope",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  not_worth_starting_now: {
    title: "Not worth starting now",
    body: "The likely cost is higher than the likely value right now. Queue it for later instead of burning time on a weak run.",
    primaryLabel: "Queue for later",
    primaryActionKey: "queue_for_later",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  off_the_clock: {
    title: "Off the clock",
    body: "Queued for morning keeps this ask from interrupting your evening. Your night stays yours.",
    primaryLabel: "Queued for morning",
    primaryActionKey: "queue_for_morning",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  finish_line_friction: {
    title: "Finish-line friction",
    body: "The work appears fixed in scope, but validation or delivery is stuck. Keep scope fixed and resolve only the delivery blocker.",
    primaryLabel: "Pause + summarize",
    primaryActionKey: "pause_and_summarize",
    primaryUiIntent: null,
    secondaryLabel: "Allow 15m",
    secondaryActionKey: "allow_for_duration",
    secondaryUiIntent: null,
  },
  ready_to_resume: {
    title: "Ready to resume",
    body: "HeadsDown saved the thread so the agent can pick up without starting over. Resume the approved work or keep it queued.",
    primaryLabel: "Resume approved work",
    primaryActionKey: "resume_run",
    primaryUiIntent: null,
    secondaryLabel: "Keep queued",
    secondaryActionKey: "keep_queued",
    secondaryUiIntent: null,
  },
  all_contained: {
    title: "All contained",
    body: "Runs are staying inside your time, scope, and interruption limits. Nothing needs you right now.",
    primaryLabel: null,
    primaryActionKey: null,
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  needs_your_yes: {
    title: "Needs your yes",
    body: "An agent wants to cross a boundary that should not be automatic. Review the request and approve, narrow, or keep it queued.",
    primaryLabel: "Review request",
    primaryActionKey: null,
    primaryUiIntent: "review_request",
    secondaryLabel: "Keep queued",
    secondaryActionKey: "keep_queued",
    secondaryUiIntent: null,
  },
};

function isRenderableHeadsDownCallKey(key: string): key is RenderableHeadsDownCallKey {
  return (
    (CANONICAL_HEADSDOWN_CALL_KEYS as readonly string[]).includes(key) &&
    key !== "rabbit_hole_detected"
  );
}

export function resolveUnknownHeadsDownCallFallback(
  signals?: UnknownCallFallbackSignals,
): RenderableHeadsDownCallKey {
  const hasActionRiskOrBoundarySignal =
    signals?.actionRequired === true ||
    signals?.approvalRequired === true ||
    signals?.riskSignal === true ||
    signals?.boundarySignal === true ||
    signals?.spendSignal === true ||
    signals?.externalSideEffectSignal === true ||
    signals?.escalationSignal === true;

  if (hasActionRiskOrBoundarySignal) {
    return "needs_your_yes";
  }

  const hasLimitOrScopeUncertainty =
    signals?.limitSignal === true ||
    signals?.scopeUncertainty === true ||
    signals?.validationUncertainty === true ||
    signals?.lowConfidence === true;

  if (hasLimitOrScopeUncertainty) {
    return "keep_it_tight";
  }

  const explicitNoActionAndInBounds =
    signals?.noActionNeededExplicit === true && signals?.inBoundsExplicit === true;

  if (explicitNoActionAndInBounds) {
    return "all_contained";
  }

  return "needs_your_yes";
}

export function renderHeadsDownCallCopy(
  input: RenderHeadsDownCallInput,
): RenderedHeadsDownCallCopy | null {
  const normalizedKey = normalizeCallKey(input.key);

  if (normalizedKey === "rabbit_hole_detected") {
    return null;
  }

  if (normalizedKey && isRenderableHeadsDownCallKey(normalizedKey)) {
    const copy = CANONICAL_CALL_COPY[normalizedKey];
    return {
      key: normalizedKey,
      sourceKey: normalizedKey,
      fallbackApplied: false,
      ...copy,
    };
  }

  const fallbackKey = resolveUnknownHeadsDownCallFallback(input.fallbackSignals);
  const fallbackCopy = unknownFallbackCopy(fallbackKey);

  return {
    key: fallbackKey,
    sourceKey: normalizedKey.length > 0 ? normalizedKey : null,
    fallbackApplied: true,
    title: input.title?.trim() || fallbackCopy.title,
    body: input.body?.trim() || fallbackCopy.body,
    primaryLabel: fallbackCopy.primaryLabel,
    primaryActionKey: fallbackCopy.primaryActionKey,
    primaryUiIntent: fallbackCopy.primaryUiIntent,
    secondaryLabel: fallbackCopy.secondaryLabel,
    secondaryActionKey: fallbackCopy.secondaryActionKey,
    secondaryUiIntent: fallbackCopy.secondaryUiIntent,
  };
}

function unknownFallbackCopy(key: RenderableHeadsDownCallKey): RenderLabels {
  if (key === "needs_your_yes") {
    return {
      ...CANONICAL_CALL_COPY.needs_your_yes,
      body: "HeadsDown needs a human decision before this agent continues.",
      secondaryLabel: "Why this call?",
      secondaryActionKey: null,
      secondaryUiIntent: "view_details",
    };
  }

  if (key === "keep_it_tight") {
    return {
      ...CANONICAL_CALL_COPY.keep_it_tight,
      primaryLabel: "Why this call?",
      primaryActionKey: null,
      primaryUiIntent: "view_details",
      secondaryLabel: null,
      secondaryActionKey: null,
      secondaryUiIntent: null,
    };
  }

  return CANONICAL_CALL_COPY[key];
}

function normalizeCallKey(key: string | null | undefined): string {
  return key?.trim().toLowerCase() ?? "";
}

export function formatHeadsDownCallForPrompt(rendered: RenderedHeadsDownCallCopy): string {
  const lines = [`HEADSDOWN CALL`, `${rendered.title}`, `${rendered.body}`];

  if (rendered.primaryLabel) {
    const primaryTransport = rendered.primaryActionKey
      ? `action=${rendered.primaryActionKey}`
      : rendered.primaryUiIntent
        ? `ui_intent=${rendered.primaryUiIntent}`
        : "display_only";
    lines.push(`Primary: ${rendered.primaryLabel} (${primaryTransport})`);
  }

  if (rendered.secondaryLabel) {
    const secondaryTransport = rendered.secondaryActionKey
      ? `action=${rendered.secondaryActionKey}`
      : rendered.secondaryUiIntent
        ? `ui_intent=${rendered.secondaryUiIntent}`
        : "display_only";
    lines.push(`Secondary: ${rendered.secondaryLabel} (${secondaryTransport})`);
  }

  if (rendered.fallbackApplied && rendered.sourceKey) {
    lines.push(`Rendered fallback for unknown call key: ${rendered.sourceKey}`);
  }

  return lines.join("\n");
}
