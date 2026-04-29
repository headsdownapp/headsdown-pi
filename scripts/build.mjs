import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const projectRoot = process.cwd();
const extensionsRoot = join(projectRoot, "extensions");
const distRoot = join(projectRoot, "dist");

async function findExtensionEntrypoints(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findExtensionEntrypoints(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name === "index.ts") {
      files.push(entryPath);
    }
  }

  return files;
}

async function bundleExtensions() {
  const entryPoints = await findExtensionEntrypoints(extensionsRoot);
  if (entryPoints.length === 0) {
    throw new Error("No extension entrypoints found under extensions/");
  }

  for (const entryPoint of entryPoints) {
    const extensionDir = dirname(relative(extensionsRoot, entryPoint));
    const outdir = join(distRoot, "extensions", extensionDir);
    await mkdir(outdir, { recursive: true });

    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      format: "esm",
      outdir,
      external: [
        "@mariozechner/pi-ai",
        "@mariozechner/pi-coding-agent",
        "@sinclair/typebox",
      ],
      target: "node18",
      logLevel: "info",
    });
  }
}

async function copySkills() {
  await cp(join(projectRoot, "skills"), join(distRoot, "skills"), { recursive: true });
}

await rm(distRoot, { recursive: true, force: true });
await bundleExtensions();
await copySkills();
