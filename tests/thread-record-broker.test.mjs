import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { readHistory, readRecordHistory } from "../plugins/codex/scripts/lib/job-event-store.mjs";
import { resolveJobHistory } from "../plugins/codex/scripts/lib/history-resolver.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { BROKER_READY_MS, initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const BROKER = path.join(ROOT, "plugins/codex/scripts/app-server-broker.mjs");
const TERMINAL = new Set(["job.completed", "job.failed", "job.cancelled"]);

async function waitFor(predicate, description, timeoutMs = BROKER_READY_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("broker seam binds resumed dispatches to one shared record", async (t) => {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  const bin = makeTempDir();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxr-"));
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  initGitRepo(repo);
  const endpoint = createBrokerEndpoint(socketDir);
  const wrapper = path.join(socketDir, "thread-record-broker.mjs");
  fs.writeFileSync(wrapper, `import { main } from ${JSON.stringify(pathToFileURL(BROKER).href)};\nmain({ threadRecords: true }).catch((error) => { console.error(error); process.exit(1); });\n`);
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"), CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  const stateDir = resolveStateDir(repo);
  if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previous;
  const broker = spawn(process.execPath, [wrapper, "serve", "--endpoint", endpoint, "--cwd", repo,
    "--pid-file", path.join(socketDir, "broker.pid"), "--idle-timeout-ms", "600000"], { env });
  let brokerErrors = "";
  broker.stderr.on("data", (chunk) => { brokerErrors += chunk; });
  const closed = new Promise((resolve) => broker.on("exit", resolve));
  const workers = new Set();
  t.after(async () => {
    for (const pid of workers) {
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await sendBrokerShutdown(endpoint);
    if (broker.exitCode === null) broker.kill();
    await closed;
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, BROKER_READY_MS), true, brokerErrors);
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args, "--cwd", repo], { cwd: repo, env });
  const start = async (prompt, options = []) => {
    const launched = cli("task", "--background", ...options, "--label", prompt, "--json", prompt);
    assert.equal(launched.status, 0, launched.stderr);
    const result = JSON.parse(launched.stdout);
    const jobFile = result.logFile.replace(/\.log$/, ".json");
    let last = null;
    const job = await waitFor(() => {
      try {
        const value = JSON.parse(fs.readFileSync(jobFile, "utf8"));
        last = value;
        if (value.pid) workers.add(value.pid);
        return TERMINAL.has(`job.${value.status}`) && value.threadId ? value : null;
      } catch { return null; }
      // `--background` returns as soon as the detached worker is spawned, so
      // this waits out that worker's own startup and broker connect, not just
      // the round.
    }, `${prompt} completion`, BROKER_READY_MS).catch((error) => {
      const log = last?.logFile && fs.existsSync(last.logFile) ? fs.readFileSync(last.logFile, "utf8") : "";
      const records = fs.existsSync(path.join(stateDir, "thread-records"))
        ? fs.readdirSync(path.join(stateDir, "thread-records")).map((id) => ({ id,
          manifest: JSON.parse(fs.readFileSync(path.join(stateDir, "thread-records", id, "manifest.json"), "utf8")) })) : [];
      throw new Error(`${error.message}; job=${JSON.stringify(last)}; log=${JSON.stringify(log)}; records=${JSON.stringify(records)}; broker=${brokerErrors}`);
    });
    return { id: result.jobId, job };
  };

  const first = await start("first round");
  const second = await start("second round", ["--thread", first.job.threadId]);
  const firstLocation = await resolveJobHistory(repo, first.id, { stateDir });
  const secondLocation = await resolveJobHistory(repo, second.id, { stateDir });
  assert.equal(firstLocation.recordId, secondLocation.recordId);

  const firstHistory = await waitFor(async () => {
    const history = await readHistory(repo, first.id, { stateDir });
    return history.events.some((event) => TERMINAL.has(event.type)) ? history : null;
  }, "first terminal history");
  const secondHistory = await waitFor(async () => {
    const history = await readHistory(repo, second.id, { stateDir });
    return history.events.some((event) => TERMINAL.has(event.type)) ? history : null;
  }, "second terminal history");
  const recordHistory = await readRecordHistory(repo, firstLocation.recordId, { stateDir });
  assert.equal(firstHistory.events.filter((event) => TERMINAL.has(event.type)).length, 1);
  assert.equal(secondHistory.events.filter((event) => TERMINAL.has(event.type)).length, 1);
  assert.ok(firstHistory.events.every((event) => event.jobId === first.id));
  assert.ok(secondHistory.events.every((event) => event.jobId === second.id));
  assert.ok(recordHistory.events.every((event, index) => index === 0 || BigInt(event.seq) > BigInt(recordHistory.events[index - 1].seq)));
  assert.ok(BigInt(secondHistory.events[0].seq) > BigInt(firstHistory.events.at(-1).seq));
});
