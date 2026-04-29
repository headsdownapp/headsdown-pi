---
name: headsdown
description: HeadsDown availability awareness. Checks the user's focus mode and schedule before significant work, submits proposals for verdicts, tracks scope drift during execution, and preserves resumable continuity when sessions branch, compact, or pause.
---

# HeadsDown Availability Skill

This skill connects you to [HeadsDown](https://headsdown.app) so you're aware of user availability before, during, and after non-trivial work.

## Available Tools

Use these tools directly:

- `headsdown_referee`: local-only run verification from a repo-local contract; no account required
- `headsdown_status`: current mode, schedule context, wrap-up instruction, active proposal scope
- `headsdown_presets`: list or apply saved availability presets
- `headsdown_propose`: submit a task proposal for approved/deferred verdict
- `headsdown_digest`: review notifications/messages that arrived during focus windows
- `headsdown_grants`: list/create/revoke delegation grants
- `headsdown_override`: get/set/clear temporary availability override
- `headsdown_continuation`: save/load/check/clear resumable continuation artifacts
- `headsdown_report`: report approved task outcome for calibration
- `headsdown_auth`: authenticate when other tools fail with auth errors

## Required Flow For Significant Work

Before any non-trivial coding task:

1. Call `headsdown_status`.
2. If mode is `busy`, `limited`, or `offline`, call `headsdown_propose` with clear scope and estimates.
3. Respect the verdict:
   - `approved`: proceed.
   - `deferred`: tell the user and offer a reduced-scope slice.

Skip this flow only for trivial actions like quick reads or simple clarifications. The local Referee path is also account-optional: use `headsdown_referee` or `/headsdown referee` when the user asks for local verification without hosted HeadsDown.

## Mode Semantics

- `online`: proceed normally after status/proposal checks.
- `busy`: prefer approved scope and avoid unnecessary expansion.
- `limited`: keep work focused and slice aggressively.
- `offline`: defer non-trivial work unless explicitly approved.

## Time-Aware Slicing

Use the schedule and wrap-up guidance from `headsdown_status`:

- If the window is tight, propose only a shippable slice.
- Prefer natural boundaries (module, layer, test pass) over arbitrary partial work.
- Keep each slice independently valid and reviewable.

## Local Session Time Boxes

When the user declares a session time box with `/headsdown box <duration>`, treat it as local prompt guidance for landing cleanly inside the window. Examples include `/headsdown box 15m`, `/headsdown box 1h`, `/headsdown box 90m`, and `/headsdown box 1h30m`.

- `/headsdown box status`: inspect the active box, including declaration, wind-down, and expiration times.
- `/headsdown box clear`: cancel the active box.
- Wind-down guidance is prompt-only. It tells you to stop opening new threads, summarize landed and open work, and offer to commit, stash, or write a handoff note.
- Expiration guidance asks you to wrap up immediately and clears the box.
- Short boxes can skip wind-down and go straight to expiration.
- Time boxes are local-only, account-optional, and non-blocking. They do not block tools or create hosted HeadsDown state.

## Mid-Task Scope Drift

If realized edits exceed the approved estimate, pause and re-propose with updated `estimated_files`, `estimated_minutes`, and `scope_summary`. Do not silently overrun approved scope.

If HeadsDown reports `rabbit_hole_detected`, follow this structure:

- Call: Rabbit hole detected.
- Trap: work drifted past approved scope or entered a low-progress loop.
- Play: stop mutating edits, save the handoff, then choose one valid backend action while the call is still `rabbit_hole_detected`: `/headsdown pause` to apply `pause_and_summarize`, or `/headsdown allow 15` to apply `allow_for_duration` instead.
- Escalation: do not apply `allow_for_duration` after pause; once paused, resume later with a valid ready-to-resume action.

If the user says the rabbit-hole call is wrong for the current session, use the local session controls instead of changing global settings. Use `/headsdown help` for grouped command usage or `/headsdown menu` for an interactive picker when the exact subcommand is unclear.

- `/headsdown rabbit-hole off`: disable hard stops for this session while keeping soft keep-it-tight guidance.
- `/headsdown rabbit-hole quiet`: suppress hard stops and repeated rabbit-hole guidance for this session.
- `/headsdown rabbit-hole on`: restore normal rabbit-hole handling for future calls in this session.
- `/headsdown rabbit-hole status`: show the active mode. Status must distinguish normal handling, hard-stop-disabled mode, and quiet mode.

Progress telemetry continues in all rabbit-hole session modes, and other HeadsDown policies still apply.

## Digest Triage

When a session starts with pending digest summaries, or when the user asks what they missed:

1. Call `headsdown_digest`.
2. Summarize by source and actor.
3. Prioritize items related to current work.
4. Offer to convert actionable items into proposals.

## Continuation And Session Boundaries

When pausing work, switching sessions, or wrapping up with unfinished approved scope:

- Save a continuation artifact with `headsdown_continuation` action `save`.
- On next session, load it with action `load` and resume from the first pending step.
- Clear stale artifacts with action `clear` when no longer needed.

## Outcome Reporting

After finishing approved work, call `headsdown_report` with `completed`, `failed`, `partially_completed`, `cancelled`, or `timed_out`. Include `error_category` for failures and `tests_passed` when known.

## Presets And Overrides

- Use `headsdown_presets` only when the user explicitly asks to change mode.
- Use `headsdown_override` for temporary one-off mode changes.
- Respect locked status and never force mode changes.

## Local Referee

Use `headsdown_referee` or `/headsdown referee` to verify a run locally from `.headsdown/referee.json`. This path does not require HeadsDown credentials and should not be treated as hosted sync or outcome sharing. The receipt contains derived review fields only: verdict, check outcomes, broad buckets, validation status, test/network booleans, outcome category, generated time, and an opaque contract reference. Do not include prompts, code, file paths, repository names, branch names, terminal output, logs, or message contents in local receipt text.

## Authentication And Failures

- Auth errors: call `headsdown_auth`.
- Network/API errors: inform the user and proceed cautiously without availability automation.
- Session-token-only grant errors: explain that delegation grant management is unavailable for API-key auth paths.
