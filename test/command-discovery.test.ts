import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import headsdownExtension, { __internal } from "../extensions/headsdown/index.js";

const execFile = promisify(execFileCallback);

function registerHeadsDownCommand() {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    registerCommand: vi.fn(
      (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        commands.set(name, command);
      },
    ),
    registerTool: vi.fn(),
    on: vi.fn(),
  };

  headsdownExtension(pi as any);

  const command = commands.get("headsdown");
  if (!command) throw new Error("headsdown command was not registered");

  return command;
}

async function tempWorkspaceWithRefereeContract() {
  const cwd = await mkdtemp(join(tmpdir(), "headsdown-command-referee-"));
  await execFile("git", ["init"], { cwd });
  await mkdir(join(cwd, ".headsdown"));
  await writeFile(
    join(cwd, ".headsdown", "referee.json"),
    JSON.stringify({
      version: 1,
      checks: [
        { type: "network_required", required: false },
        { type: "max_files_touched", max: 5 },
      ],
    }),
    "utf-8",
  );
  return cwd;
}

function makeCommandContext(
  options: { selected?: string | undefined; hasUI?: boolean; cwd?: string } = {},
) {
  return {
    cwd: options.cwd ?? process.cwd(),
    hasUI: options.hasUI ?? true,
    ui: {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue(options.selected),
    },
  };
}

describe("HeadsDown command discovery", () => {
  it("advertises documented /headsdown subcommands through argument completions", () => {
    const values = (__internal.getHeadsDownCommandCompletions("") ?? []).map((item) => item.value);

    expect(values).toContain("help");
    expect(values).toContain("menu");
    expect(values).toContain("referee");
    expect(values).toContain("box 15m");
    expect(values).toContain("box 1h");
    expect(values).toContain("box status");
    expect(values).toContain("box clear");
    expect(values).not.toContain("rabbit-hole status");
    expect(values).not.toContain("rabbit-hole off");
    expect(values).not.toContain("rabbit-hole quiet");
    expect(values).not.toContain("rabbit-hole on");
    expect(values).toContain("extend 15m");
    expect(values).toContain("wrap");
    expect(values).toContain("details toggle");
    expect(values).toContain("theme neo");
  });

  it("filters completions by partial nested command prefixes", () => {
    expect(__internal.getHeadsDownCommandCompletions("rabbit-hole o")).toBeNull();
    expect(
      (__internal.getHeadsDownCommandCompletions("theme e") ?? []).map((item) => item.value),
    ).toEqual(["theme executive"]);
    expect(
      (__internal.getHeadsDownCommandCompletions("box s") ?? []).map((item) => item.value),
    ).toEqual(["box status"]);
    expect(__internal.getHeadsDownCommandCompletions("missing")).toBeNull();
  });

  it("builds grouped help for every command family", () => {
    const help = __internal.buildHeadsDownCommandHelp();

    expect(help).toContain("Status");
    expect(help).toContain("/headsdown digest");
    expect(help).toContain("Local verification");
    expect(help).toContain("/headsdown referee");
    expect(help).toContain("Run actions");
    expect(help).toContain("/headsdown extend [duration]");
    expect(help).toContain("/headsdown wrap");
    expect(help).toContain("Local time box");
    expect(help).toContain("/headsdown box <duration>");
    expect(help).toContain("/headsdown box status");
    expect(help).toContain("/headsdown box clear");
    expect(help).not.toContain("Rabbit-hole controls");
    expect(help).not.toContain("/headsdown rabbit-hole quiet");
    expect(help).toContain("Display");
    expect(help).toContain("/headsdown theme <neo|mono|executive|list|reset>");
    expect(help).toContain("Discovery");
    expect(help).toContain("/headsdown menu");
  });

  it("normalizes status and whitespace for command routing", () => {
    expect(__internal.normalizeHeadsDownCommandArgs(" status ")).toBe("");
    expect(__internal.normalizeHeadsDownCommandArgs(" box   status ")).toBe("box status");
  });

  it("keeps menu choices on canonical command strings", () => {
    const menuValues = __internal.HEADSDOWN_COMMAND_OPTIONS.filter((option) => option.menu).map(
      (option) => option.value,
    );

    expect(menuValues).toContain("help");
    expect(menuValues).toContain("referee");
    expect(menuValues).toContain("box 15m");
    expect(menuValues).toContain("box status");
    expect(menuValues).toContain("box clear");
    expect(menuValues).not.toContain("rabbit-hole status");
    expect(menuValues).toContain("extend 15m");
    expect(menuValues).toContain("wrap");
    expect(menuValues).not.toContain("rabbit");
  });

  it("routes /headsdown help without requiring authentication", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("help", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(__internal.buildHeadsDownCommandHelp(), "info");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("routes /headsdown referee without requiring authentication", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext({ cwd: await tempWorkspaceWithRefereeContract() });

    await command.handler("referee", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("HEADSDOWN LOCAL REFEREE RECEIPT"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
      expect.anything(),
    );
  });

  it("routes /headsdown menu through the interactive picker", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext({ selected: "Help: /headsdown help" });

    await command.handler("menu", ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith(
      "HeadsDown commands",
      expect.arrayContaining(["Help: /headsdown help", "Time box status: /headsdown box status"]),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(__internal.buildHeadsDownCommandHelp(), "info");
  });

  it("falls back to help for /headsdown menu when no interactive UI is available", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext({ hasUI: false });

    await command.handler("menu", ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(__internal.buildHeadsDownCommandHelp(), "info");
  });
});
