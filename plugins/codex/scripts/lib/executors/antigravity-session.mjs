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

export function antigravityMcpServers(geminiHome, capabilities, explicit = []) {
  const mcpServers = [...explicit];
  const warnings = [];
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(geminiHome, "config/mcp_config.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") warnings.push("Antigravity could not read or parse config/mcp_config.json.");
    return { mcpServers, warnings };
  }
  const names = new Set(explicit.map(({ name }) => name));
  for (const [name, server] of Object.entries(config?.mcpServers ?? config ?? {})) {
    // The official ACP server already reads command (stdio) and url (HTTP)
    // entries itself. It silently ignores the CLI's serverUrl spelling.
    if (names.has(name) || server?.disabled === true || server?.command || server?.url) continue;
    const prefix = `Antigravity MCP ${JSON.stringify(name)} skipped: `;
    if (!server?.serverUrl || typeof server.serverUrl !== "string" || (server.type && server.type !== "http")) {
      warnings.push(prefix + "unsupported server configuration.");
    } else if (capabilities?.http !== true) {
      warnings.push(prefix + "the ACP server does not advertise HTTP MCP support.");
    } else {
      mcpServers.push({ name, type: "http", url: server.serverUrl,
        headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value: String(value) })) });
    }
  }
  return { mcpServers, warnings };
}
