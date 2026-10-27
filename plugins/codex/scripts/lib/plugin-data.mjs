import path from "node:path";
import { fileURLToPath } from "node:url";

// Standalone scripts run outside Claude Code, without CLAUDE_PLUGIN_DATA. An installed copy
// lives at <config>/plugins/cache/<marketplace>/<plugin>/<version>/scripts; its data directory
// is <config>/plugins/data/<plugin>-<marketplace>. Returns null for any other location.
export function pluginDataDir(scriptUrl) {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const scripts = path.dirname(fileURLToPath(scriptUrl));
  const [, plugin, marketplace, cache] = [1, 2, 3, 4].map((n) => path.resolve(scripts, ...Array(n).fill("..")));
  if (path.basename(cache) !== "cache") return null;
  return path.join(path.dirname(cache), "data", `${path.basename(plugin)}-${path.basename(marketplace)}`);
}
