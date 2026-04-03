---
name: headsdown
description: HeadsDown availability awareness. Checks the user's focus mode, schedule, and availability before starting tasks. Submits task proposals for verdict (approved/deferred). Use before any significant work to respect the user's focus time.
---

# HeadsDown Availability Skill

This skill connects Pi to [HeadsDown](https://headsdown.app) so you're aware of the user's availability before starting work. It tells you whether the user is in focus mode, what their schedule looks like, and whether a task should proceed or be deferred.

## Setup

Run once after installing:

```bash
cd {SKILL_DIR} && npm install && npm run build
```

Then authenticate with HeadsDown:

```bash
{SKILL_DIR}/dist/cli.js auth
```

The user will see a URL and code to approve in their browser. The API key is saved to `~/.config/headsdown/credentials.json`.

## When to Use

**Before starting any non-trivial task**, check the user's availability:

1. Run `{SKILL_DIR}/dist/cli.js status` to see their current mode and schedule.
2. If they have an active contract (busy, limited, offline), run `{SKILL_DIR}/dist/cli.js propose "description of what you plan to do"` to get a verdict.
3. Follow the verdict:
   - **approved**: Proceed normally.
   - **deferred**: Tell the user the task was deferred and why. Suggest postponing or reducing scope.

**Skip the check** for trivial tasks like answering a question, reading a file, or running a quick command.

## Commands

### Check availability

```bash
{SKILL_DIR}/dist/cli.js status
```

Returns JSON with the user's current contract (mode, status, time remaining) and calendar (work hours, off hours, next workday). Parse the JSON and use it to understand context.

### Submit a task proposal

```bash
{SKILL_DIR}/dist/cli.js propose "Refactor the auth module to use JWT tokens" --files 4 --minutes 30 --scope "4 files in lib/auth" --ref "ticket-142"
```

Parameters:
- First argument (required): task description
- `--files`: estimated number of files to modify
- `--minutes`: estimated duration in minutes
- `--scope`: brief scope summary
- `--ref`: task source reference (ticket number, PR URL)

Returns JSON with the verdict (decision, reason, guidance).

### Authenticate

```bash
{SKILL_DIR}/dist/cli.js auth
```

Starts Device Flow authentication. Shows the user a URL and code to approve.

### Check authentication

```bash
{SKILL_DIR}/dist/cli.js auth-check
```

Verifies the saved credentials are valid. Returns the authenticated user's profile.

## Interpreting Results

### Availability Modes

- **online**: User is available. Proceed with tasks normally.
- **busy**: User is in deep focus. Only proceed with approved proposals. Scope work down if deferred.
- **limited**: User has reduced availability. Prefer smaller, focused tasks.
- **offline**: User is away. Defer all non-trivial work.

### Verdict Decisions

- **approved**: The task fits within the user's current availability. Proceed.
- **deferred**: The task should wait or be reduced in scope. Tell the user why and what to do instead.

## Error Handling

If the CLI returns an error:
- **"Not authenticated"**: Run `{SKILL_DIR}/dist/cli.js auth` to connect.
- **"API key is invalid"**: Run `{SKILL_DIR}/dist/cli.js auth` to re-authenticate.
- **"Could not reach HeadsDown"**: Network issue. Try again shortly.
- **Exit code 1**: Something went wrong. The error message explains what.
