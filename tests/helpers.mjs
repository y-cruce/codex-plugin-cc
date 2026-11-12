import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const tempDirs = new Set();
let testPluginDataDirs = null;

// How long a test waits for a real broker to bind, or for a background worker
// to get going. Each is a fresh node process, and on this machine one can sit
// at _dyld_start, before its first instruction and with no CPU in use, for tens
// of seconds: 45 s was passed in a run of the suite. Every file that started its
// own broker used to carry its own tight literal, and a run failed a different
// one of them each time. Generous on purpose: it only costs this long when
// something is actually broken.
export const BROKER_READY_MS = 120000;

export async function within(promise, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(predicate, description = "condition", timeoutMs = BROKER_READY_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const value = await within(Promise.resolve().then(() => predicate(remainingMs)), remainingMs, description);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

export async function closeTestBroker(broker, closed, endpoint, clients = [], pidFile = null) {
  try {
    await within(Promise.allSettled([
      ...clients.map((client) => client.close()), sendBrokerShutdown(endpoint)
    ]), 1000, "test broker graceful cleanup").catch(() => {});
  } finally {
    for (const client of clients) client.socket?.destroy();
    if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGKILL");
    await within(closed, 5000, "test broker exit");
    if (pidFile && fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")) === broker.pid) fs.unlinkSync(pidFile);
  }
}

export async function shutdownTestBrokers(pluginDataDir) {
  if (![...tempDirs].some((dir) => pluginDataDir === dir || pluginDataDir.startsWith(`${dir}${path.sep}`))) {
    throw new Error(`Refusing broker cleanup outside test temp directories: ${pluginDataDir}`);
  }
  const stateRoot = path.join(pluginDataDir, "state");
  if (!fs.existsSync(stateRoot)) return;
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionFile = path.join(stateRoot, entry.name, "broker.json");
    if (!fs.existsSync(sessionFile)) continue;
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    // Seeded status-only records have no pid file and do not own a broker.
    if (!session.pidFile || !fs.existsSync(session.pidFile)) continue;
    if (!session.sessionDir?.startsWith(`${os.tmpdir()}${path.sep}`) ||
        session.pidFile !== path.join(session.sessionDir, "broker.pid") ||
        session.endpoint !== createBrokerEndpoint(session.sessionDir)) {
      throw new Error(`Refusing broker cleanup for an unowned endpoint: ${sessionFile}`);
    }
    await sendBrokerShutdown(session.endpoint);
    let running = true;
    for (let attempt = 0; attempt < 100 && running; attempt += 1) {
      try {
        process.kill(session.pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        running = false;
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (running || fs.existsSync(session.pidFile)) throw new Error(`Test broker did not shut down: ${sessionFile}`);
  }
}

export function isolateTestEnvironment(t) {
  const previous = { ...process.env };
  const previousPluginDataDirs = testPluginDataDirs;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CODEX_COMPANION_") || ["CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE", "CLAUDE_SESSION_ID", "CLAUDE_TRANSCRIPT_PATH"].includes(key)) {
      delete process.env[key];
    }
  }
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  testPluginDataDirs = new Set([process.env.CLAUDE_PLUGIN_DATA]);
  const pluginDataDirs = testPluginDataDirs;
  t.after(async () => {
    try {
      for (const dir of pluginDataDirs) await shutdownTestBrokers(dir);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      testPluginDataDirs = previousPluginDataDirs;
    }
  });
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const pluginDataDir = (options.env ?? process.env).CLAUDE_PLUGIN_DATA;
  if (pluginDataDir) testPluginDataDirs?.add(pluginDataDir);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? BROKER_READY_MS,
    killSignal: "SIGKILL",
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
  if (result.error && !result.stderr) result.stderr = result.error.message;
  return result;
}

let inProcessCompanionSeq = 0;

export async function runCompanionInProcess(scriptPath, args, options = {}) {
  const realScript = fs.realpathSync(scriptPath);
  const prevArgv = process.argv;
  const prevExitCode = process.exitCode;
  const prevCwd = process.cwd();
  const prevEnv = { ...process.env };
  const targetEnv = options.env ?? process.env;
  if (targetEnv.CLAUDE_PLUGIN_DATA) testPluginDataDirs?.add(targetEnv.CLAUDE_PLUGIN_DATA);
  let stdout = "";
  let stderr = "";
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, encoding, cb) => {
    if (typeof chunk !== "string") {
      return origStdoutWrite(chunk, encoding, cb);
    }
    stdout += chunk;
    const callback = typeof encoding === "function" ? encoding : cb;
    if (typeof callback === "function") callback();
    return true;
  };
  process.stderr.write = (chunk, encoding, cb) => {
    if (typeof chunk !== "string") {
      return origStderrWrite(chunk, encoding, cb);
    }
    stderr += chunk;
    const callback = typeof encoding === "function" ? encoding : cb;
    if (typeof callback === "function") callback();
    return true;
  };
  for (const key of Object.keys(process.env)) {
    if (!(key in targetEnv)) delete process.env[key];
  }
  Object.assign(process.env, targetEnv);
  if (options.cwd) process.chdir(options.cwd);
  process.exitCode = 0;
  process.argv = [process.execPath, realScript, ...args];
  try {
    await import(`${pathToFileURL(realScript).href}?inproc=${++inProcessCompanionSeq}`);
    const done = options.waitUntil ?? (() => stdout.length > 0 || (process.exitCode ?? 0) !== 0);
    await waitFor(done, `in-process companion ${args[0] ?? ""}`, options.timeout ?? BROKER_READY_MS);
    await new Promise(setImmediate);
    return { status: process.exitCode || 0, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.argv = prevArgv;
    process.exitCode = prevExitCode;
    process.chdir(prevCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
  }
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  fs.appendFileSync(path.join(cwd, ".git", "config"), [
    "",
    "[user]",
    "\tname = Codex Plugin Tests",
    "\temail = tests@example.com",
    "[commit]",
    "\tgpgsign = false",
    "[tag]",
    "\tgpgsign = false",
    ""
  ].join("\n"));
}
