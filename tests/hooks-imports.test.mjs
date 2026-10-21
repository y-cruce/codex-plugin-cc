import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Claude Code scans every file the hooks module reaches and refuses the whole
// module on the first rule it breaks; 1.4.67-1.4.69 shipped four of them and
// lost every Codex hook and tool.
test("the hooks module passes Claude Code's load scan", () => {
  const seen = new Set();
  const offending = [];
  const unmatched = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    const name = path.relative(process.cwd(), file);
    // Imports: only its own files, by relative path, and "claude-code".
    for (const [, kind, specifier] of source.matchAll(/^\s*(import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (specifier === "claude-code") continue;
      if (!specifier.startsWith(".")) offending.push(`${name} ${kind}s ${specifier}`);
      else visit(path.resolve(path.dirname(file), specifier));
    }
    // $, on and next are never declared again.
    for (const [declaration] of source.matchAll(/\b(?:const|let|var)\s+(?:on|next|\$)\b/g)) offending.push(`${name} declares ${declaration}`);
    // What a function given `on` returns is never kept.
    for (const [kept] of source.matchAll(/\b(?:const|let|var)\s+\w+\s*=\s*\w+\(on\b/g)) offending.push(`${name} keeps ${kept}`);
    // One hook per event without a matcher across the whole module.
    for (const [, event] of source.matchAll(/\bon\('([\w.]+)',\s*(?:async\s*)?\(/g)) unmatched.set(event, [...unmatched.get(event) ?? [], name]);
  };
  visit(path.resolve("plugins/codex/hooks/register.ts"));
  for (const [event, files] of unmatched) if (files.length > 1) offending.push(`on('${event}') registered without a matcher in ${files.join(", ")}`);
  assert.deepEqual(offending, []);
});
