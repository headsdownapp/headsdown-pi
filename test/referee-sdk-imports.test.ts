import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const DELETED_SIBLING_IMPORTS = ["./contract.js", "./evidence.js", "./evaluate.js", "./receipt.js"];

describe("Local Referee SDK imports", () => {
  it("keeps local-runner wired to @headsdown/sdk/referee instead of deleted sibling modules", async () => {
    const source = await readFile(
      join(ROOT, "extensions", "headsdown", "referee", "local-runner.ts"),
      "utf-8",
    );

    expect(source).toContain("@headsdown/sdk/referee");

    for (const siblingImport of DELETED_SIBLING_IMPORTS) {
      expect(source).not.toContain(siblingImport);
    }
  });
});
