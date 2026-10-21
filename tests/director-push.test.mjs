import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DirectorChannel } from "../plugins/codex/scripts/director-channel.mjs";
import { deliveryRoot, pendingEvents, acceptDirectorEvents, eventFromRef } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { BROKER_READY_MS, closeTestBroker, initGitRepo, isolateTestEnvironment, makeTempDir, waitFor } from "./helpers.mjs";

const BROKER = path.resolve("plugins/codex/scripts/app-server-broker.mjs");

test("two repository brokers push answerable questions/notes through a delta flood and only explicit job endings", async (t) => {
  isolateTestEnvironment(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxp-"));
  const bin = makeTempDir();
  fs.copyFileSync(new URL("live-codex-fixture.cjs", import.meta.url), path.join(bin, "codex"));
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
  const root = deliveryRoot();
  const messages = [];
  const channel = new DirectorChannel({ root, dir, send: async (message) => {
    await acceptDirectorEvents([eventFromRef(message.params.meta.delivery)], "channel", async () => { messages.push(message.params); return {}; });
  } });
  await channel.start("owner");
  await channel.handle({ action: "confirm", sessionId: "owner", instance: channel.instance, nonce: channel.nonce });
  t.after(async () => { await channel.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const repos = [];
  for (let index = 0; index < 2; index++) {
    const repo = fs.realpathSync(makeTempDir());
    initGitRepo(repo);
    const endpoint = createBrokerEndpoint(path.join(dir, `b${index}`));
    fs.mkdirSync(path.join(dir, `b${index}`));
    // Deliberately give the broker a different inherited session. The job owns routing.
    const env = { ...buildEnv(bin), CODEX_COMPANION_SESSION_ID: "wrong-owner", CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
    const broker = spawn(process.execPath, [BROKER, "serve", "--cwd", repo, "--endpoint", endpoint, "--idle-timeout-ms", "2000"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    broker.stderr.on("data", (chunk) => { errors += chunk; });
    const closed = new Promise((resolve) => broker.on("exit", resolve));
    const clients = [];
    t.after(() => closeTestBroker(broker, closed, endpoint, clients));
    assert.ok(await waitForBrokerEndpoint(endpoint, BROKER_READY_MS), errors);
    const owner = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
    clients.push(owner);
    const job = { id: `job-${index}`, workspaceRoot: repo, sessionId: "owner", status: "running", pid: process.pid, executor: "codex" };
    upsertJob(repo, job);
    writeJobFile(repo, job.id, job);
    await owner.request("broker/job-register", { cwd: repo, jobId: job.id });
    const { thread } = await owner.request("thread/start", { cwd: repo });
    const notices = [];
    owner.setNotificationHandler((message) => notices.push(message));
    const start = (text) => owner.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
    repos.push({ repo, endpoint, owner, job, thread, notices, start, broker, closed });
  }
  const [first, second] = repos;
  await first.start("flood ask and notify");
  await waitFor(() => messages.some((message) => message.meta.event === "question_opened") && messages.some((message) => message.meta.event === "director_notified"));
  const question = messages.find((message) => message.meta.event === "question_opened");
  assert.match(question.content, /job=job-0.*request=question-1 ids=source,scope: \[source\] Which source\? Options: Local \(Use saved data\); Remote \(Fetch new data\)\. \| \[scope\] Which scope\? Options: Small \(Only this module\)/);
  assert.match(messages.find((message) => message.meta.event === "director_notified").content, /pending_request=question-1 Need both decisions/);
  assert.equal(question.meta.session, "owner");
  const status = await first.owner.request("broker/status", { threadId: first.thread.id });
  assert.equal(status.questions[0].requestId, "question-1");
  await waitFor(async () => (await first.owner.request("broker/status", { threadId: first.thread.id })).notifications.length === 0);
  await first.owner.request("broker/answer", { threadId: first.thread.id, turnId: status.turnId, requestId: "question-1",
    answers: { source: { answers: ["Local"] }, scope: { answers: ["Small"] } } });
  await waitFor(() => first.notices.some((message) => message.method === "turn/completed"));
  assert.equal(messages.filter((message) => message.meta.event.startsWith("job_")).length, 0, "turn completion is not a job ending");
  const { turn } = await first.start("hold");
  await first.owner.request("broker/queue", { threadId: first.thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "queued" }] });
  await first.owner.request("turn/steer", { threadId: first.thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "finish" }] });
  await waitFor(() => first.notices.some((message) => message.method === "turn/completed" && message.params.queuedInput));
  await first.start("continued");
  assert.equal(messages.filter((message) => message.meta.event.startsWith("job_")).length, 0);
  // A second broker/repository sends to the same consumer without discovery.
  await second.start("notify:from the other repo");
  await waitFor(() => messages.some((message) => message.meta.job === second.job.id));
  for (const [index, entry] of repos.entries()) {
    const status = index === 0 ? "completed" : "cancelled";
    writeJobFile(entry.repo, entry.job.id, { ...entry.job, status, completedAt: new Date().toISOString() });
    await entry.owner.request("broker/job-finish", { cwd: entry.repo, jobId: entry.job.id });
    await entry.owner.request("broker/job-finish", { cwd: entry.repo, jobId: entry.job.id });
  }
  await waitFor(() => messages.filter((message) => message.meta.event.startsWith("job_")).length === 2);
  assert.deepEqual(messages.filter((message) => message.meta.event.startsWith("job_")).map((message) => message.meta.event).sort(), ["job_cancelled", "job_completed"]);
  for (const entry of repos) entry.owner.socket.destroy();
  await Promise.all(repos.map((entry) => entry.closed));
  assert.ok(repos.every((entry) => entry.broker.exitCode === 0), "outbound channel traffic must not defeat broker idle exit");
  await waitFor(() => pendingEvents(root, "owner").length === 0);
});
