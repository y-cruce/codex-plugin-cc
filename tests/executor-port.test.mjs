import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { findLatestTaskThread, runAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";
import { CodexExecutorJobPort } from "../plugins/codex/scripts/lib/executors/codex-driver.mjs";
import { canonicalTerminalReason, jobStatusForTerminal } from "../plugins/codex/scripts/lib/executor-port.mjs";
import { readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { createJobRecord, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { initGitRepo, isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const terminal = (code) => ({
  turnId: "turn-1",
  sessionId: "executor-session-1",
  status: code === "end_turn" ? "completed" : code === "cancelled" ? "cancelled" : code === "interrupted" ? "interrupted" : "failed",
  reason: canonicalTerminalReason(code, { backendCode: code }),
  finalMessages: [],
  usage: null
});

test("all terminal reasons map to the required job status", () => {
  const cases = new Map([
    ["end_turn", "completed"],
    ["max_tokens", "failed"],
    ["max_turn_requests", "failed"],
    ["refusal", "failed"],
    ["cancelled", "cancelled"],
    ["interrupted", "failed"],
    ["backend_error", "failed"],
    ["transport_closed", "failed"],
    ["unknown", "failed"]
  ]);
  for (const [code, expected] of cases) assert.equal(jobStatusForTerminal(terminal(code), 0), expected, code);
});

test("tracked jobs persist executor identity and do not report refusal as success", async (t) => {
  isolateTestEnvironment(t);
  const repo = makeTempDir();
  initGitRepo(repo);
  const job = createJobRecord({ id: "terminal-refusal", workspaceRoot: repo, executor: "acp" }, {
    env: { CODEX_COMPANION_SESSION_ID: "claude-session-1" }
  });
  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    executor: "acp",
    sessionId: "executor-session-1",
    turnId: "turn-1",
    terminal: terminal("refusal"),
    payload: { value: "refusal" },
    rendered: "refusal",
    summary: "refusal"
  }));
  const stored = readJobFile(resolveJobFile(repo, job.id));
  assert.equal(stored.status, "failed");
  assert.equal(stored.sessionId, "claude-session-1");
  assert.equal(stored.executorSessionId, "executor-session-1");
  assert.equal(stored.result.terminal.reason.code, "refusal");
});

test("job status falls back to exitStatus only without a terminal", () => {
  assert.equal(jobStatusForTerminal(null, 0), "completed");
  assert.equal(jobStatusForTerminal(null, 1), "failed");
});

test("Codex port queues a notification emitted before session creation returns", async () => {
  const requests = [];
  const client = {
    observationVersion: 0,
    notificationHandler: null,
    setNotificationHandler(handler) { this.notificationHandler = handler; },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/start") {
        this.notificationHandler({ method: "thread/started", params: { thread: { id: "early-session" } } });
        return { thread: { id: "early-session" } };
      }
      if (method === "thread/name/set") return {};
      throw new Error(`Unexpected request: ${method}`);
    }
  };
  const port = await CodexExecutorJobPort.open({
    client,
    cwd: process.cwd(),
    job: { id: "early-job" },
    onProgress: null,
    captureTurn: async () => { throw new Error("not used"); }
  });
  const iterator = port.events()[Symbol.asyncIterator]();
  const firstEvent = iterator.next();
  const session = await port.startSession({ cwd: process.cwd(), persistThread: false });
  const event = await firstEvent;
  assert.equal(session.sessionId, "early-session");
  assert.equal(event.done, false);
  assert.equal(event.value.type, "source.unknown");
  assert.equal(event.value.identity.sessionId, "early-session");
  assert.deepEqual(requests.map((request) => request.method), ["thread/start"]);
  await port.close();
  assert.equal((await iterator.next()).done, true);
});


test("Codex turn policy variants reach the recorded server request", async () => {
  const requests = [];
  const client = { notificationHandler: null, setNotificationHandler(handler) { this.notificationHandler = handler; },
    async request(method, params) {
      requests.push({ method, params });
      return { turn: { id: `turn-${requests.length}`, status: "completed" } };
    } };
  const port = await CodexExecutorJobPort.open({ client, cwd: "/repo", job: { id: "policy-job" },
    captureTurn: async (client, sessionId, start, options) => {
      const response = await start();
      options.onResponse(response);
      return { turnId: response.turn.id, finalTurn: response.turn, lastAgentMessage: "written", error: null };
    } });
  for (const [sandbox, network, policy] of [
    ["danger-full-access", false, { type: "dangerFullAccess" }],
    ["workspace-write", true, { type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false }],
    ["read-only", false, { type: "readOnly", networkAccess: false }]
  ]) {
    const turn = await port.startTurn({ sessionId: "session-1", prompt: "write redirected", sandbox, network });
    assert.equal((await turn.done).status, "completed");
    assert.deepEqual(requests.at(-1).params.sandboxPolicy, policy);
  }
  await port.close();
});


test("a task reuses its checked capability result without caching later probes", async (t) => {
  isolateTestEnvironment(t);
  process.env.PATH = makeTempDir();
  const client = { transport: "direct", stderr: "", async close() {}, async request(method) {
    assert.equal(method, "thread/list");
    return { data: [{ id: "session-1", name: "Codex Companion Task fixture" }] };
  } };
  t.mock.method(CodexAppServerClient, "connect", async () => client);
  t.mock.method(CodexExecutorJobPort, "open", async () => ({
    async *events() {}, async close() {}, async startSession() { return { sessionId: "session-1" }; },
    async startTurn() { return { done: Promise.resolve(terminal("end_turn")), capture: Promise.resolve({
      turnId: "turn-1", lastAgentMessage: "done", reasoningSummary: [], finalTurn: { status: "completed" },
      error: null, fileChanges: [], commandExecutions: []
    }) }; }
  }));
  const availability = { available: true, detail: "already checked" };
  assert.equal((await findLatestTaskThread(process.cwd(), availability)).id, "session-1");
  assert.equal((await runAppServerTurn(process.cwd(), { availability, prompt: "basic" })).finalMessage, "done");
  const missing = /Codex CLI is not installed or is missing required runtime support/;
  await assert.rejects(runAppServerTurn(process.cwd(), { prompt: "basic" }), missing);
  await assert.rejects(findLatestTaskThread(process.cwd()), missing);
  await assert.rejects(runAppServerTurn(process.cwd(), { availability: { available: false }, prompt: "basic" }), missing);
});
