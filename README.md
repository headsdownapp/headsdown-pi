# headsdown-pi

Pi agents are powerful because they can keep working while you do something else. The problem is that they still treat you like you are always available.

HeadsDown gives [Pi agent](https://github.com/badlogic/pi-coding-agent) a simple rule: check what the human needs before interrupting them. If you are at the keyboard, Pi gets timing and scope guidance so it can finish cleanly before your attention moves elsewhere. If you are away, Pi gets autopilot guidance so it can keep moving, defer questions, and leave you a clean review note instead of stalling.

By default, HeadsDown does **not** receive prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, or message contents.

## The pitch

AI agents should not ask you every time they hit a small decision. They also should not quietly turn a small fix into a wandering refactor.

HeadsDown sits between Pi and the moment where Pi would normally ask, expand, or stop. It gives Pi enough context to choose the right next move:

- Keep going.
- Reduce the task.
- Ask for approval.
- Save the question for later.
- Wrap up with a handoff.

The goal is not to stop the agent. The goal is to keep the agent going right.

## What Pi gets

### 1. A better start for bigger work

Before Pi starts meaningful work, it can ask HeadsDown whether the run is worth starting now and how tightly it should stay scoped.

For bigger tasks, Pi can propose a short plan first: what it intends to do, roughly how long it should take, and how many files it expects to touch. Once approved, that plan becomes the guardrail for the run.

If the work grows beyond the plan, Pi warns you and asks for a new plan instead of silently expanding the task.

### 2. A warning before your time runs out

When you are actively working with Pi, HeadsDown helps Pi notice when your available time is almost up.

Pi does not stop. It gets wrap-up guidance: finish the current slice, avoid opening new threads, and save a handoff for anything deferred.

You can also set a local deadline for the current Pi session:

```text
/headsdown box 30m
```

### 3. Autopilot when you are away

When you are away, off the clock, or not available to answer turn-by-turn questions, Pi gets non-blocking autopilot guidance.

That means:

- Keep the run moving when it is safe.
- Stay inside the approved plan when one exists.
- Use the smallest safe slice when no plan has been approved yet.
- Save concise review notes for decisions that should wait for you.

This is the important part: HeadsDown does not make Pi stall faster. It helps Pi defer and continue.

### 4. Guardrails before file changes

HeadsDown can warn or block risky file changes based on your trust setting.

For example, it can warn before Pi changes sensitive paths like `.env*`, `.ssh/*`, `package.json`, `Dockerfile*`, or `.github/**`. It can also block changes when your current rules say Pi should not proceed without approval.

### 5. A local receipt when the run is done

Local Referee verifies whether a run met your repo-local completion rules. It works without a HeadsDown account and does not make required network calls.

Use it when you want a source-readable receipt for a run, without sending code, logs, paths, prompts, or message contents anywhere.

## Install

```bash
pi install git:github.com/headsdownapp/headsdown-pi
```

Or add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/headsdownapp/headsdown-pi"]
}
```

## Setup

After installing, authenticate with HeadsDown for hosted rules, proposal approvals, missed-update summaries, continuation, and reporting features:

```text
Run headsdown_auth to connect my HeadsDown account
```

Pi guides Device Flow auth. Credentials are stored at `~/.config/headsdown/credentials.json`.

Authentication is optional for Local Referee. You can verify a run locally without a HeadsDown account.

## Quick use

Check HeadsDown from Pi:

```text
/headsdown
```

Set a local time box:

```text
/headsdown box 30m
```

Inspect or clear the active time box:

```text
/headsdown box status
/headsdown box clear
```

Run Local Referee:

```text
/headsdown referee
```

Open the command menu:

```text
/headsdown menu
```

## Privacy model

HeadsDown is designed to answer routing questions without seeing the work itself.

**Sent by hosted features:** task descriptions and estimates for proposals, privacy-safe progress telemetry for approved runs, auth credentials, and actor metadata (`source`, `agentId`, `sessionId`, `workspaceRef`). Auto-thinking does not send additional data.

**Sent by Local Referee:** nothing by default. It evaluates locally and prints a local receipt.

**Received by hosted features:** current HeadsDown guidance, schedule context, approval or deferral decisions, missed-update summaries, and continuation context.

**Stored locally:** API credentials when authenticated, optional continuation artifact (`~/.config/headsdown/continuation.json`), and any repo-local Referee contract you create.

**Not sent by default:** prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, message contents, analytics, or third-party requests.

## Local Referee

Local Referee is a local checklist for verifying whether a run met your completion rules. It reads a small repo-local contract, evaluates local evidence, and prints a sanitized receipt.

Create `.headsdown/referee.json` in the workspace:

```json
{
  "version": 1,
  "checks": [
    { "type": "validation_status", "required": "passed" },
    { "type": "max_files_touched", "max": 5 },
    { "type": "max_tool_calls", "max": 10 },
    { "type": "require_tests", "required": true },
    { "type": "network_required", "required": false },
    { "type": "outcome", "required": "completed" }
  ]
}
```

Run Local Referee from Pi:

```text
/headsdown referee
```

Agents can also call the `headsdown_referee` tool with optional local evidence such as `files_touched`, `tool_calls`, `validation_status`, `tests_run`, `network_required`, `elapsed_minutes`, and `outcome`.

After high-signal runs, Local Referee can show an explicit "Share outcome summary" preview with the exact metadata categories before anything is sent. Local mode remains the default. Sharing is opt-in, workspace-scoped, and fail-closed.

Supported check types are `validation_status`, `max_files_touched`, `max_tool_calls`, `require_tests`, `network_required`, and `outcome`. `require_tests` may omit `required` as shorthand for `true`; `network_required` must always set `required` explicitly because both `true` and `false` are meaningful.

The receipt includes only derived review fields: verdict, check outcomes, broad count/time buckets, validation status, test/network booleans, outcome category, generated time, and an opaque contract reference. It does not include prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, message contents, credentials, or raw contract text.

Hosted HeadsDown remains additive. Connecting an account can add hosted rules, standing rules, mobile approval, audit/history, cross-client coordination, and outcome learning. If outcome sharing is requested while hosted sync is unavailable or the user is not signed in, the tool fails closed and keeps the run local.

## Guardrails reference

HeadsDown can warn or block file-changing tool calls through Pi's `tool_call` hook:

- `write`
- `edit`
- file-changing `bash` commands, for example `touch`, `rm`, redirection writes, and mutating git or package commands

The trust level controls how strict HeadsDown should be before Pi changes files:

| | online | busy | busy+locked | limited | offline |
|---|---|---|---|---|---|
| **advisory** (default) | allow | warn | warn | warn | warn |
| **active** | allow | allow | block | allow | block (no proposal) |
| **guarded** | allow | block (no proposal) | block | block (no proposal) | block (no proposal) |

Mode names in this table are HeadsDown technical modes. In plain English: `online` means available, `busy` means available but focused, `locked` means do not interrupt, `limited` means only some work should proceed, and `offline` means you are not available to answer.

Sensitive paths (`.env*`, `.ssh/*`, `package.json`, `Dockerfile*`, `.github/**`, etc.) always trigger warnings.

## Continuity and auto-thinking

The extension records HeadsDown continuity snapshots on:

- `session_before_compact`
- `session_before_tree`
- `session_before_switch`
- `session_shutdown`

It also auto-saves continuation artifacts for unfinished approved work when switching or ending sessions.

Auto-thinking is optional and off by default. When enabled, the extension can choose a Pi thinking level before each turn using the current prompt, active HeadsDown guidance, and approved proposal state already available locally. It does not make extra telemetry calls.

When `showStatus` is enabled, the footer shows the current automatic decision, for example `thinking:auto high` or `thinking:manual medium`.

## Commands and tools

The package registers `/headsdown` for quick checks, local verification, and session controls. Type `/headsdown ` and use tab completion to discover subcommands, `/headsdown help` for grouped usage, or `/headsdown menu` for an interactive picker.

Registered tools:

- `headsdown_auth` authenticates via Device Flow
- `headsdown_status` returns current HeadsDown guidance, schedule, wrap-up instruction, and active scope
- `headsdown_propose` submits a task proposal for approval or deferral
- `headsdown_referee` creates a local-only run verification receipt from a repo-local contract
- `headsdown_digest` reviews grouped summaries of updates received while you were not taking interruptions
- `headsdown_presets` lists or applies saved presets
- `headsdown_grants` manages delegation grants
- `headsdown_override` manages temporary overrides
- `headsdown_continuation` saves, loads, checks, or clears resumable continuation artifacts
- `headsdown_report` reports approved task outcomes

## Configuration

`~/.config/headsdown/config.json`:

```json
{
  "trustLevel": "advisory",
  "sensitivePaths": [".env*", ".ssh/*", "package.json", "Dockerfile*", ".github/**"],
  "autoThinking": {
    "enabled": false,
    "maxLevel": "high",
    "respectManualChanges": true,
    "showStatus": true,
    "allowDowngrade": false
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `trustLevel` | `"advisory"` | Controls how strict HeadsDown should be before Pi changes files. Valid values are `advisory`, `active`, and `guarded` |
| `sensitivePaths` | built-in defaults + config | Glob patterns that always warn |
| `autoThinking.enabled` | `false` | Enables HeadsDown-aware automatic Pi thinking-level selection before each turn |
| `autoThinking.maxLevel` | `"high"` | Caps the automatic selection to control cost and latency. Valid values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` |
| `autoThinking.respectManualChanges` | `true` | Preserves a later manual thinking-level change instead of immediately overriding it |
| `autoThinking.showStatus` | `true` | Shows the automatic or preserved manual thinking decision in the Pi status footer |
| `autoThinking.allowDowngrade` | `false` | Allows the policy to lower the current thinking level when the task looks simpler |

## Skill behavior

`skills/headsdown/SKILL.md` teaches Pi how to:

- check HeadsDown before non-trivial work
- ask for approval with a short plan
- slice work by the time available
- keep runs moving when the user is away or cannot answer
- ask for a new plan when work grows
- triage missed-update summaries
- persist and resume continuation artifacts
- report outcomes for future guidance

## Development

```bash
git clone https://github.com/headsdownapp/headsdown-pi.git
cd headsdown-pi
npm install
npm test
npm run typecheck
```

This repo keeps source extensions in TypeScript for local development. Pi can still load them via jiti while editing.

Published npm artifacts are built with esbuild so extension runtime code ships from `dist/extensions` with `@headsdown/sdk` inlined. Peer host packages remain external. Skills are copied to `dist/skills` so the package manifest can point Pi to the publish-time artifact layout.

Before packing or publishing, run:

```bash
npm run build
```

## Dependency update automation

This repo uses Renovate to keep `@headsdown/sdk` and other routine dependencies current. New SDK releases open bot PRs automatically, and eligible updates can automerge after required CI checks pass. In normal maintenance flow, do not manually edit `@headsdown/sdk` versions unless you are intentionally overriding Renovate behavior.

## License

MIT
