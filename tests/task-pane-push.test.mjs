import test from "node:test";
import assert from "node:assert/strict";
import { pushLine, registerTaskPane, shouldDropMonitorExpiry } from "../plugins/codex/hooks/task-pane/register.ts";
import { paneBody } from "../plugins/codex/hooks/task-pane/pane.ts";
import { isOver } from "../plugins/codex/hooks/live-tool-row/view.ts";

const view = {
  pendingQuestion: { requestId: "0", text: "是否允许修改测试文件？", openedAt: "", expiresAt: null },
  lastMessage: { kind: "assistant", text: "四条都修好了", at: "" },
};

test("task pane follows the new session after clear on the first Bash dispatch", async () => {
  const hooks = new Map();
  const timers = [];
  const observed = [];
  const monitors = [];
  const opened = [];
  const stored = new Map();
  const now = 1_000_000;
  let sessionId = "session-a";
  let jobs = ["a.json"];
  const job = (id) => JSON.stringify({ sessionId: `session-${id}`, workspaceRoot: `/work/${id}` });
  const live = (id) => JSON.stringify({
    schemaVersion: 1, recordId: `job-${id}`, jobId: `job-${id}`, label: `job ${id}`,
    status: "running", startedAt: new Date(now).toISOString(), endedAt: null,
    activeRoundId: `job-${id}`, latestRoundId: `job-${id}`, rounds: [], tail: [],
  });
  const engine = {
    plugin: { name: "codex" },
    session: { surfaces: async () => ["terminal"], cwd: async () => "/work/main", id: async () => sessionId },
    env: { get: async () => "/home/test" },
    clock: { now: async () => now, every: (ms, fn) => timers.push([ms, fn]) },
    store: { get: async (key) => stored.get(key), set: async (key, value) => { stored.set(key, value); } },
    fs: {
      list: async (path) => path === "/home/test/.claude/plugins/data" ? [{ kind: "dir", name: "codex" }]
        : path === "/home/test/.claude/plugins/data/codex/state" ? [{ kind: "dir", name: "main" }]
        : path.endsWith("/jobs") ? jobs.map((name) => ({ name })) : [],
      stat: async () => ({ mtimeMs: now }),
      read: async (path) => path.endsWith(".json") ? job(path.endsWith("a.json") ? "a" : "b")
        : live(path.endsWith("/a") ? "a" : "b"),
    },
    process: { run: async (args, options) => {
      if (args[0] === "bash") return { exitCode: 0, stdout: "/companion.mjs\n", stderr: "" };
      if (args[0] === "pgrep") return { exitCode: 1, stdout: "", stderr: "" };
      observed.push({ cwd: options.cwd, sessionId: options.env.CODEX_COMPANION_SESSION_ID });
      const id = options.cwd.slice(-1);
      return { exitCode: 0, stdout: JSON.stringify({ threads: options.cwd === `/work/${id}` && options.env.CODEX_COMPANION_SESSION_ID === `session-${id}`
        ? [{ id: `job-${id}`, recordId: `job-${id}`, jobId: `job-${id}`, label: `job ${id}`,
          status: "running", sessionIds: [`session-${id}`], viewPath: `/view/${id}`, historyAvailable: false }] : [] }), stderr: "" };
    } },
    tool: { call: async (request) => { monitors.push(request); } },
    ui: { open: async (request) => { opened.push(request); }, invalidate: () => {}, log: () => {}, toast: () => {} },
  };
  const on = (event, options, callback) => hooks.set(event, callback ?? options);
  const until = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("task pane poll did not finish");
  };
  registerTaskPane(on);
  await hooks.get("session.start")(engine, { isInteractive: true }, async () => {});
  await until(() => stored.has("codex:tasks:session-a"));
  assert.ok(monitors.some((request) => request.command.includes("--session session-a")));

  sessionId = "session-b";
  jobs = ["a.json", "b.json"];
  observed.length = 0;
  await hooks.get("tool.call")(engine, { command: "bash dispatch.sh" }, async () => {});
  await until(() => stored.has("codex:tasks:session-b"));

  assert.equal(timers.length, 3);
  assert.equal(stored.get("codex:tasks:session-b:since"), now - 60_000);
  assert.ok(observed.some((call) => call.cwd === "/work/b" && call.sessionId === "session-b"));
  assert.equal(observed.some((call) => call.cwd === "/work/a"), false);
  assert.ok(monitors.some((request) => request.command.includes("events --cwd /work/b --session session-b")));
  assert.match((await hooks.get("command.run")(engine, { command: "tasks", args: "a" }, async () => {})).text,
    /No task matches/);
  assert.equal(opened.at(-1)?.id, "codex_tasks");
});

test("a push line survives an event with no body of its own", () => {
  // question.opened and job.* arrive with text null: the regression that dropped
  // them cost every structured question its push.
  const cases = [
    [{ type: "question.opened" }, view, "job · question.opened: 是否允许修改测试文件？"],
    [{ type: "job.completed" }, view, "job · job.completed: 四条都修好了"],
    [{ type: "director.notified", text: "读完了协议定义" }, view, "job · director.notified: 读完了协议定义"],
    // Nothing to quote, but the ending itself is still the news.
    [{ type: "job.failed" }, { pendingQuestion: null, lastMessage: null }, "job · job.failed"],
    // Replayed from before this session's cursor floor, already answered.
    [{ type: "question.opened" }, { pendingQuestion: null, lastMessage: null }, null],
  ];
  for (const [event, data, expected] of cases) {
    assert.equal(pushLine("job", event, data), expected, event.type);
  }
});

test("only expiry notices for monitors owned by the task pane are dropped", () => {
  const notice = (description, event) => `<task-notification>
<summary>Monitor event: "${description}"</summary>
<event>${event}</event>
</task-notification>`;
  const watched = new Set(["/work/alpha"]);
  const live = new Set(["/work/alpha"]);
  const cases = [
    [notice("Codex job events in alpha", "[Monitor expired after 30 minutes with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]"), live, true, true],
    [notice("Codex job events in alpha", "[Monitor expired after 30 minutes with 2 events delivered. Re-arm it if you still need the watch.]"), live, true, true],
    [notice("Codex job events in alpha", "[Monitor stopped]"), live, true, false],
    [notice("Codex job events in alpha", 'Monitor "Codex job events in alpha" stream ended'), live, true, false],
    [notice("Codex job events in alpha", "DONE job-123"), live, true, false],
    [notice("Codex job events in beta", "[Monitor expired after 30 minutes with no events delivered.]"), live, true, false],
    [notice("Codex job events in alpha", "[Monitor expired after 30 minutes with no events delivered.]"), new Set(), true, false],
    [notice("Codex job events in alpha", "[Monitor expired after 30 minutes with no events delivered.]"), live, false, false],
  ];
  for (const [text, liveRoots, canRearm, expected] of cases) {
    assert.equal(shouldDropMonitorExpiry(text, watched, liveRoots, canRearm), expected, text);
  }
});

test("a thread is over when it has no active round, with legacy views unchanged", () => {
  const cases = [
    [{ status: "running", endedAt: null, activeRoundId: null }, true],
    [{ status: "completed", endedAt: "2026-09-20T05:55:26.873Z", activeRoundId: "task-next" }, false],
    [{ status: "running", endedAt: "2026-09-20T05:55:26.873Z" }, true],
    [{ status: "running", endedAt: null }, false],
    [{ status: "completed", endedAt: null }, true],
    [{ status: "waiting-for-answer", endedAt: null }, false],
  ];
  for (const [view, expected] of cases) assert.equal(isOver(view), expected, JSON.stringify(view));
});

test("task pane renders one thread row with both rounds in trace order", () => {
  const element = (type) => ({ children, ...props }) => ({ type, props, children: Array.isArray(children) ? children : [children ?? ""] });
  const ui = { Box: element("Box"), Text: element("Text"), Code: element("Code"), Button: element("Button") };
  const data = {
    schemaVersion: 1, recordId: "task-old", jobId: "task-new", label: "newest", threadId: "thread-1",
    startedAt: "2026-09-21T01:00:00Z", endedAt: "2026-09-21T02:00:00Z", turnId: "turn-new",
    activeRoundId: null, latestRoundId: "task-new", status: "completed", executor: { kind: "codex", label: "Codex" },
    activeCommands: [], lastMessage: { kind: "assistant", text: "the answer", at: "2026-09-21T02:00:00Z" }, files: [], pendingQuestion: null, plan: null, subAgents: [], prompt: null,
    usage: { inputTokens: 3, outputTokens: 3, cachedInputTokens: 0, complete: true },
    history: { committedSeq: "4", continuity: "complete" },
    rounds: [
      { jobId: "task-old", sessionId: "session", label: "opening round", prompt: "round one brief", executorTurnIds: ["turn-old"], firstSeq: "1", lastSeq: "2",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, complete: true }, result: null, status: "completed",
        startedAt: "2026-09-21T01:00:00Z", endedAt: "2026-09-21T01:30:00Z" },
      { jobId: "task-new", sessionId: "session", label: "newest", prompt: "round two brief", executorTurnIds: ["turn-new"], firstSeq: "3", lastSeq: "4",
        usage: { inputTokens: 2, outputTokens: 2, cachedInputTokens: 0, complete: true }, result: null, status: "completed",
        startedAt: "2026-09-21T01:30:00Z", endedAt: "2026-09-21T02:00:00Z" },
    ],
    tail: [
      { seq: "2", at: "2026-09-21T01:30:00Z", type: "director.notified", text: "first round trace" },
      { seq: "2", at: "2026-09-21T01:30:00Z", type: "job.completed", text: "Job completed" },
      { seq: "4", at: "2026-09-21T02:00:00Z", type: "director.notified", text: "second round trace" },
      { seq: "4", at: "2026-09-21T02:00:00Z", type: "message.delta", text: "the answer", from: "0" },
    ],
  };
  const tree = paneBody(ui, [data], 100, 20, Date.parse(data.endedAt), null, () => {});
  const nodes = [];
  const visit = (value) => {
    if (typeof value === "string") return value;
    nodes.push(value);
    return (value.children ?? []).map(visit).join("\n");
  };
  const text = visit(tree);
  assert.equal(nodes.filter((node) => node.type === "Button").length, 1);
  assert.equal(nodes.find((node) => node.type === "Button").props.key, "codex_tab_task-old");
  // The row is named by the round that opened the thread, not by the newest one.
  assert.match(nodes.find((node) => node.type === "Button").props.label, /opening round/);
  assert.ok(text.indexOf("first round trace") < text.indexOf("second round trace"), text);
  // Each round's brief opens that round, and the round boundary is the brief
  // rather than a terminal row that says what the heading already says.
  assert.ok(text.indexOf("round one brief") < text.indexOf("first round trace"), text);
  assert.ok(text.indexOf("first round trace") < text.indexOf("round two brief"), text);
  assert.ok(text.indexOf("round two brief") < text.indexOf("second round trace"), text);
  assert.equal(text.includes("Job completed"), false, text);
  // Each round closes with its own foot, between its last row and the next brief.
  const foot = "✻ completed · 30m0s";
  assert.ok(text.indexOf("first round trace") < text.indexOf(foot), text);
  assert.ok(text.indexOf(foot) < text.indexOf("round two brief"), text);
  // Dropping the terminal row makes the last message the row nothing follows,
  // which is what the "still writing" ellipsis used to key off.
  assert.equal(text.includes("\u2026"), false, text);
});
