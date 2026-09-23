import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
const root = resolve(".");
const output = "docs/PRESTART_MANIFEST.json";
const excluded = new Set([
  "node_modules",
  ".pnpm-store",
  "dist",
  ".git",
  ".codex",
  ".codex-log",
  "coverage",
]);
const hashes = {};
async function walk(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") continue;
    if (entry.name.endsWith(".log") || entry.name.endsWith(".zip")) continue;
    const path = join(dir, entry.name);
    const name = relative(root, path).split("\\").join("/");
    if (name === output) continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile())
      hashes[name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
}
await walk(root);
await writeFile(
  output,
  JSON.stringify(
    {
      purpose:
        "Disclosure of the pre-existing starter. Not proof of trusted creation time or organizer approval.",
      capturedAt: new Date().toISOString(),
      files: hashes,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Wrote ${output}. Check it for secrets before sharing; preserve this baseline after the competition starts.`,
);
