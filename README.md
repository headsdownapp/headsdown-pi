# headsdown-pi-skill

[HeadsDown](https://headsdown.app) availability skill for [Pi agent](https://github.com/badlogic/pi-coding-agent). Gives Pi awareness of your focus mode, schedule, and availability before it starts tasks.

When installed, Pi will:
1. **Check your availability** before starting significant work
2. **Submit task proposals** for a verdict (approved or deferred)
3. **Respect your focus time** by scoping work appropriately or deferring

## Install

### From Git (recommended)

Add to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": [
    "git:github.com/headsdownapp/headsdown-pi-skill"
  ]
}
```

Pi will clone the repo and discover the skill automatically.

### Manual Install

```bash
git clone https://github.com/headsdownapp/headsdown-pi-skill.git
cd headsdown-pi-skill
npm install
npm run build
```

Add the skill directory to your Pi settings:

```json
{
  "skills": [
    "/path/to/headsdown-pi-skill/skills"
  ]
}
```

## Setup

Authenticate with HeadsDown after installing:

```bash
# If installed globally via npm:
headsdown auth

# If installed from git/manual:
node /path/to/headsdown-pi-skill/dist/cli.js auth
```

This starts a Device Flow: Pi gives you a URL and code, you approve in your browser, and the API key is saved locally at `~/.config/headsdown/credentials.json`.

## How It Works

The skill teaches Pi to check your HeadsDown status before starting tasks. Pi uses the companion CLI to call the HeadsDown API:

```
You set your focus mode in HeadsDown (busy for 2 hours)
         │
         ▼
Pi starts a task
         │
         ▼
headsdown status ──► "Mode: busy, 🔨 Deep work, 90 min remaining"
         │
         ▼
headsdown propose ──► { decision: "deferred", reason: "..." }
         │
         ▼
Pi tells you: "You're in focus mode. Want me to defer this,
               or should I scope it down to a quick fix?"
```

## CLI Commands

The skill includes a companion CLI that Pi invokes via bash:

### `headsdown status`

Check current availability. Returns JSON with:
- Mode (online/busy/limited/offline)
- Status text and emoji
- Time remaining
- Work schedule context

### `headsdown propose "description" [options]`

Submit a task proposal. Returns a verdict.

Options:
| Flag | Description |
|------|-------------|
| `--files N` | Estimated files to modify |
| `--minutes N` | Estimated duration |
| `--scope TEXT` | Scope summary |
| `--ref TEXT` | Task source (ticket, PR) |

### `headsdown auth`

Authenticate via Device Flow.

### `headsdown auth-check`

Verify saved credentials are valid.

## Skill Structure

```
headsdown-pi-skill/
├── skills/
│   └── headsdown/
│       └── SKILL.md          # Pi skill definition (agent instructions)
├── src/
│   └── cli.ts                # CLI companion (API calls)
├── dist/                     # Built output (after npm run build)
├── package.json
└── README.md
```

The `SKILL.md` follows the [Agent Skills specification](https://agentskills.io/specification) and is compatible with any harness that supports the standard.

## Data Transparency

This skill is a thin CLI wrapper around the [HeadsDown SDK](https://github.com/headsdownapp/headsdown-sdk). It sends requests only to the HeadsDown API.

**What is sent:** Task descriptions and scope estimates (when proposals are submitted), your API key for authentication.

**What is received:** Your availability status, work schedule, and task verdicts.

**What is stored locally:** Your API key at `~/.config/headsdown/credentials.json` (0600 permissions).

The CLI is ~150 lines. Read it: [`src/cli.ts`](src/cli.ts).

No telemetry. No analytics. No third-party requests.

## Development

```bash
git clone https://github.com/headsdownapp/headsdown-pi-skill.git
cd headsdown-pi-skill
npm install
npm run build
npm test
```

## License

MIT
