#!/usr/bin/env node
// Opt-in integration check. Uses real agents and separate Git/data/session fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { acceptDirectorEvents, deliveryRefs, eventFromRef, deliveryRoot, pendingEvents } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { listJobs, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const companion = process.env.CODEX_COMPANION ?? path.join(repo, "plugins/codex/scripts/codex-companion.mjs");
const director = process.env.CODEX_SMOKE_DIRECTOR ?? path.resolve(repo, "../code-director");
const dispatch = path.join(director, "skills/code-director/scripts/dispatch.sh");
const skill = path.join(director, "skills/codex-executor/SKILL.md");
const memory = process.env.CODEX_SMOKE_MEMORY_INDEX;
const root = process.env.CODEX_SMOKE_OUTPUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-smoke-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const enabled = process.env.CODEX_REAL_ACP_SMOKE === "1";
const monitorMode = process.env.CODEX_SMOKE_MONITOR === "1";
if (!enabled) {
  console.log("SKIP real ACP smoke: set CODEX_REAL_ACP_SMOKE=1; optionally CODEX_SMOKE_OUTPUT and CODEX_SMOKE_MEMORY_INDEX.");
  process.exit(0);
}
fs.mkdirSync(root, { recursive: true });

async function command(argv, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `command exited ${code}`));
      else resolve(stdout);
    });
  });
}

async function smoke(agent) {
  const launcher = agent === "agy" ? process.env.CODEX_DIRECTOR_ANTIGRAVITY_COMMAND ?? path.join(os.homedir(), ".local/bin/agy")
    : agent === "dsh" ? process.env.CODEX_DIRECTOR_DSH_COMMAND ?? path.join(os.homedir(), ".dsh/bin/dsh-acp")
      : process.env.CODEX_DIRECTOR_QODER_COMMAND ?? "qoder";
  const available = launcher.includes(path.sep) ? fs.existsSync(launcher)
    : spawnSync("which", [launcher], { stdio: "ignore" }).status === 0;
  if (!available) { console.log(`SKIP ${agent}: launcher unavailable (${launcher})`); return; }
  const directory = path.join(root, agent);
  const cwd = path.join(directory, "repo");
  const data = path.join(directory, "data");
  fs.mkdirSync(cwd, { recursive: true });
  const init = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const log = fs.createWriteStream(path.join(directory, "events.jsonl"));
  const record = (event, value) => log.write(JSON.stringify({ at: new Date().toISOString(), event, value }) + "\n");
  const sessionId = randomUUID();
  const env = { ...process.env, TMPDIR: "/tmp", CLAUDE_PLUGIN_DATA: data, CODEX_COMPANION_SESSION_ID: sessionId,
    CODEX_COMPANION: companion, CODEX_DIRECTOR_DSH_COMMAND: process.env.CODEX_DIRECTOR_DSH_COMMAND ?? path.join(os.homedir(), ".dsh/bin/dsh-acp") };
  delete env.CODEX_COMPANION_TRANSCRIPT_PATH;
  delete env.CODEX_COMPANION_DIRECTOR_AGENT_ID;
  delete env.CLAUDECODE;
  const notify = `SMOKE_NOTIFY_${agent}`;
  const done = `SMOKE_DONE_${agent}`;
  const question = agent === "dsh"
    ? 'Run node "$CODEX_ACP_COMPANION_PATH" ask-director --question "Choose FIRST or SECOND" --options \'["FIRST","SECOND"]\' using bash timeoutMs:600000; wait for stdout. If it is moved to a background job, collect that job with job_output; do not rerun the command.'
    : 'Use your native interactive question tool to ask the director to choose FIRST or SECOND. Wait for the reply; never choose for the director.';
  const brief = path.join(directory, "dispatch.md");
  fs.writeFileSync(brief, `MODE: investigate
NAME: ACP smoke ${agent}
CWD: ${cwd}
EXECUTOR: ${agent}

This is an authorized isolated smoke check. Use file reading tools to read ${skill}${memory ? ` and ${memory}` : ""}.
Send the director notification ${notify} with node "$CODEX_ACP_COMPANION_PATH" notify-director "${notify}", then run sleep 3.
${question}
Finish with ${done}, the answer received, and the last nonempty line of each requested file copied verbatim.
If your agent lacks shell or a native question tool, report SMOKE_SKIP plus the missing capability; do not invent a result.
`);
  let id, monitor, monitorClosed;
  try {
    const launched = await command(["bash", dispatch, "dispatch", brief], env, cwd);
    record("launch", launched);
    id = /^JOB:\s*(\S+)/m.exec(launched)?.[1];
    assert.ok(id, launched);
    const oldData = process.env.CLAUDE_PLUGIN_DATA;
    // State helpers use the process environment; calls are scoped and synchronous.
    const withData = fn => {
      process.env.CLAUDE_PLUGIN_DATA = data;
      try { return fn(); } finally {
        if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
        else process.env.CLAUDE_PLUGIN_DATA = oldData;
      }
    };
    const stateDir = withData(() => resolveStateDir(cwd));
    const received = [], monitorEvents = [];
    if (monitorMode) {
      monitor = spawn(process.execPath, [companion, "events", "--cwd", cwd, "--session", sessionId, "--poll-ms", "1000"],
        { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
      monitorClosed = new Promise(resolve => monitor.once("close", resolve));
      monitor.stderr.on("data", data => record("monitor.stderr", data.toString()));
      createInterface({ input: monitor.stdout }).on("line", line => {
        record("monitor.output", line);
        const events = deliveryRefs(line).map(eventFromRef).filter(Boolean);
        monitorEvents.push(...events);
        received.push(...events);
      });
    }
    const snapshot = () => JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${id}.json`), "utf8"));
    let notified = false, answered = false, terminal = null;
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline && !terminal) {
      for (const event of monitorMode ? received.splice(0) : pendingEvents(deliveryRoot(stateDir), sessionId)) {
        record("received", event);
        if (event.type === "director.notified") {
          assert.equal(event.payload.message, notify);
          assert.equal(snapshot().status, "running", "notification must arrive before the terminal");
          notified = true;
          // The host can queue a Monitor line for longer than the 5s attempt
          // lease. Do not accept it yet: the same process must not print again.
          if (monitorMode) await pause(7000);
        }
        if (event.type === "question.opened") {
          const status = JSON.parse(await command([process.execPath, companion, "status", id, "--cwd", cwd, "--json"], env, cwd)).job;
          const pending = status.live.questions.find(entry => String(entry.requestId) === String(event.payload.requestId));
          assert.ok(pending);
          await pause(2000);
          const answerFile = path.join(directory, "answers.json");
          const answers = Object.fromEntries(pending.questions.map(field =>
            [field.id, { answers: [field.options?.[1]?.value ?? field.options?.[1]?.label ?? "SECOND"] }]));
          fs.writeFileSync(answerFile, JSON.stringify(answers));
          record("answer", { requestId: pending.requestId, answers });
          await command(["bash", dispatch, "answer", id, String(pending.requestId), answerFile, "--cwd", cwd], env, cwd);
          answered = true;
        }
        if (event.type.startsWith("job.")) terminal = event;
        await acceptDirectorEvents([event], monitorMode ? "monitor" : "smoke", async () => ({}));
      }
      if (!terminal) await pause(300);
    }
    assert.ok(terminal, "smoke task timed out");
    const stored = JSON.parse(await command([process.execPath, companion, "result", id, "--cwd", cwd, "--json"], env, cwd)).storedJob;
    const output = stored.result?.rawOutput ?? "";
    if (output.includes("SMOKE_SKIP")) {
      console.log(`SKIP ${agent}: ${output}`);
      record("skip", output);
      return;
    }
    assert.equal(terminal.type, "job.completed", terminal.text);
    assert.ok(notified && answered, "notification and director answer are required");
    assert.ok(output.includes(done) && output.includes("SECOND"), output);
    assert.ok(terminal.text.includes(done), terminal.text);
    if (monitorMode) {
      const notes = monitorEvents.filter(event => event.type === "director.notified");
      assert.equal(notes.length, 1, "Monitor notification must appear only once, including delayed ingress");
      record("monitor.passed", { notificationLines: notes.length, receiptDelayMs: 7000 });
    }
    for (const file of [skill, ...(memory ? [memory] : [])]) {
      const last = fs.readFileSync(file, "utf8").trim().split("\n").at(-1);
      assert.ok(output.includes(last), `missing file-read evidence: ${file}\n${output}`);
    }
    if (agent === "agy") {
      const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
      assert.ok(!untracked.stdout.includes("skills/system/run-workflow/SKILL.md"), untracked.stdout);
    }
    const jobs = withData(() => listJobs(cwd));
    assert.equal(jobs.find(job => job.id === id)?.status, "completed");
    record("passed", { id, terminal: terminal.text, output });
    console.log(`PASS ${agent}: ${id}; notified before completion; SECOND received; skill${memory ? " and memory index" : ""} read.`);
  } finally {
    if (monitor) { monitor.kill("SIGTERM"); await monitorClosed; }
    if (id && fs.existsSync(path.join(data, "state"))) {
      const jobFile = path.join(data, "state");
      for (const name of fs.readdirSync(jobFile)) {
        const file = path.join(jobFile, name, "jobs", `${id}.json`);
        if (fs.existsSync(file) && ["running", "queued"].includes(JSON.parse(fs.readFileSync(file)).status)) {
          await command([process.execPath, companion, "cancel", id, "--cwd", cwd, "--json"], env, cwd).catch(() => {});
        }
      }
    }
    log.end();
  }
}

for (const agent of process.argv.slice(2).length ? process.argv.slice(2) : ["agy", "dsh", "qoder"]) {
  if (!["agy", "dsh", "qoder"].includes(agent)) throw new Error(`Unknown smoke agent: ${agent}`);
  await smoke(agent);
}
console.log(`Evidence: ${root}`);
