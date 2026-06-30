import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo-root .env is the single source of truth (plan §12). Next.js only
// auto-loads .env files from each app's own dir, so mirror the root file into
// the apps that need it as a gitignored .env.local before dev/build. Keeps one
// editable secret file; no symlinks (Windows symlink = EPERM on locked-down
// machines).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(repoRoot, ".env");

if (!existsSync(src)) {
  console.error("[sync-env] repo-root .env missing — copy .env.example to .env first");
  process.exit(1);
}

const targets = [path.join(repoRoot, "apps", "web", ".env.local")];
for (const target of targets) {
  copyFileSync(src, target);
  console.log(`[sync-env] ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, target)}`);
}
