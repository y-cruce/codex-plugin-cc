import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { antigravitySkillDirectories } from "../plugins/codex/scripts/lib/executors/antigravity-session.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-session-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Antigravity grants the distinct real directories of registered skills and the director's executor skill", (t) => {
  const home = fixture(t);
  const cwd = path.join(home, "workspace");
  const shared = path.join(home, "shared/compass");
  const local = path.join(cwd, ".agents/skills/local");
  const director = path.join(home, "checkout/skills/code-director");
  const executor = path.join(home, "checkout/skills/codex-executor");
  const cliSkills = path.join(home, ".gemini/antigravity-cli/skills");
  const configSkills = path.join(home, ".gemini/config/skills");
  const claudeSkills = path.join(home, ".claude/skills");
  for (const dir of [shared, local, director, executor, cliSkills, configSkills, claudeSkills]) fs.mkdirSync(dir, { recursive: true });
  for (const root of [cliSkills, configSkills, path.dirname(local)]) fs.symlinkSync(shared, path.join(root, "compass"), "dir");
  fs.symlinkSync(director, path.join(claudeSkills, "code-director"), "dir");
  fs.symlinkSync(path.join(home, "missing"), path.join(cliSkills, "broken"), "dir");
  fs.writeFileSync(path.join(configSkills, "not-a-directory"), "");
  assert.deepEqual(antigravitySkillDirectories(cwd, { home }), [shared, local, executor]);
});
