import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
async function collect(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
}
const files = await collect("tests");
if (!files.length) throw new Error("No tests found");
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
