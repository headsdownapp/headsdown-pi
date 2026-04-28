import { describe, expect, it, vi } from "vitest";
import headsdownExtension, { __internal } from "../extensions/headsdown/index.js";

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

function makeCommandContext(options: { selected?: string | undefined; hasUI?: boolean } = {}) {
  return {
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
    expect(values).toContain("rabbit-hole status");
    expect(values).toContain("rabbit-hole off");
    expect(values).toContain("rabbit-hole quiet");
    expect(values).toContain("rabbit-hole on");
    expect(values).toContain("pause");
    expect(values).toContain("allow 15");
    expect(values).toContain("details toggle");
    expect(values).toContain("theme neo");
  });

  it("filters completions by partial nested command prefixes", () => {
    expect(
      (__internal.getHeadsDownCommandCompletions("rabbit-hole o") ?? []).map((item) => item.value),
    ).toEqual(["rabbit-hole off", "rabbit-hole on"]);
    expect(
      (__internal.getHeadsDownCommandCompletions("theme e") ?? []).map((item) => item.value),
    ).toEqual(["theme executive"]);
    expect(__internal.getHeadsDownCommandCompletions("missing")).toBeNull();
  });

  it("builds grouped help for every command family", () => {
    const help = __internal.buildHeadsDownCommandHelp();

    expect(help).toContain("Status");
    expect(help).toContain("/headsdown digest");
    expect(help).toContain("Run actions");
    expect(help).toContain("/headsdown pause");
    expect(help).toContain("/headsdown allow <minutes>");
    expect(help).toContain("Rabbit-hole controls");
    expect(help).toContain("/headsdown rabbit-hole quiet");
    expect(help).toContain("Display");
    expect(help).toContain("/headsdown theme <neo|mono|executive|list|reset>");
    expect(help).toContain("Discovery");
    expect(help).toContain("/headsdown menu");
  });

  it("normalizes status and whitespace for command routing", () => {
    expect(__internal.normalizeHeadsDownCommandArgs(" status ")).toBe("");
    expect(__internal.normalizeHeadsDownCommandArgs(" rabbit-hole   quiet ")).toBe(
      "rabbit-hole quiet",
    );
  });

  it("keeps menu choices on canonical command strings", () => {
    const menuValues = __internal.HEADSDOWN_COMMAND_OPTIONS.filter((option) => option.menu).map(
      (option) => option.value,
    );

    expect(menuValues).toContain("help");
    expect(menuValues).toContain("rabbit-hole status");
    expect(menuValues).toContain("allow 15");
    expect(menuValues).not.toContain("rabbit");
  });

  it("routes /headsdown help without requiring authentication", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext();

    await command.handler("help", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(__internal.buildHeadsDownCommandHelp(), "info");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("routes /headsdown menu through the interactive picker", async () => {
    const command = registerHeadsDownCommand();
    const ctx = makeCommandContext({ selected: "Help: /headsdown help" });

    await command.handler("menu", ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith(
      "HeadsDown commands",
      expect.arrayContaining([
        "Help: /headsdown help",
        "Rabbit-hole status: /headsdown rabbit-hole status",
      ]),
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
