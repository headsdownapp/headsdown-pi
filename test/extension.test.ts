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
    expect(content).toContain("client.listPresets()");
    expect(content).toContain("client.applyPreset(selected.id)");
  });

  it("keeps headsdown_report but degrades gracefully when sdk lacks reportOutcome", async () => {
    const content = await readFile(join(ROOT, "extensions", "headsdown", "index.ts"), "utf-8");
    expect(content).toContain('name: "headsdown_report"');
    expect(content).toContain(
      "Outcome reporting is unavailable with the current installed @headsdown/sdk version.",
    );
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
    // Should reference tool names
    expect(content).toContain("headsdown_status");
    expect(content).toContain("headsdown_presets");
    expect(content).toContain("headsdown_propose");
    expect(content).toContain("headsdown_auth");
    // Should NOT reference the old CLI
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
