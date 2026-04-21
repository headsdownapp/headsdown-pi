# headsdown-pi

[HeadsDown](https://headsdown.app) availability package for [Pi agent](https://github.com/badlogic/pi-coding-agent). Gives Pi awareness of your focus mode, schedule, and availability before it starts tasks.

When installed, Pi will:
1. **Know your availability from the start** via context injection at session start
2. **Check before starting work** via native tools and a skill that teaches Pi to submit proposals
3. **Gate file modifications** by intercepting write/edit calls and enforcing trust levels
4. **Respect your focus time** by blocking or warning based on your mode

## Install

```bash
pi install git:github.com/headsdownapp/headsdown-pi
```

Or add to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["git:github.com/headsdownapp/headsdown-pi"]
}
```

## Setup

After installing, authenticate with HeadsDown:

> "Run headsdown_auth to connect my HeadsDown account"

Pi will guide you through the Device Flow: visit a URL, enter a code, and the API key is saved at `~/.config/headsdown/credentials.json`.

## What's in the Package

### Extension (`extensions/headsdown/index.ts`)

A full Pi extension that:

**Injects availability context** at the start of each agent turn via `before_agent_start`. Pi always knows your mode before you say anything.

**Intercepts file writes** via `tool_call` on write/edit. Checks your mode and enforces trust levels:

| | online | busy | busy+locked | limited | offline |
|---|---|---|---|---|---|
| **advisory** (default) | silent | warn | warn | warn | warn |
| **active** | silent | silent | block | silent | block (no proposal) |
| **guarded** | silent | block (no proposal) | block | block (no proposal) | block (no proposal) |

**Registers native tools:**
- `headsdown_status` - Check current availability
- `headsdown_presets` - List or apply saved availability presets
- `headsdown_propose` - Submit task proposal for verdict
- `headsdown_grants` - List/create/revoke delegation grants
- `headsdown_override` - Get/set/clear temporary availability overrides
- `headsdown_report` - Report task outcome for calibration
- `headsdown_auth` - Device Flow authentication

**Registers `/headsdown` command** for quick status checks.

**Persists proposal state** in Pi's session via `pi.appendEntry()`. Approved proposals survive session navigation and branch forking.

### Skill (`skills/headsdown/SKILL.md`)

Agent behavioral instructions that teach Pi when and how to check availability. Pi loads this contextually before starting tasks.

### Sensitive Path Protection

Files like `.env`, `.ssh/*`, `package.json`, `Dockerfile`, and CI configs always trigger a warning regardless of trust level or proposal status.

## Configuration

`~/.config/headsdown/config.json`:

```json
{
  "trustLevel": "advisory",
  "sensitivePaths": [".env*", ".ssh/*", "package.json", "Dockerfile*", ".github/**"]
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `trustLevel` | `"advisory"` | `advisory`, `active`, or `guarded` |
| `sensitivePaths` | (see defaults) | Glob patterns that always require confirmation |

## Data Transparency

This package is a thin wrapper around the [HeadsDown SDK](https://github.com/headsdownapp/headsdown-sdk). It sends requests only to the HeadsDown API.

**What is sent:** Task descriptions and scope estimates (when proposals are submitted), your API key for authentication, and actor context metadata (`source`, `agentId`, `sessionId`, `workspaceRef`) for delegated authorization paths.

**What is received:** Your availability status, work schedule, and task verdicts.

**What is stored locally:** Your API key at `~/.config/headsdown/credentials.json` (0600 permissions).

No telemetry. No analytics. No third-party requests.

## Development

```bash
git clone https://github.com/headsdownapp/headsdown-pi.git
cd headsdown-pi
npm install
npm test        # 99 tests
npm run typecheck
```

No build step needed. Pi loads TypeScript extensions directly via jiti.

## License

MIT
