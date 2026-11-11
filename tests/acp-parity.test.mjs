import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveTaskExecutor } from "../plugins/codex/scripts/codex-companion.mjs";
import { AcpExecutorJobPort } from "../plugins/codex/scripts/lib/executors/acp-driver.mjs";
import { excludeGeneratedSkill } from "../plugins/codex/scripts/lib/git.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

function portFixture(options = {}) {
  const job = { id: "round-one", executor: "acp", sessionId: "director", workspaceRoot: "/tmp" };
  const port = new AcpExecutorJobPort({ job, env: { HOME: "/tmp/parity-home" }, ...options });
  const events = [], pushes = [];
  port.runtime = { record: async (event) => events.push(event) };
  port.director = { publish: (job, type, payload) => pushes.push({ job, type, payload }) };
  port.initializeResponse = { agentInfo: { name: "antigravity-acp" } };
  port.sessionId = "session";
  port.adapter = port.createAdapter(job);
  port.adapter.bindSession(port.sessionId);
  port.activeTurn = { turnId: "turn", accepting: true, messages: [] };
  port.adapter.turnId = "turn";
  return { port, events, pushes };
}

const permission = (toolCallId, options = [{ optionId: "first", name: "First", kind: "allow_once" },
  { optionId: "second", name: "Second", kind: "allow_once" }]) =>
  ({ toolCall: { toolCallId, title: "Which source?" }, options });

test("agy interactions wait for the director under allow-once, with canonical question lifecycle", async () => {
  const { port, events, pushes } = portFixture({ permissionPolicy: "allow-once" });
  const reply = port.requestPermission(permission("interaction_12345678"));
  await new Promise(setImmediate);
  const [pending] = port.permissions.values();
  assert.ok(pending.timer);
  assert.equal(port.liveStatus().questions[0].message, "Which source?");
  assert.ok(port.liveStatus().questions[0].expiresAt > Date.now());
  assert.equal(events.filter((event) => event.type === "question.opened").length, 1);
  assert.equal(pushes.find((event) => event.type === "question.opened").payload.message, "Which source?");
  assert.equal(events.some((event) => event.type === "permission.resolved"), false);
  await port.answerPermission({ requestId: pending.requestId, outcome: "selected", optionId: "second" });
  assert.deepEqual(await reply, { outcome: { outcome: "selected", optionId: "second" } });
  assert.ok(events.some((event) => event.type === "question.closed"));
  assert.equal(port.liveStatus().questions.length, 0);
  assert.deepEqual(await port.requestPermission(permission("normal-tool")), { outcome: { outcome: "selected", optionId: "first" } });
});

test("ACP question and permission expiration cancel pending requests and fail the active turn", async () => {
  for (const kind of ["question", "permission", "interaction"]) {
    const { port, events, pushes } = portFixture({ permissionPolicy: "ask", inputTimeoutMs: 10 });
    let cancels = 0;
    port.connection = { cancel: async () => { cancels++; } };
    const reply = kind === "question" ? port.createElicitation({ message: "Choose", requestedSchema: {
      type: "object", properties: { choice: { type: "string", enum: ["first", "second"] } } } })
      : port.requestPermission(permission(kind === "interaction" ? "interaction_abcdef01" : "ordinary"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(await reply, kind === "question" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } });
    assert.equal(cancels, 1);
    assert.match(port.activeTurn.error.message, /timed out/);
    assert.equal(port.questions.size + port.permissions.size, 0);
    assert.ok(pushes.some((event) => event.type === "question.expired"));
    assert.ok(events.some((event) => event.type === (kind === "question" ? "question.closed" : "permission.resolved")));
  }
});

test("ACP notifications retain unacknowledged notes and publish under the current queued job", async () => {
  const { port, events, pushes } = portFixture();
  const first = await port.notifyDirector("Need a decision now.");
  assert.equal(port.liveStatus().notifications[0].id, first.notificationId);
  assert.equal(events.at(-1).type, "director.notified");
  assert.deepEqual(port.ackNotifications([first.notificationId]), { remaining: 0 });
  port.job = { ...port.job, id: "round-two" };
  port.adapter = port.createAdapter(port.job);
  port.adapter.bindSession(port.sessionId);
  await port.notifyDirector("The next round needs a decision.");
  assert.equal(pushes.at(-1).job.id, "round-two");
  await assert.rejects(port.notifyDirector("x".repeat(401)), /400/);
});

test("the shell question uses the existing answer path and accepts free text", async () => {
  const { port, events } = portFixture();
  const reply = port.askDirector("Which source?", ["First", "Second"]);
  const [pending] = port.questions.values();
  assert.equal(events[0].source.method, "executor/ask-director");
  assert.deepEqual(port.liveStatus().questions[0].questions[0].options.map(option => option.label), ["First", "Second"]);
  await port.answerQuestion({ requestId: pending.requestId, action: "accept", values: { answer: { answers: ["Use another source"] } } });
  assert.deepEqual(await reply, { answer: "Use another source" });
  assert.ok(events.some(event => event.type === "question.closed"));
  const cancelled = port.askDirector("Try again?", ["A", "B"]);
  await port.cancelPending();
  await assert.rejects(cancelled, /cancelled/);
});

test("agy session scope keeps additional roots and HOME; generated skill exclusion is exact and idempotent", (t) => {
  const { port } = portFixture();
  const params = port.sessionRequest({ cwd: "/tmp/task", additionalDirectories: ["/tmp/extra"] }).params;
  assert.ok(params.additionalDirectories.includes("/tmp/parity-home"));
  assert.ok(params.additionalDirectories.includes("/tmp/extra"));
  const cwd = makeTempDir();
  initGitRepo(cwd);
  excludeGeneratedSkill(cwd);
  const file = path.resolve(cwd, run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd }).stdout.trim());
  const first = fs.readFileSync(file, "utf8");
  const subdirectory = path.join(cwd, "nested");
  fs.mkdirSync(subdirectory);
  excludeGeneratedSkill(subdirectory);
  assert.equal(fs.readFileSync(file, "utf8"), first);
  assert.ok(first.includes("/skills/system/run-workflow/SKILL.md"));
  assert.equal(run("git", ["check-ignore", "skills/system/custom.md"], { cwd }).status, 1);
});

test("thread executor resolution preserves Codex and complete ACP launch identity", (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  for (const executor of ["codex", "acp"]) {
    const request = { executor, executorPreset: executor === "acp" ? "dsh" : "codex",
      executorCommand: "/custom/dsh", executorArgs: ["--profile", "acp"] };
    const job = { id: executor, workspaceRoot: cwd, threadId: executor + "-thread", executor, request };
    upsertJob(cwd, job);
    writeJobFile(cwd, job.id, job);
    const resolved = resolveTaskExecutor(cwd, job.threadId, {});
    assert.equal(resolved.executor, executor);
    assert.deepEqual(resolved.previous.executorArgs, request.executorArgs);
    assert.throws(() => resolveTaskExecutor(cwd, job.threadId, { "executor-preset": "agy" }), /belongs to executor/);
  }
});
