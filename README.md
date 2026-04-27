# headsdown-pi

[HeadsDown](https://headsdown.app) availability package for [Pi agent](https://github.com/badlogic/pi-coding-agent). It gives Pi deep availability awareness across the full task lifecycle: planning, execution, scope drift, compaction, branching, and session handoff.

When installed, Pi will:
1. **Know your availability continuously** via cached status + turn-level execution policy injection
2. **Check before significant work** with native status/proposal tools and skill guidance
3. **Gate mutating actions** on `write`, `edit`, and mutating `bash` commands using trust levels
4. **Track realized scope drift** from successful file mutations against approved proposal estimates
5. **Preserve continuity** across compaction, tree navigation, and session shutdown/switch
6. **Support resumable work** with continuation artifacts and digest triage for missed updates
7. **Contain rabbit holes** by pausing/summarizing detected drift and allowing explicit duration overrides when approved
8. **Optionally tune pi thinking level** before each turn with a configurable HeadsDown-aware auto-thinking policy

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

After installing, authenticate with HeadsDown:

> "Run headsdown_auth to connect my HeadsDown account"

Pi guides Device Flow auth. Credentials are stored at `~/.config/headsdown/credentials.json`.

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

### Rabbit-Hole Containment

During approved runs, Pi reports privacy-safe progress metadata (counts, buckets, validation state, and timing only). If HeadsDown raises `rabbit_hole_detected` or `finish_line_friction`, Pi emits Call/Trap/Play/Escalation guidance, saves a continuation handoff, and locally blocks further mutating edits while the backend call is still available for the next action.

Use `/headsdown pause` to apply `pause_and_summarize`, or `/headsdown allow <minutes>` to apply an `allow_for_duration` override when you intentionally want to continue instead of pausing.

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

- `headsdown_status` - current availability, schedule, wrap-up instruction, active scope
- `headsdown_presets` - list/apply saved presets
- `headsdown_propose` - submit task proposal for approved/deferred verdict
- `headsdown_digest` - review grouped summaries of updates received during focus windows
- `headsdown_grants` - manage delegation grants
- `headsdown_override` - manage temporary availability overrides
- `headsdown_continuation` - save/load/check/clear resumable continuation artifacts
- `headsdown_report` - report approved task outcome
- `headsdown_auth` - authenticate via Device Flow

The package also registers `/headsdown` for quick status checks.

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

This package is a thin wrapper around the [HeadsDown SDK](https://github.com/headsdownapp/headsdown-sdk). Requests go only to HeadsDown APIs.

**Sent:** task descriptions and estimates (for proposals), auth credentials, actor metadata (`source`, `agentId`, `sessionId`, `workspaceRef`). Auto-thinking does not send additional data.

**Received:** availability state, schedule context, verdicts, digest summaries.

**Stored locally:** API credentials and optional continuation artifact (`~/.config/headsdown/continuation.json`).

No telemetry. No analytics. No third-party requests.

## Development

```bash
git clone https://github.com/headsdownapp/headsdown-pi.git
cd headsdown-pi
npm install
npm test
npm run typecheck
```

No build step is required. Pi loads TypeScript extensions via jiti.

## License

MIT
