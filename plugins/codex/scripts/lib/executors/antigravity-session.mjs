import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function realDirectory(entry) {
  try {
    const real = fs.realpathSync(entry);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

export function antigravitySkillDirectories(cwd, { home = os.homedir(), geminiHome = path.join(home, ".gemini"),
  codexHome = path.join(home, ".codex") } = {}) {
  const directories = new Set();
  for (const root of [path.join(geminiHome, "antigravity-cli/skills"), path.join(geminiHome, "config/skills"),
    path.join(cwd, ".agents/skills")]) {
    let entries;
    try { entries = fs.readdirSync(root); }
    catch { continue; }
    for (const entry of entries) {
      const real = realDirectory(path.join(root, entry));
      if (real) directories.add(real);
    }
  }
  // The Claude director names the sibling skill in its dispatch note. Its
  // installer also links that skill under CODEX_HOME for Codex executors.
  const director = realDirectory(path.join(home, ".claude/skills/code-director"));
  const executor = (director && realDirectory(path.join(path.dirname(director), "codex-executor"))) ??
    realDirectory(path.join(codexHome, "skills/codex-executor"));
  if (executor) directories.add(executor);
  return [...directories];
}
