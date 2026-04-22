# Changelog

## 0.2.0 - 2026-04-22

- Deepened Pi integration across session lifecycle hooks, including `session_before_compact`, `session_before_tree`, `session_before_switch`, and `session_shutdown`.
- Switched HeadsDown execution guidance injection to per-turn `systemPrompt` augmentation instead of hidden persistent context messages.
- Added mutating `bash` gating to trust-policy enforcement alongside `write` and `edit`.
- Added realized scope drift tracking from successful tool results and warnings when modified files exceed approved estimates.
- Added `headsdown_digest` tool for missed notifications triage.
- Added `headsdown_continuation` tool for save/load/check/clear resumable continuation artifacts.
- Added custom compaction summary generation that preserves HeadsDown continuity context when meaningful state exists.
- Expanded skill guidance and README documentation for lifecycle, drift, digest, and continuation behavior.
- Expanded tests for bash mutation classification and custom compaction behavior.

## 0.1.1 - 2026-04-21

- Added delegation grants, availability override, and outcome reporting tools.
- Added compatibility fallback for availability APIs when `calendar` is unavailable.
- Added actor context wiring for session and workspace metadata.
- Added trust-policy and extension structural test coverage.
