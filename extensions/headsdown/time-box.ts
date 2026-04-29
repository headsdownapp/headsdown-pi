export const TIME_BOX_WIND_DOWN_THRESHOLD_MS = 3 * 60 * 1000;
export const TIME_BOX_MINIMUM_WIND_DOWN_DELAY_MS = 1000;

export interface TimeBoxState {
  startedAt: number;
  windDownAt: number;
  expiresAt: number;
  windDownFired: boolean;
}

export interface TimeBoxPromptResult {
  state: TimeBoxState | null;
  instruction: string | null;
}

export function parseTimeBoxDuration(input: string): number | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const tokenPattern = /(\d+)\s*([smh])/g;
  let totalMs = 0;
  let lastIndex = 0;
  let matched = false;

  for (const match of value.matchAll(tokenPattern)) {
    const between = value.slice(lastIndex, match.index);
    if (between.trim().length > 0) return null;

    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;

    matched = true;
    lastIndex = match.index + match[0].length;

    switch (match[2]) {
      case "s":
        totalMs += amount * 1000;
        break;
      case "m":
        totalMs += amount * 60 * 1000;
        break;
      case "h":
        totalMs += amount * 60 * 60 * 1000;
        break;
    }
  }

  if (!matched || value.slice(lastIndex).trim().length > 0 || totalMs <= 0) return null;
  return totalMs;
}

export function createTimeBox(
  durationMs: number,
  now = Date.now(),
  windDownThresholdMs = TIME_BOX_WIND_DOWN_THRESHOLD_MS,
): TimeBoxState {
  const expiresAt = now + durationMs;
  const windDownAt =
    durationMs < windDownThresholdMs
      ? expiresAt
      : Math.max(now + TIME_BOX_MINIMUM_WIND_DOWN_DELAY_MS, expiresAt - windDownThresholdMs);

  return {
    startedAt: now,
    windDownAt,
    expiresAt,
    windDownFired: false,
  };
}

export function formatTimeBoxClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatTimeBoxConfirmation(state: TimeBoxState, replaced: boolean): string {
  const prefix = replaced ? "[HeadsDown] Time box replaced." : "[HeadsDown] Time box set.";
  const expires = `Expires at ${formatTimeBoxClock(state.expiresAt)}.`;

  if (state.windDownAt >= state.expiresAt) {
    return `${prefix} Wind-down skipped for boxes shorter than 3 minutes. ${expires}`;
  }

  return `${prefix} Wind-down begins at ${formatTimeBoxClock(state.windDownAt)}. ${expires}`;
}

export function formatTimeBoxStatus(state: TimeBoxState | null, now = Date.now()): string {
  if (!state) return "[HeadsDown] No active time box.";

  const started = `Declared at ${formatTimeBoxClock(state.startedAt)}.`;
  const windDown =
    state.windDownAt >= state.expiresAt
      ? "Wind-down is skipped for this short box."
      : `Wind-down begins at ${formatTimeBoxClock(state.windDownAt)}${state.windDownFired ? " (already sent)" : ""}.`;
  const expires = `Expires at ${formatTimeBoxClock(state.expiresAt)}.`;
  const remainingMs = Math.max(0, state.expiresAt - now);
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  const remaining =
    remainingMinutes <= 1 ? "Less than 1 minute left." : `${remainingMinutes} minutes left.`;

  return `[HeadsDown] Active time box. ${started} ${windDown} ${expires} ${remaining}`;
}

export function buildTimeBoxWindDownInstruction(state: TimeBoxState): string {
  return [
    "[HeadsDown] Time box wind-down.",
    `Deadline: ${formatTimeBoxClock(state.expiresAt)}.`,
    "Stop opening new threads. Summarize what has landed and what is still open, then offer to commit, stash, or write a handoff note before the deadline.",
  ].join("\n");
}

export function buildTimeBoxExpirationInstruction(expiresAt: number): string {
  return [
    "[HeadsDown] Time box expired.",
    `Deadline reached at ${formatTimeBoxClock(expiresAt)}.`,
    "Wrap up immediately. Summarize the current state and help the user leave the session cleanly.",
  ].join("\n");
}

export function advanceTimeBoxForPrompt(
  state: TimeBoxState | null,
  now = Date.now(),
): TimeBoxPromptResult {
  if (!state) return { state: null, instruction: null };

  if (now >= state.expiresAt) {
    return {
      state: null,
      instruction: buildTimeBoxExpirationInstruction(state.expiresAt),
    };
  }

  if (!state.windDownFired && state.windDownAt < state.expiresAt && now >= state.windDownAt) {
    const nextState = { ...state, windDownFired: true };
    return {
      state: nextState,
      instruction: buildTimeBoxWindDownInstruction(nextState),
    };
  }

  return { state, instruction: null };
}
