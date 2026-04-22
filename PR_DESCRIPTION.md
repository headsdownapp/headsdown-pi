## Summary
This PR deepens the HeadsDown Pi integration from a preflight availability wrapper into a full session-lifecycle integration that stays effective during execution, compaction, branching, and handoff.

## What changed

### 1) Execution policy and session awareness
- Reworked HeadsDown policy injection to use `before_agent_start` system prompt augmentation instead of per-turn hidden custom messages.
- Added continuous UI visibility (`setStatus` + `setWidget`) for availability summary, wrap-up guidance, and active proposal scope progress.
- Added digest presence signal and continuation presence signal on session start.

### 2) Mutating action enforcement
- Expanded `tool_call` gating to include mutating `bash` commands in addition to `write` and `edit`.
- Added bash mutation classifier helpers to distinguish read-only commands from mutating commands.
- Preserved trust-level semantics (`advisory`, `active`, `guarded`) while enforcing on mutating bash paths.

### 3) Scope drift tracking during execution
- Added `tool_result` tracking for successful `write`/`edit` operations to record realized modified files for the active approved proposal.
- Added scope-drift warning behavior when realized file count exceeds approved estimate threshold.
- Persisted proposal scope snapshots as custom session entries.

### 4) Lifecycle continuity and resumability
- Added lifecycle continuity handling for:
  - `session_before_switch`
  - `session_before_tree`
  - `session_before_compact`
  - `session_shutdown`
- Added automatic continuation artifact saving on switch/shutdown for unfinished approved work.
- Added `headsdown_continuation` tool (`save`, `load`, `check`, `clear`).
- Added `headsdown_digest` tool for missed-notification triage.

### 5) Custom compaction summary integration
- Implemented a HeadsDown custom compaction builder and wired it into `session_before_compact`.
- When meaningful HeadsDown context exists, the hook now returns a custom compaction object preserving:
  - availability summary
  - wrap-up instruction
  - active approved proposal
  - tracked scope and drift status
- Preserves required compaction metadata (`firstKeptEntryId`, `tokensBefore`) and includes structured details payload.

### 6) Documentation and skill updates
- Rewrote `skills/headsdown/SKILL.md` to include:
  - mode semantics
  - status/proposal flow
  - time-aware slicing
  - scope drift re-propose behavior
  - digest triage
  - continuation lifecycle
  - outcome reporting guidance
- Updated README to reflect the deeper Pi-native integration and new tools.

### 7) Tests
- Expanded structural extension tests for new tools and lifecycle/compaction hooks.
- Added helper-level tests for:
  - bash mutation classification
  - custom HeadsDown compaction builder behavior
- Existing policy and availability compatibility tests remain green.

## Validation
- `npm test`
- `npm run typecheck`
- `npm run lint`

All pass.

## Notes
- Continuation artifacts are stored at `~/.config/headsdown/continuation.json`.
- Compaction behavior remains default when no meaningful HeadsDown continuity context exists.
