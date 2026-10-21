import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Claude Code refuses the whole hooks module when any file it reaches imports
// something other than its own files or "claude-code" (1.4.68 shipped one that
// imported node:fs through scripts/lib and lost every Codex hook and tool).
test("the hooks module imports only its own files and claude-code", () => {
  const seen = new Set();
  const offending = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, kind, specifier] of source.matchAll(/^\s*(import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (specifier === "claude-code") continue;
      if (!specifier.startsWith(".")) offending.push(`${path.relative(process.cwd(), file)} ${kind}s ${specifier}`);
      else visit(path.resolve(path.dirname(file), specifier));
    }
  };
  visit(path.resolve("plugins/codex/hooks/register.ts"));
  assert.deepEqual(offending, []);
});
