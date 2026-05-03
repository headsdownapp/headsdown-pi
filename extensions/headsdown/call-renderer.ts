import {
  HEADSDOWN_CALL_KEYS,
  isHeadsDownActionKey,
  isHeadsDownCallKey,
  renderHeadsDownCallForAgent,
  type AgentRenderedAction,
} from "@headsdown/sdk/agent";
import type {
  AgentControlUiIntent,
  HeadsDownActionKey as SdkHeadsDownActionKey,
  HeadsDownCall,
  HeadsDownCallKey,
} from "@headsdown/sdk";

export const CANONICAL_HEADSDOWN_CALL_KEYS = HEADSDOWN_CALL_KEYS;
export type CanonicalHeadsDownCallKey = HeadsDownCallKey;
export type RenderableHeadsDownCallKey = HeadsDownCallKey;
export type HeadsDownActionKey = SdkHeadsDownActionKey;
export type HeadsDownUiIntent = Exclude<AgentControlUiIntent, "none">;

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
  recommendedActionKey?: HeadsDownActionKey | string | null;
  allowedActionKeys?: readonly (HeadsDownActionKey | string)[] | null;
  reasonCodes?: readonly string[] | null;
  privacyMode?: string | null;
  fallbackSignals?: UnknownCallFallbackSignals;
}

export interface RenderedHeadsDownCallCopy extends RenderLabels {
  key: RenderableHeadsDownCallKey;
  sourceKey: string | null;
  fallbackApplied: boolean;
}

type PromptActionDefaults = Pick<
  RenderLabels,
  | "primaryLabel"
  | "primaryActionKey"
  | "primaryUiIntent"
  | "secondaryLabel"
  | "secondaryActionKey"
  | "secondaryUiIntent"
>;

const DEFAULT_PROMPT_ACTIONS: Record<HeadsDownCallKey, PromptActionDefaults> = {
  good_to_run: {
    primaryLabel: null,
    primaryActionKey: "continue",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  keep_it_tight: {
    primaryLabel: null,
    primaryActionKey: "narrow_scope",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  attention_window_closing: {
    primaryLabel: null,
    primaryActionKey: "allow_for_duration",
    primaryUiIntent: null,
    secondaryLabel: null,
    secondaryActionKey: "pause_and_summarize",
    secondaryUiIntent: null,
  },
  not_worth_starting_now: {
    primaryLabel: null,
    primaryActionKey: "queue_for_later",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  off_the_clock: {
    primaryLabel: null,
    primaryActionKey: "queue_for_morning",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  finish_line_friction: {
    primaryLabel: null,
    primaryActionKey: "pause_and_summarize",
    primaryUiIntent: null,
    secondaryLabel: null,
    secondaryActionKey: "allow_for_duration",
    secondaryUiIntent: null,
  },
  rabbit_hole_detected: {
    primaryLabel: null,
    primaryActionKey: "pause_and_summarize",
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  ready_to_resume: {
    primaryLabel: null,
    primaryActionKey: "resume_run",
    primaryUiIntent: null,
    secondaryLabel: null,
    secondaryActionKey: "keep_queued",
    secondaryUiIntent: null,
  },
  all_contained: {
    primaryLabel: null,
    primaryActionKey: null,
    primaryUiIntent: null,
    secondaryLabel: "Why this call?",
    secondaryActionKey: null,
    secondaryUiIntent: "view_details",
  },
  needs_your_yes: {
    primaryLabel: "Review request",
    primaryActionKey: null,
    primaryUiIntent: "review_request",
    secondaryLabel: null,
    secondaryActionKey: "keep_queued",
    secondaryUiIntent: null,
  },
};

export function resolveUnknownHeadsDownCallFallback(
  signals?: UnknownCallFallbackSignals,
): RenderableHeadsDownCallKey {
  return renderHeadsDownCallForAgent(
    toSdkHeadsDownCall({ key: "unknown", fallbackSignals: signals }),
  ).callKey;
}

export function renderHeadsDownCallCopy(
  input: RenderHeadsDownCallInput,
): RenderedHeadsDownCallCopy | null {
  const normalizedKey = normalizeCallKey(input.key);
  const rendered = renderHeadsDownCallForAgent(toSdkHeadsDownCall(input));
  const defaults = DEFAULT_PROMPT_ACTIONS[rendered.callKey];
  const primary = promptAction(rendered.primaryAction, defaults, "primary");
  const secondary = promptAction(rendered.secondaryAction, defaults, "secondary");

  return {
    key: rendered.callKey,
    sourceKey:
      rendered.fallbackReason === "known_key"
        ? rendered.callKey
        : normalizedKey.length > 0
          ? normalizedKey
          : null,
    fallbackApplied: rendered.fallbackReason !== "known_key",
    title: rendered.title,
    body: rendered.body,
    primaryLabel: primary.label,
    primaryActionKey: primary.actionKey,
    primaryUiIntent: primary.uiIntent,
    secondaryLabel: secondary.label,
    secondaryActionKey: secondary.actionKey,
    secondaryUiIntent: secondary.uiIntent,
  };
}

function toSdkHeadsDownCall(input: RenderHeadsDownCallInput): HeadsDownCall {
  const normalizedKey = normalizeCallKey(input.key);
  const knownKey = normalizedKey && isHeadsDownCallKey(normalizedKey) ? normalizedKey : null;
  const signalFields = fallbackSignalFields(input.fallbackSignals);
  const defaults = knownKey ? DEFAULT_PROMPT_ACTIONS[knownKey] : null;
  const inputAllowedActions = normalizeActionKeys(input.allowedActionKeys);
  const defaultAllowedActions = defaults ? defaultActionKeys(defaults) : [];
  const allowedActionKnownKeys =
    inputAllowedActions.length > 0 ? inputAllowedActions : defaultAllowedActions;
  const recommendedActionKnownKey =
    normalizeActionKey(input.recommendedActionKey) ?? defaults?.primaryActionKey ?? null;
  const secondaryActionKnownKey = defaults?.secondaryActionKey ?? null;

  return {
    key: normalizedKey || cleanText(input.key) || "unknown",
    knownKey,
    title: cleanText(input.title) ?? "",
    body: cleanText(input.body) ?? "",
    severity: signalFields.severity,
    urgency: signalFields.urgency,
    primaryActionLabel: null,
    primaryActionKey: recommendedActionKnownKey,
    primaryActionKnownKey: recommendedActionKnownKey,
    primaryActionIntent: defaults?.primaryUiIntent ?? "none",
    secondaryActionLabel: null,
    secondaryActionKey: secondaryActionKnownKey,
    secondaryActionKnownKey,
    secondaryActionIntent: defaults?.secondaryUiIntent ?? "none",
    recommendedActionKey: recommendedActionKnownKey,
    recommendedActionKnownKey,
    allowedActionKeys: allowedActionKnownKeys,
    allowedActionKnownKeys,
    allowedUiIntents: signalFields.allowedUiIntents,
    reasonCodes: [...normalizeReasonCodes(input.reasonCodes), ...signalFields.reasonCodes],
    confidence: signalFields.confidence,
    evidenceSource: "fallback",
    privacyMode: normalizePrivacyMode(input.privacyMode),
    expiresAt: null,
  };
}

function fallbackSignalFields(
  signals?: UnknownCallFallbackSignals,
): Pick<HeadsDownCall, "severity" | "urgency" | "confidence" | "allowedUiIntents" | "reasonCodes"> {
  const actionRequired =
    signals?.actionRequired === true ||
    signals?.approvalRequired === true ||
    signals?.riskSignal === true ||
    signals?.boundarySignal === true ||
    signals?.spendSignal === true ||
    signals?.externalSideEffectSignal === true ||
    signals?.escalationSignal === true;

  if (actionRequired) {
    return {
      severity: "action_required",
      urgency: "high",
      confidence: "exact",
      allowedUiIntents: ["review_request"],
      reasonCodes: ["human_decision"],
    };
  }

  const constrained =
    signals?.limitSignal === true ||
    signals?.scopeUncertainty === true ||
    signals?.validationUncertainty === true ||
    signals?.lowConfidence === true;

  if (constrained) {
    return {
      severity: "caution",
      urgency: "normal",
      confidence: "estimated",
      allowedUiIntents: [],
      reasonCodes: ["scope_uncertain"],
    };
  }

  if (signals?.noActionNeededExplicit === true && signals?.inBoundsExplicit === true) {
    return {
      severity: "neutral",
      urgency: "normal",
      confidence: "exact",
      allowedUiIntents: [],
      reasonCodes: [
        "no_action_needed",
        "runs_within_bounds",
        "zero_pending_asks",
        "limits_holding",
      ],
    };
  }

  return {
    severity: "neutral",
    urgency: "normal",
    confidence: "exact",
    allowedUiIntents: [],
    reasonCodes: [],
  };
}

function promptAction(
  rendered: AgentRenderedAction | null,
  defaults: PromptActionDefaults,
  slot: "primary" | "secondary",
): {
  label: string | null;
  actionKey: HeadsDownActionKey | null;
  uiIntent: HeadsDownUiIntent | null;
} {
  if (rendered) {
    return { label: rendered.label, actionKey: rendered.key, uiIntent: null };
  }

  return slot === "primary"
    ? {
        label: defaults.primaryLabel ?? actionLabel(defaults.primaryActionKey),
        actionKey: defaults.primaryActionKey,
        uiIntent: defaults.primaryUiIntent,
      }
    : {
        label: defaults.secondaryLabel ?? actionLabel(defaults.secondaryActionKey),
        actionKey: defaults.secondaryActionKey,
        uiIntent: defaults.secondaryUiIntent,
      };
}

function actionLabel(actionKey: HeadsDownActionKey | null): string | null {
  switch (actionKey) {
    case "continue":
      return "Continue";
    case "continue_with_limit":
      return "Continue with limit";
    case "narrow_scope":
      return "Narrow scope";
    case "ask_user":
      return "Ask user";
    case "queue_for_later":
      return "Queue for later";
    case "queue_for_morning":
      return "Queue for morning";
    case "pause_and_summarize":
      return "Pause and summarize";
    case "stop_run":
      return "Stop run";
    case "resume_run":
      return "Resume run";
    case "allow_once":
      return "Allow once";
    case "allow_for_duration":
      return "Allow for duration";
    case "create_temporary_exception":
      return "Create temporary exception";
    case "keep_queued":
      return "Keep queued";
    default:
      return null;
  }
}

function defaultActionKeys(defaults: PromptActionDefaults): HeadsDownActionKey[] {
  return [defaults.primaryActionKey, defaults.secondaryActionKey].filter(
    (value): value is HeadsDownActionKey => value !== null,
  );
}

function normalizeActionKeys(
  values: readonly (HeadsDownActionKey | string)[] | null | undefined,
): HeadsDownActionKey[] {
  if (!values || values.length === 0) return [];
  return [
    ...new Set(
      values.map(normalizeActionKey).filter((value): value is HeadsDownActionKey => !!value),
    ),
  ];
}

function normalizeActionKey(
  value: HeadsDownActionKey | string | null | undefined,
): HeadsDownActionKey | null {
  const normalized = normalizeCallKey(value);
  return normalized && isHeadsDownActionKey(normalized) ? normalized : null;
}

function normalizeReasonCodes(values: readonly string[] | null | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values.map(cleanText).filter((value): value is string => !!value))];
}

function normalizePrivacyMode(value: string | null | undefined): HeadsDownCall["privacyMode"] {
  const normalized = normalizeCallKey(value);

  switch (normalized) {
    case "privacy_safe":
    case "privacy_restricted":
    case "unknown":
      return normalized;
    default:
      return "unknown";
  }
}

function normalizeCallKey(key: string | null | undefined): string {
  return (
    key
      ?.trim()
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .replace(/[\s-]+/g, "_")
      .replace(/__+/g, "_")
      .toLowerCase() ?? ""
  );
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\r\n\t]+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
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
