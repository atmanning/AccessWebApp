// Records which version of the code was built and when, for the version shown in the app's title bar.
// The commit comes from the build environment, a .source-commit file (written by the installers,
// which download the code without Git), or Git itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.resolve(here, "../dist/build-info.json");

function commit() {
  const env = process.env.RENDER_GIT_COMMIT || process.env.SOURCE_COMMIT || process.env.GIT_COMMIT;
  if (env) return env.trim();
  try {
    const file = fs.readFileSync(path.join(root, ".source-commit"), "utf8").trim();
    if (/^[0-9a-f]{7,40}$/i.test(file)) return file;
  } catch {
    /* not installed by an installer */
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ commit: commit(), builtAt: new Date().toISOString() }, null, 2) + "\n");
