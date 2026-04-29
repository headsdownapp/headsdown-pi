# headsdown-pi

[HeadsDown](https://headsdown.app) availability package for [Pi agent](https://github.com/badlogic/pi-coding-agent). It gives Pi deep availability awareness across the full task lifecycle: planning, execution, scope drift, compaction, branching, and session handoff.

When installed, Pi will:
1. **Know your availability continuously** via cached status + turn-level execution policy injection
2. **Check before significant work** with native status/proposal tools and skill guidance
3. **Gate mutating actions** on `write`, `edit`, and mutating `bash` commands using trust levels
4. **Track realized scope drift** from successful file mutations against approved proposal estimates
5. **Preserve continuity** across compaction, tree navigation, and session shutdown/switch
6. **Support resumable work** with continuation artifacts and digest triage for missed updates
7. **Optionally tune pi thinking level** before each turn with a configurable HeadsDown-aware auto-thinking policy

## Install

```bash
pi install git:github.com/headsdownapp/headsdown-pi
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/headsdownapp/headsdown-pi"]
}
```

## Setup

After installing, authenticate with HeadsDown for hosted availability, proposal, digest, continuation, and reporting features:

> "Run headsdown_auth to connect my HeadsDown account"

Pi guides Device Flow auth. Credentials are stored at `~/.config/headsdown/credentials.json`.

Authentication is optional for the local Referee path below. You can verify a run locally without a HeadsDown account.

## Local Referee (account optional)

Local Referee is a local-only verification path for source-readable run receipts. It reads a small repo-local completion contract, evaluates local evidence, and prints a sanitized receipt. It does not require HeadsDown credentials and does not make required network calls.

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

Run the local Referee from Pi:

```text
/headsdown referee
```

After high-signal runs, Local Referee can show an explicit "Share outcome summary" preview with the exact metadata categories before anything is sent. Local mode remains the default. Sharing is opt-in, workspace-scoped, and fail-closed.

Agents can call the `headsdown_referee` tool with optional local evidence such as `files_touched`, `tool_calls`, `validation_status`, `tests_run`, `network_required`, `elapsed_minutes`, and `outcome`. The tool also supports optional consent controls: `share_outcome` (`preview`, `share_once`, `always_share`, `keep_local`), `confirm_share_preview`, and `share_preview_token` from a prior preview call. Persistent `always_share` consent is stored only after a confirmed share succeeds; it is scoped per workspace and bound to the current outcome-summary privacy boundary version.

If `files_touched` is omitted, the runner counts changed entries from local `git status --short --untracked-files=all` and stores only the count bucket in the receipt. If Git status is unavailable, pass `files_touched` explicitly so the receipt does not silently undercount local changes.

Supported check types are `validation_status`, `max_files_touched`, `max_tool_calls`, `require_tests`, `network_required`, and `outcome`. `require_tests` may omit `required` as shorthand for `true`; `network_required` must always set `required` explicitly because both `true` and `false` are meaningful.

The receipt includes only derived review fields: verdict, check outcomes, broad count/time buckets, validation status, test/network booleans, outcome category, generated time, and an opaque contract reference. It does not include prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, message contents, credentials, or raw contract text.

Hosted HeadsDown remains additive. Connecting an account can add hosted availability policy, standing rules, mobile approval, audit/history, cross-client coordination, and outcome learning. If outcome sharing is requested while hosted sync is unavailable or the user is not signed in, the tool fails closed and keeps the run local. The local Referee receipt works without hosted features.

## Extension Features

### Policy Injection and Session UI

The extension injects concise HeadsDown policy context into the active turn system prompt and updates UI status/widget lines with mode, schedule summary, wrap-up guidance, and active proposal scope.

### Mutating Tool Gating

The extension intercepts mutating tool calls via `tool_call`:

- `write`
- `edit`
- mutating `bash` commands (for example `touch`, `rm`, redirection writes, mutating git/package commands)

Trust policy matrix:

| | online | busy | busy+locked | limited | offline |
|---|---|---|---|---|---|
| **advisory** (default) | allow | warn | warn | warn | warn |
| **active** | allow | allow | block | allow | block (no proposal) |
| **guarded** | allow | block (no proposal) | block | block (no proposal) | block (no proposal) |

Sensitive paths (`.env*`, `.ssh/*`, `package.json`, `Dockerfile*`, `.github/**`, etc.) always trigger warnings.

### Scope Drift Tracking

On `tool_result`, successful `write`/`edit` operations are tracked as realized modified files for the active approved proposal. If touched files exceed the approved estimate by more than 50%, Pi emits a scope-drift warning and prompts re-proposal.

### Session Time Box

Use `/headsdown box <duration>` to declare a local time box for the current Pi session. Examples:

- `/headsdown box 15m`
- `/headsdown box 1h`
- `/headsdown box 90m`
- `/headsdown box 1h30m`

Pi confirms the wind-down moment and expiration moment as clock times. Declaring a new box replaces the active box; only one box is active per session.

With about three minutes left, the next Pi turn gets prompt-only wind-down guidance: stop opening new threads, summarize what has landed and what is still open, and offer to commit, stash, or write a handoff note. When the box expires, the next Pi turn gets a clear wrap-up-now instruction and the box clears. Short boxes under the wind-down threshold skip wind-down and go straight to expiration.

Inspect or cancel the active box at any time:

- `/headsdown box status`
- `/headsdown box clear`

Time boxes are local-only, account-optional, and non-blocking. They do not block tools, create hosted state, or change HeadsDown call/play behavior.

### Auto-Thinking Policy

Auto-thinking is an optional policy that lets the extension choose a pi thinking level before each agent turn. It uses the current prompt, active HeadsDown availability context, and approved proposal state that the extension already has locally. It does not make extra telemetry calls.

The feature is off by default. When enabled, it can raise thinking for complex implementation, debugging, design, busy, unavailable, or full-depth contexts. By default it does not aggressively lower a higher current thinking level, and it preserves manual user changes after the extension has applied an automatic level.

When `showStatus` is enabled, the footer shows the current automatic decision, for example `thinking:auto high` or `thinking:manual medium`.

### Continuity Hooks

The extension records HeadsDown continuity snapshots on:

- `session_before_compact`
- `session_before_tree`
- `session_before_switch`
- `session_shutdown`

It also auto-saves continuation artifacts for unfinished approved work when switching or ending sessions.

### Registered Tools

- `headsdown_referee` - local-only run verification receipt from a repo-local contract; no account required
- `headsdown_status` - current availability, schedule, wrap-up instruction, active scope
- `headsdown_presets` - list/apply saved presets
- `headsdown_propose` - submit task proposal for approved/deferred verdict
- `headsdown_digest` - review grouped summaries of updates received during focus windows
- `headsdown_grants` - manage delegation grants
- `headsdown_override` - manage temporary availability overrides
- `headsdown_continuation` - save/load/check/clear resumable continuation artifacts
- `headsdown_report` - report approved task outcome
- `headsdown_auth` - authenticate via Device Flow

The package also registers `/headsdown` for quick status checks, local Referee verification, and session controls. Type `/headsdown ` and use tab completion to discover subcommands, `/headsdown help` for grouped usage, or `/headsdown menu` for an interactive picker. Local verification uses `/headsdown referee`. Session controls include `/headsdown box <duration|status|clear>` for local session time boxes.

## Skill

`skills/headsdown/SKILL.md` teaches Pi how to:

- run status/proposal flow before non-trivial work
- slice work by available time windows
- re-propose when scope drifts
- triage digest updates
- persist/resume continuation artifacts
- report outcomes for calibration

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
| `trustLevel` | `"advisory"` | `advisory`, `active`, or `guarded` |
| `sensitivePaths` | built-in defaults + config | Glob patterns that always warn |
| `autoThinking.enabled` | `false` | Enables HeadsDown-aware automatic pi thinking-level selection before each turn |
| `autoThinking.maxLevel` | `"high"` | Caps the automatic selection to control cost and latency; valid values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` |
| `autoThinking.respectManualChanges` | `true` | Preserves a later manual thinking-level change instead of immediately overriding it |
| `autoThinking.showStatus` | `true` | Shows the automatic or preserved manual thinking decision in the pi status footer |
| `autoThinking.allowDowngrade` | `false` | Allows the policy to lower the current thinking level when the task looks simpler |

## Data Transparency

Hosted features use the [HeadsDown SDK](https://github.com/headsdownapp/headsdown-sdk). Requests go only to HeadsDown APIs.

**Sent by hosted features:** task descriptions and estimates (for proposals), privacy-safe progress telemetry for approved runs, auth credentials, actor metadata (`source`, `agentId`, `sessionId`, `workspaceRef`). Auto-thinking does not send additional data.

**Sent by Local Referee:** nothing by default. It evaluates locally and prints a local receipt.

**Received by hosted features:** availability state, schedule context, verdicts, digest summaries.

**Stored locally:** API credentials when authenticated, optional continuation artifact (`~/.config/headsdown/continuation.json`), and any repo-local Referee contract you create.

No prompts, source code, file contents, file paths, repository names, branch names, terminal output, test logs, message contents, analytics, or third-party requests are sent by default.

## Development

```bash
git clone https://github.com/headsdownapp/headsdown-pi.git
cd headsdown-pi
npm install
npm test
npm run typecheck
```

This repo keeps source extensions in TypeScript for local development and Pi can still load them via jiti while editing.

Published npm artifacts are built with esbuild so extension runtime code ships from `dist/extensions` with `@headsdown/sdk` inlined. Peer host packages remain external. Skills are copied to `dist/skills` so the package manifest can point Pi to the publish-time artifact layout.

Before packing or publishing, run:

```bash
npm run build
```

## Dependency update automation

This repo uses Renovate to keep `@headsdown/sdk` and other routine dependencies current. New SDK releases open bot PRs automatically, and eligible updates can automerge after required CI checks pass. In normal maintenance flow, do not manually edit `@headsdown/sdk` versions unless you are intentionally overriding Renovate behavior.

## License

MIT
