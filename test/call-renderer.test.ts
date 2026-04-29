import { describe, expect, it } from "vitest";
import {
  CANONICAL_HEADSDOWN_CALL_KEYS,
  formatHeadsDownCallForPrompt,
  renderHeadsDownCallCopy,
  resolveUnknownHeadsDownCallFallback,
} from "../extensions/headsdown/call-renderer.js";

describe("renderHeadsDownCallCopy", () => {
  it("renders every active canonical HeadsDown call key", () => {
    for (const key of CANONICAL_HEADSDOWN_CALL_KEYS) {
      if (key === "rabbit_hole_detected") continue;

      const rendered = renderHeadsDownCallCopy({ key });
      expect(rendered?.key).toBe(key);
      expect(rendered?.fallbackApplied).toBe(false);
      expect(rendered?.sourceKey).toBe(key);
      expect(rendered?.title.length).toBeGreaterThan(0);
      expect(rendered?.body.length).toBeGreaterThan(0);
      expect(rendered?.secondaryLabel).toBeTruthy();
    }
  });

  it("treats legacy rabbit_hole_detected calls as no-op render events", () => {
    expect(renderHeadsDownCallCopy({ key: "rabbit_hole_detected" })).toBeNull();
    expect(renderHeadsDownCallCopy({ key: "RABBIT_HOLE_DETECTED" })).toBeNull();
  });

  it("keeps backend action keys and UI intents separate for needs_your_yes", () => {
    const rendered = renderHeadsDownCallCopy({ key: "needs_your_yes" });

    expect(rendered?.primaryLabel).toBe("Review request");
    expect(rendered?.primaryActionKey).toBeNull();
    expect(rendered?.primaryUiIntent).toBe("review_request");
    expect(rendered?.secondaryLabel).toBe("Keep queued");
    expect(rendered?.secondaryActionKey).toBe("keep_queued");
    expect(rendered?.secondaryUiIntent).toBeNull();
  });

  it("keeps all_contained display-only (no primary action)", () => {
    const rendered = renderHeadsDownCallCopy({ key: "all_contained" });

    expect(rendered?.primaryLabel).toBeNull();
    expect(rendered?.primaryActionKey).toBeNull();
    expect(rendered?.primaryUiIntent).toBeNull();
    expect(rendered?.secondaryLabel).toBe("Why this call?");
    expect(rendered?.secondaryUiIntent).toBe("view_details");
  });

  it("normalizes GraphQL enum-style canonical call keys", () => {
    const rendered = renderHeadsDownCallCopy({ key: "READY_TO_RESUME" });

    expect(rendered?.key).toBe("ready_to_resume");
    expect(rendered?.fallbackApplied).toBe(false);
    expect(rendered?.primaryActionKey).toBe("resume_run");
  });

  it("renders finish_line_friction with delivery-specific copy", () => {
    const rendered = renderHeadsDownCallCopy({ key: "finish_line_friction" });

    expect(rendered?.key).toBe("finish_line_friction");
    expect(rendered?.fallbackApplied).toBe(false);
    expect(rendered?.title).toBe("Finish-line friction");
    expect(rendered?.body).toContain("validation or delivery is stuck");
    expect(rendered?.body).not.toContain("growing past the size");
    expect(rendered?.primaryActionKey).toBe("pause_and_summarize");
    expect(rendered?.secondaryActionKey).toBe("allow_for_duration");
  });

  it("renders off_the_clock with queue_for_morning and approved off-clock copy", () => {
    const rendered = renderHeadsDownCallCopy({ key: "off_the_clock" });

    expect(rendered?.title).toBe("Off the clock");
    expect(rendered?.primaryLabel).toBe("Queued for morning");
    expect(rendered?.primaryActionKey).toBe("queue_for_morning");
    expect(rendered?.body).toContain("Your night stays yours");
  });

  it("falls back to needs_your_yes for unknown action/risk/boundary signals", () => {
    const rendered = renderHeadsDownCallCopy({
      key: "future_call_key",
      fallbackSignals: { boundarySignal: true },
    });

    expect(rendered?.fallbackApplied).toBe(true);
    expect(rendered?.key).toBe("needs_your_yes");
    expect(rendered?.body).toBe("HeadsDown needs a human decision before this agent continues.");
    expect(rendered?.primaryActionKey).toBeNull();
    expect(rendered?.primaryUiIntent).toBe("review_request");
    expect(rendered?.secondaryActionKey).toBeNull();
    expect(rendered?.secondaryUiIntent).toBe("view_details");
  });

  it("falls back to keep_it_tight for unknown limit/scope/validation uncertainty", () => {
    const rendered = renderHeadsDownCallCopy({
      key: "future_call_key",
      fallbackSignals: { validationUncertainty: true },
    });

    expect(rendered?.fallbackApplied).toBe(true);
    expect(rendered?.key).toBe("keep_it_tight");
    expect(rendered?.body).toContain("useful slice");
    expect(rendered?.primaryLabel).toBe("Why this call?");
    expect(rendered?.primaryActionKey).toBeNull();
    expect(rendered?.primaryUiIntent).toBe("view_details");
    expect(rendered?.secondaryLabel).toBeNull();
    expect(rendered?.secondaryActionKey).toBeNull();
    expect(rendered?.secondaryUiIntent).toBeNull();
  });

  it("falls back to all_contained only with explicit no-action and in-bounds signals", () => {
    const rendered = renderHeadsDownCallCopy({
      key: "future_call_key",
      fallbackSignals: { noActionNeededExplicit: true, inBoundsExplicit: true },
    });

    expect(rendered?.fallbackApplied).toBe(true);
    expect(rendered?.key).toBe("all_contained");
    expect(rendered?.body).toContain("Nothing needs you right now");
    expect(rendered?.primaryLabel).toBeNull();
    expect(rendered?.secondaryLabel).toBe("Why this call?");
    expect(rendered?.secondaryUiIntent).toBe("view_details");
  });

  it("prefers needs_your_yes over all_contained when signals conflict", () => {
    const rendered = renderHeadsDownCallCopy({
      key: "future_call_key",
      fallbackSignals: {
        actionRequired: true,
        noActionNeededExplicit: true,
        inBoundsExplicit: true,
      },
    });

    expect(rendered?.key).toBe("needs_your_yes");
  });

  it("falls back to needs_your_yes for spend and external side-effect signals", () => {
    expect(
      renderHeadsDownCallCopy({
        key: "future_call_key",
        fallbackSignals: { spendSignal: true },
      })?.key,
    ).toBe("needs_your_yes");

    expect(
      renderHeadsDownCallCopy({
        key: "future_call_key",
        fallbackSignals: { externalSideEffectSignal: true },
      })?.key,
    ).toBe("needs_your_yes");
  });

  it("uses server-provided title/body on unknown fallback when present", () => {
    const rendered = renderHeadsDownCallCopy({
      key: "future_call_key",
      title: "Server call title",
      body: "Server call body",
      fallbackSignals: { limitSignal: true },
    });

    expect(rendered?.key).toBe("keep_it_tight");
    expect(rendered?.title).toBe("Server call title");
    expect(rendered?.body).toBe("Server call body");
  });

  it("formats prompt/output copy for Pi with explicit action vs UI intent transport", () => {
    const rendered = renderHeadsDownCallCopy({ key: "needs_your_yes" });
    expect(rendered).not.toBeNull();
    const output = formatHeadsDownCallForPrompt(rendered!);

    expect(output).toContain("HEADSDOWN CALL");
    expect(output).toContain("Needs your yes");
    expect(output).toContain("Primary: Review request (ui_intent=review_request)");
    expect(output).toContain("Secondary: Keep queued (action=keep_queued)");
  });
});

describe("resolveUnknownHeadsDownCallFallback", () => {
  it("defaults to needs_your_yes when no explicit fallback signals exist", () => {
    expect(resolveUnknownHeadsDownCallFallback()).toBe("needs_your_yes");
  });
});
