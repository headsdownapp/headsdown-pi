import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let tempDir: string;

// Path to the built CLI. Tests require `npm run build` first.
const CLI_PATH = join(import.meta.dirname, "..", "dist", "cli.js");

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hd-pi-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Run the CLI with given args. Overrides credential path via env. */
async function runCLI(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync("node", [CLI_PATH, ...args], {
      env: {
        ...process.env,
        ...env,
        // Point to temp credentials to avoid touching real ones
        HOME: tempDir,
        XDG_CONFIG_HOME: join(tempDir, ".config"),
      },
      timeout: 10_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

/** Write fake credentials to the temp config dir. */
async function writeCredentials(apiKey = "hd_test_key_abc123") {
  const configDir = join(tempDir, ".config", "headsdown");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ apiKey, createdAt: new Date().toISOString() }),
  );
}

describe("CLI", () => {
  describe("help", () => {
    it("shows help with no arguments", async () => {
      const result = await runCLI([]);
      expect(result.stderr).toContain("headsdown");
      expect(result.stderr).toContain("status");
      expect(result.stderr).toContain("propose");
      expect(result.stderr).toContain("auth");
    });

    it("shows help with --help flag", async () => {
      const result = await runCLI(["--help"]);
      expect(result.stderr).toContain("headsdown");
      expect(result.stderr).toContain("Commands:");
    });

    it("shows help with help command", async () => {
      const result = await runCLI(["help"]);
      expect(result.stderr).toContain("Commands:");
    });
  });

  describe("unknown command", () => {
    it("exits with error for unknown command", async () => {
      const result = await runCLI(["nonexistent"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Unknown command");
    });
  });

  describe("status", () => {
    it("fails without credentials", async () => {
      const result = await runCLI(["status"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Authentication error");
      expect(result.stderr).toContain("headsdown auth");
    });
  });

  describe("propose", () => {
    it("requires a description", async () => {
      const result = await runCLI(["propose"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Usage");
    });

    it("fails without credentials", async () => {
      const result = await runCLI(["propose", "Refactor auth module"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Authentication error");
    });
  });

  describe("auth-check", () => {
    it("fails without credentials", async () => {
      const result = await runCLI(["auth-check"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Authentication error");
    });
  });
});

describe("SKILL.md", () => {
  it("exists and has valid frontmatter", async () => {
    const skillPath = join(import.meta.dirname, "..", "skills", "headsdown", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");

    // Has frontmatter
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("name: headsdown");
    expect(content).toContain("description:");

    // Description is meaningful
    const descMatch = content.match(/description:\s*(.+)/);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1].length).toBeGreaterThan(20);
    expect(descMatch![1].length).toBeLessThanOrEqual(1024);
  });

  it("name matches directory name", async () => {
    const skillPath = join(import.meta.dirname, "..", "skills", "headsdown", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");

    const nameMatch = content.match(/name:\s*(\S+)/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe("headsdown");
  });

  it("references the CLI companion commands", async () => {
    const skillPath = join(import.meta.dirname, "..", "skills", "headsdown", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");

    expect(content).toContain("status");
    expect(content).toContain("propose");
    expect(content).toContain("auth");
    expect(content).toContain("dist/cli.js");
  });

  it("documents all availability modes", async () => {
    const skillPath = join(import.meta.dirname, "..", "skills", "headsdown", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");

    expect(content).toContain("online");
    expect(content).toContain("busy");
    expect(content).toContain("limited");
    expect(content).toContain("offline");
  });

  it("documents verdict decisions", async () => {
    const skillPath = join(import.meta.dirname, "..", "skills", "headsdown", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");

    expect(content).toContain("approved");
    expect(content).toContain("deferred");
  });

  it("name follows Agent Skills spec (lowercase, no hyphens at edges)", async () => {
    const skillPath = join(import.meta.dirname, "..", "skills", "headsdown", "SKILL.md");
    const content = await readFile(skillPath, "utf-8");

    const nameMatch = content.match(/name:\s*(\S+)/);
    const name = nameMatch![1];

    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toContain("--");
  });
});
