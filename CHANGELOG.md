# Changelog

## Unreleased

- Wired Pi autopilot prompt and deferral decisions to the shared `@headsdown/sdk` classifier policy, prompt, action-shape, capability, and escalation helpers.
- Added privacy-safe deferred-decision classifier context for SDK version compatibility, final disposition, and declared sandbox capability.

## 0.2.1 - 2026-04-29

- Added a publish-time esbuild bundling step for extension entrypoints into `dist/extensions`.
- Switched package publishing metadata to ship `dist` artifacts and point Pi extension/skill manifests at `dist` paths.
- Moved `@headsdown/sdk` from runtime `dependencies` to `devDependencies` so it is inlined in published extension artifacts instead of installed transitively at runtime.
- Updated CI and npm publish workflows to run `npm run build` before typecheck/test/lint.
- Updated README and manifest tests to document and verify the bundled artifact layout.

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
