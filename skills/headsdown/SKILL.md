---
name: headsdown
description: HeadsDown availability awareness. Checks the user's focus mode and availability schedule before starting tasks. Submits task proposals for verdict (approved/deferred). Use before any significant work to respect the user's focus time.
---

# HeadsDown Availability Skill

This skill connects you to [HeadsDown](https://headsdown.app) so you're aware of the user's availability before starting work.

## Available Tools

This package registers seven tools. Use them directly via tool calls:

- **headsdown_status**: Check current availability (mode, schedule, time remaining)
- **headsdown_presets**: List saved presets or apply one to change mode quickly
- **headsdown_propose**: Submit a task proposal for verdict (approved/deferred)
- **headsdown_grants**: List/create/revoke delegation grants for actor-scoped access
- **headsdown_override**: Get/set/clear temporary availability overrides
- **headsdown_report**: Report the outcome of a completed task (completed/failed/etc.)
- **headsdown_auth**: Authenticate with HeadsDown via Device Flow

## When to Check

**Before starting any non-trivial task**, check the user's availability:

1. Call `headsdown_status` to see their current mode and availability schedule.
2. If they have an active contract (especially busy, limited, or offline), call `headsdown_propose` with a clear description of what you plan to do.
3. Follow the verdict:
   - **approved**: Proceed normally.
   - **deferred**: Tell the user the task was deferred and why. Suggest postponing or reducing scope.

**Skip the check** for trivial tasks like answering a question, reading a file, or running a quick command.

## Presets

If the user explicitly asks to change their mode (for example, "set me to deep focus"), use `headsdown_presets`:

- `action: "list"` to show available presets
- `action: "apply"` with `id` or `name` to activate one

Never apply a preset unless the user clearly asked to change availability.

If the user asks about delegated control for session/workspace operations, use `headsdown_grants`. If the user asks for a one-off temporary mode change (without changing presets), use `headsdown_override`.

## Interpreting Availability

### Modes

- **online**: User is available. Proceed with tasks normally.
- **busy**: User is in deep focus. Only proceed with approved proposals. Scope work down if deferred.
- **limited**: User has reduced availability. Prefer smaller, focused tasks.
- **offline**: User is away. Defer all non-trivial work.

### Schedule Context

The status returns schedule information from availability:

- **Within reachable hours**: User is in their normal reachable window.
- **Outside reachable hours**: User is currently outside their reachable window.
- **Next transition**: When their schedule is expected to change next.

### Locked Status

If the status shows `lock: true`, the user explicitly does not want their mode changed. Respect this.

## Verdict Decisions

When you submit a proposal via `headsdown_propose`:

- **approved**: The task fits within the user's current availability. Start working.
- **deferred**: The task should wait. Tell the user what the verdict was and why, then suggest postponing or offer to scope the task down.

## Reporting Outcomes

After completing work on an approved task, report the outcome:

1. Call `headsdown_report` with the outcome: `completed`, `failed`, `partially_completed`, `cancelled`, or `timed_out`.
2. If the task failed, include an `error_category` (e.g., "test_failure", "compilation_error").
3. If you ran tests, include `tests_passed: true/false`.

This calibration data helps HeadsDown learn how long tasks actually take and how often they succeed, making future verdicts more accurate.

## Authentication

If any tool returns an authentication error, call `headsdown_auth`. The user will see a URL and code to approve in their browser.

## Error Handling

- **"Not authenticated"**: Call `headsdown_auth` to connect.
- **"API key is invalid"**: Call `headsdown_auth` to re-authenticate.
- **Network errors**: Inform the user and proceed without availability data.
