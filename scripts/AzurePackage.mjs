import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.argv[2] ?? "dist/cloud");
if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 22) {
  throw new Error("Cloud packaging requires Linux Node 22. On Windows use WSL with Node 22; never upload Windows node_modules.");
}
if (!output.startsWith(`${root}/dist/`) || output === root) {
  throw new Error("Packaging output must be a new directory below project dist/.");
}
if (existsSync(output) || existsSync(`${output}.zip`)) throw new Error("Output already exists; choose a new dist/ directory to preserve prior artifacts.");
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.status}`);
};
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (JSON.stringify(manifest.workspaces) !== JSON.stringify(["apps/server", "apps/web", "packages/*"])) {
  throw new Error("Workspace topology changed; review cloud packaging before deploying.");
}
for (const path of ["apps/server/dist/index.js", "apps/server/dist/cloud/cosmos.js", "apps/web/dist/index.html", "packages/shared/dist/index.js"]) {
  if (!existsSync(join(root, path))) throw new Error(`Build output missing: ${path}. Run npm ci && npm run build first.`);
}
mkdirSync(output, { recursive: true });
for (const path of ["package.json", "package-lock.json", "apps/server/package.json", "apps/web/package.json", "packages/shared/package.json",
  "apps/server/dist", "apps/web/dist", "packages/shared/dist"]) {
  cpSync(join(root, path), join(output, path), { recursive: true });
}
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], output);
// ZIP deployment must not depend on an extractor preserving npm workspace symlinks.
for (const name of ["server", "web", "shared"]) {
  const path = join(output, "node_modules", "@friends-trivia", name);
  if (!existsSync(path)) throw new Error(`Missing runtime workspace ${name}`);
  const target = realpathSync(path);
  if (!relative(output, target).startsWith("..")) {
    rmSync(path);
    cpSync(target, path, { recursive: true });
  } else {
    throw new Error(`Workspace ${name} escapes artifact directory`);
  }
}
if (!statSync(join(output, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")).isFile()) {
  throw new Error("Linux SQLite native binding missing.");
}
run("node", ["--input-type=module", "-e", 'import Database from "better-sqlite3"; const db = new Database(":memory:"); db.prepare("SELECT 1").get(); db.close();'], output);
run("zip", ["-q", "-r", `${output}.zip`, "."], output);
console.log(`Artifact: ${output}.zip`);
