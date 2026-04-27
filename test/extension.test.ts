import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Extension structural tests.
 * The policy logic is tested directly in policy.test.ts.
 * These tests verify the extension file, SKILL.md, and package manifest
 * are well-formed and reference the right things.
 */

const ROOT = join(import.meta.dirname, "..");

describe("Extension file", () => {
  it("exists at the expected path", async () => {
    const extPath = join(ROOT, "extensions", "headsdown", "index.ts");
    const stats = await stat(extPath);
    expect(stats.isFile()).toBe(true);
  });

  it("exports a default function", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toMatch(/export default function/);
  });

  it("imports from the policy module", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('from "./policy.js"');
    expect(content).toContain("applyTrustPolicy");
    expect(content).toContain("isSensitivePath");
    expect(content).toContain("formatSummary");
  });

  it("registers headsdown_presets tool with list/apply actions", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('name: "headsdown_presets"');
    expect(content).toContain('Type.Literal("list")');
    expect(content).toContain('Type.Literal("apply")');
    expect(content).toContain("actorClient.listPresets()");
    expect(content).toContain("actorClient.applyPreset(selected.id)");
  });

  it("uses availability compatibility fallback when calendar field is unavailable", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("AVAILABILITY_COMPAT_QUERY");
    expect(content).toContain('Cannot query field "calendar"');
    expect(content).toContain("getAvailabilityContext(actorClient)");
  });

  it("registers delegation, override, digest, and continuation tools", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('name: "headsdown_grants"');
    expect(content).toContain("listActiveDelegationGrants");
    expect(content).toContain("createDelegationGrant");
    expect(content).toContain("revokeDelegationGrant");
    expect(content).toContain('name: "headsdown_override"');
    expect(content).toContain("createAvailabilityOverrideCompat");
    expect(content).toContain("cancelAvailabilityOverrideCompat");
    expect(content).toContain('name: "headsdown_digest"');
    expect(content).toContain("listDigestSummaries");
    expect(content).toContain('name: "headsdown_continuation"');
    expect(content).toContain("CONTINUATION_PATH");
  });

  it("supports idempotency_key and delivery_mode in propose responses", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("idempotency_key");
    expect(content).toContain("deriveProposalIdempotencyKey");
    expect(content).toContain("pi-toolcall-");
    expect(content).toContain("buildProposalInput(params, _toolCallId)");
    expect(content).toContain("delivery_mode");
    expect(content).toContain("deliveryMode: params.delivery_mode");
    expect(content).toContain("wrapUpGuidance: verdict.wrapUpGuidance");
  });

  it("shows explicit session-token guidance for delegation grant management", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("session-token auth path");
    expect(content).toContain("unavailable for API-key clients");
  });

  it("keeps headsdown_report and binds modern sdk reportOutcome to actor client", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('name: "headsdown_report"');
    expect(content).toContain("reportOutcomeMethod");
    expect(content).toContain("reportOutcomeMethod.bind(actorClient)");
  });

  it("uses lifecycle hooks for continuity and compaction integration", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('pi.on("session_before_compact"');
    expect(content).toContain('pi.on("session_before_tree"');
    expect(content).toContain('pi.on("session_before_switch"');
    expect(content).toContain('pi.on("session_shutdown"');
    expect(content).toContain("appendContinuityEntry");
    expect(content).toContain("buildHeadsDownCompaction");
    expect(content).toContain("return { compaction }");
  });

  it("injects HeadsDown policy through systemPrompt and tracks scope from tool_result", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("systemPrompt:");
    expect(content).toContain('pi.on("tool_result"');
    expect(content).toContain("maybeWarnScopeDrift");
  });

  it("starts progress telemetry from the active run epoch instead of proposal approval time", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("startedAt: Date.now()");
    expect(content).not.toContain(
      "startedAt: new Date(proposal.evaluatedAt).getTime() || Date.now()",
    );
  });

  it("handles rabbit_hole_detected with pause/summarize and allow-for-duration override", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("maybeHandleRabbitHoleDetected");
    expect(content).toContain("pauseAndSummarize");
    expect(content).toContain("allowForDuration");
    expect(content).toContain("rabbitHoleInterventions");
    expect(content).toContain('normalizedArgs.startsWith("pause")');
    expect(content).toContain('normalizedArgs.startsWith("allow")');
  });

  it("supports session-scoped rabbit-hole override controls", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('type RabbitHoleSessionMode = "on" | "off" | "quiet"');
    expect(content).toContain("rabbitHoleSessionMode");
    expect(content).toContain('normalizedArgs.startsWith("rabbit-hole ")');
    expect(content).toContain("/headsdown rabbit-hole <status|off|quiet|on>");
    expect(content).toContain("shouldBlockRabbitHoleMutation");
    expect(content).toContain("shouldEmitRabbitHoleGuidance");
  });

  it("supports themed status UI and runtime /headsdown theme switching", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("HEADSDOWN_UI_THEMES");
    expect(content).toContain('name: "Neo"');
    expect(content).toContain('name: "Mono"');
    expect(content).toContain('name: "Executive"');
    expect(content).toContain("HEADSDOWN_UI_THEME");
    expect(content).toContain("/headsdown theme <neo|mono|executive>");
    expect(content).toContain('normalizedArgs.startsWith("theme")');
  });

  it("keeps details widget opt-in and supports runtime /headsdown details toggles", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain("let detailsWidgetVisible = false");
    expect(content).toContain('normalizedArgs.startsWith("details")');
    expect(content).toContain("/headsdown details <on|off|toggle>");
    expect(content).toContain("detailsWidgetVisible && detailsWidget.length > 0");
    expect(content).toContain("formatCompactDuration");
  });
});

describe("Policy module", () => {
  it("exists alongside the extension", async () => {
    const policyPath = join(ROOT, "extensions", "headsdown", "policy.ts");
    const stats = await stat(policyPath);
    expect(stats.isFile()).toBe(true);
  });

  it("exports all required functions", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "policy.ts"), "utf-8");
    expect(content).toContain("export function applyTrustPolicy");
    expect(content).toContain("export function isSensitivePath");
    expect(content).toContain("export function matchGlob");
    expect(content).toContain("export function formatSummary");
  });
});

describe("SKILL.md", () => {
  const skillPath = join(ROOT, "skills", "headsdown", "SKILL.md");

  it("exists with valid frontmatter", async () => {
    const content = await readFile(skillPath, "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("name: headsdown");

    const descMatch = content.match(/description:\s*(.+)/);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1].length).toBeGreaterThan(20);
    expect(descMatch![1].length).toBeLessThanOrEqual(1024);
  });

  it("name follows Agent Skills spec", async () => {
    const content = await readFile(skillPath, "utf-8");
    const nameMatch = content.match(/name:\s*(\S+)/);
    expect(nameMatch![1]).toBe("headsdown");
    expect(nameMatch![1]).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("references native tools, not CLI commands", async () => {
    const content = await readFile(skillPath, "utf-8");
    expect(content).toContain("headsdown_status");
    expect(content).toContain("headsdown_presets");
    expect(content).toContain("headsdown_propose");
    expect(content).toContain("headsdown_digest");
    expect(content).toContain("headsdown_continuation");
    expect(content).toContain("headsdown_auth");
    expect(content).not.toContain("dist/cli.js");
    expect(content).not.toContain("SKILL_DIR");
  });

  it("documents all modes and verdicts", async () => {
    const content = await readFile(skillPath, "utf-8");
    for (const mode of ["online", "busy", "limited", "offline"]) {
      expect(content).toContain(mode);
    }
    expect(content).toContain("approved");
    expect(content).toContain("deferred");
  });
});

describe("Pi package manifest", () => {
  it("declares pi extensions and skills", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.pi).toBeTruthy();
    expect(pkg.pi.extensions).toContain("./extensions");
    expect(pkg.pi.skills).toContain("./skills");
  });

  it("has pi-package keyword for discoverability", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.keywords).toContain("pi-package");
  });

  it("declares pi peer dependencies", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.peerDependencies["@mariozechner/pi-coding-agent"]).toBeTruthy();
    expect(pkg.peerDependencies["@sinclair/typebox"]).toBeTruthy();
  });

  it("depends on @headsdown/sdk", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.dependencies["@headsdown/sdk"]).toBeTruthy();
  });
});
