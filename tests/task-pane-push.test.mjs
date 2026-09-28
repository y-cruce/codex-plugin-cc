import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pushLine, registerTaskPane, shouldDropMonitorExpiry } from "../plugins/codex/hooks/task-pane/register.ts";
import { paneBody } from "../plugins/codex/hooks/task-pane/pane.ts";
import { isOver } from "../plugins/codex/hooks/live-tool-row/view.ts";
import { askPane, renderPaneReply } from "../plugins/codex/scripts/lib/pane-channel.mjs";

const view = {
  pendingQuestion: { requestId: "0", text: "是否允许修改测试文件？", openedAt: "", expiresAt: null },
  lastMessage: { kind: "assistant", text: "四条都修好了", at: "" },
};

async function paneHarness(stored = new Map()) {
  const hooks = new Map();
  const timers = new Map();
  const files = new Map();
  const now = Date.now();
  const base = "/home/test/.claude/plugins/data/codex/state/main";
  const jobPath = `${base}/jobs/job-a.json`;
  const viewPath = `${base}/thread-records/record-a/live-view.json`;
  const live = {
    schemaVersion: 1, recordId: "record-a", jobId: "job-a", label: "Alpha task",
    status: "running", startedAt: new Date(now).toISOString(), endedAt: null,
    activeRoundId: "job-a", latestRoundId: "job-a", rounds: [], tail: [],
    activeCommands: [], files: [], pendingQuestion: null, lastMessage: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, complete: false },
    history: { continuity: "complete", committedSeq: "0" },
  };
  files.set(jobPath, { id: "job-a", sessionId: "session", workspaceRoot: "/work", status: "running" });
  files.set(viewPath, live);
  const listing = [{ id: "record-a", recordId: "record-a", jobId: "job-a", label: live.label,
    status: "running", sessionIds: ["session"], viewPath, historyAvailable: false }];
  let threads = listing;
  let writes = 0;
  let viewRead;
  let mtime = now;
  const read = async (path) => {
    if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return JSON.stringify(files.get(path));
  };
  const element = (type) => (props) => ({ type, ...props });
  const engine = {
    plugin: { name: "codex" },
    session: { surfaces: async () => ["terminal"], cwd: async () => "/work", id: async () => "session" },
    env: { get: async () => "/home/test" },
    clock: { now: async () => now, every: (ms, fn) => timers.set(ms, fn) },
    store: { get: async (key) => stored.get(key), set: async (key, value) => {
      stored.set(key, value);
      if (key === "codex:tasks:session") writes++;
    } },
    fs: {
      list: async (path) => path.endsWith("plugins/data") ? [{ kind: "dir", name: "codex" }]
        : path.endsWith("/state") ? [{ kind: "dir", name: "main" }]
        : path.endsWith("/jobs") && files.has(jobPath) ? [{ name: "job-a.json" }] : [],
      stat: async (path) => { await read(path); return { mtimeMs: mtime }; },
      write: async (path, text) => { files.set(path, JSON.parse(text)); },
      read: async (path) => {
        const text = await read(path);
        if (path === viewPath && viewRead) {
          const wait = viewRead;
          viewRead = null;
          await wait();
        }
        return text;
      },
    },
    process: { run: async (args) => {
      if (args[0] === "bash") return { exitCode: 0, stdout: "/companion.mjs", stderr: "" };
      if (args[0] === "pgrep") return { exitCode: 0, stdout: "123", stderr: "" };
      if (threads instanceof Error) throw threads;
      return { exitCode: 0, stdout: JSON.stringify({ threads }), stderr: "" };
    } },
    tool: { call: async () => assert.fail("no real monitors") },
    ui: { open: async () => {}, close: async () => {}, invalidate: () => {}, log: () => {}, toast: () => {},
      scroll: async () => {}, resolve: () => Object.fromEntries(["Box", "Text", "Code", "Button"].map((key) => [key, element(key)])) },
  };
  registerTaskPane((event, options, callback) => hooks.set(`${event}:${options?.component ?? ""}`, callback ?? options), new Set(), undefined, false);
  const settle = async (previous) => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (writes > previous) return;
    }
    assert.fail("poll did not complete");
  };
  await hooks.get("session.start:")(engine, { isInteractive: true }, async () => {});
  await settle(0);
  return {
    files, jobPath, viewPath, live, stored, listing,
    holdViewRead: () => {
      let started, release;
      const reading = new Promise((resolve) => { started = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      viewRead = () => { started(); return pending; };
      return { reading, release };
    },
    viewTick: () => { mtime++; timers.get(500)(); },
    touch: () => { mtime++; },
    list: (value) => { threads = value === true ? listing : value; },
    tick: async () => { const previous = writes; timers.get(2000)(); await settle(previous); },
    command: async (args) => hooks.get("command.run:")(engine, { command: "codex:tasks", args }, async () => assert.fail("command escaped")),
    render: async () => JSON.stringify(await hooks.get("ui.render:Pane")(engine,
      { requestId: "codex_tasks", props: { bodyColumns: 100 } }, async () => {})),
  };
}

test("live rows reconcile with disk even after dropping out or exhausting the query", async () => {
  for (const query of [[], new Error("listing failed")]) {
    for (const ending of ["legacy", "completed", "failed", "cancelled", "missing", "view", "inactive"]) {
      const pane = await paneHarness();
      assert.match(await pane.render(), /running/);
      if (ending === "legacy") {
        const legacyPath = pane.viewPath.replace("/thread-records/record-a/", "/job-history/job-a/");
        pane.files.set(legacyPath, { ...pane.live, recordId: undefined, label: "Legacy task" });
        pane.list([{ ...pane.listing[0], id: "job-a", recordId: "job-a", viewPath: legacyPath }]);
        await pane.tick();
        assert.match(await pane.render(), /Legacy task/);
      }
      pane.list(ending === "legacy" && !(query instanceof Error) ? true : query);
      if (query instanceof Error) for (let i = 0; i < 5; i++) await pane.tick();
      if (ending === "inactive") {
        pane.files.set(pane.viewPath, { ...pane.live, activeRoundId: null });
        pane.viewTick();
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (ending === "missing") pane.files.delete(pane.jobPath);
      else if (ending === "view") pane.files.set(pane.viewPath, { ...pane.live, status: "completed", activeRoundId: null, endedAt: new Date().toISOString() });
      else pane.files.set(pane.jobPath, { ...pane.files.get(pane.jobPath), status: ["inactive", "legacy"].includes(ending) ? "completed" : ending, completedAt: new Date().toISOString() });
      await pane.tick();
      const rendered = await pane.render();
      assert.doesNotMatch(rendered, /running/, `${query}: ${ending}`);
      if (ending === "legacy") {
        assert.match(rendered, /completed/);
        if (query instanceof Error) assert.match(rendered, /Legacy task/);
        else {
          assert.doesNotMatch(rendered, /Legacy task/);
          assert.equal((rendered.match(/"key":"codex_tab_/g) ?? []).length, 1);
        }
      } else if (ending === "missing" || !(query instanceof Error)) assert.doesNotMatch(rendered, /Alpha task/);
      else assert.match(rendered, new RegExp(["view", "inactive"].includes(ending) ? "completed" : ending), `${query}: ${ending}`);
    }
  }
});

test("forget uses task selectors and stays hidden until refresh rebuilds from disk", async () => {
  for (const selector of ["1", "aLpHa"]) {
    const pane = await paneHarness();
    const before = JSON.stringify([...pane.files]);
    assert.match((await pane.command(selector)).text, /Alpha task/);
    assert.match((await pane.command(`forget ${selector}`)).text, /forgot/i);
    await pane.tick();
    assert.doesNotMatch(await pane.render(), /Alpha task/);
    assert.equal(JSON.stringify([...pane.files]), before);
    assert.match((await pane.command("refresh")).text, /refresh/i);
    assert.match(await pane.render(), /Alpha task/);
    assert.match((await pane.command("forget absent")).text, /No task matches/);
    assert.match((await pane.command("forget")).text, /Usage/);
    pane.list([]);
    assert.match((await pane.command("refresh")).text, /refresh/i);
    assert.doesNotMatch(await pane.render(), /Alpha task/);
  }
});

test("the pane answers shell requests to list, forget and refresh through the channel files", async () => {
  const stored = new Map();
  const pane = await paneHarness(stored);
  const dir = "/home/test/.claude/plugins/data/codex-tasks-pane";
  const ask = async (id, action, target) => {
    pane.files.set(`${dir}/session.request.json`, { id, action, target });
    pane.touch();
    await pane.tick();
    for (let i = 0; i < 100 && pane.files.get(`${dir}/session.reply.json`)?.id !== id; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return pane.files.get(`${dir}/session.reply.json`);
  };
  const listed = await ask("1", "list");
  assert.deepEqual(listed.rows.map(({ n, id, status, job }) => [n, id, status, job]), [[1, "record-a", "running", pane.jobPath]]);
  assert.match((await ask("2", "forget", "absent")).text, /no task matches/);
  const forgot = await ask("3", "forget", "job-a");
  assert.match(forgot.text, /forgot Alpha task/);
  assert.deepEqual(forgot.rows, []);
  // Hidden rows stay hidden in the instance a reload starts.
  assert.doesNotMatch(await (await paneHarness(stored)).render(), /Alpha task/);
  const refreshed = await ask("4", "refresh");
  assert.match(refreshed.text, /refreshed · 1 tasks/);
  assert.deepEqual(refreshed.forgotten, []);
});

test("askPane waits for the pane's reply and marks rows the disk has already ended", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-channel-"));
  const job = path.join(dir, "task-a.json");
  fs.writeFileSync(job, JSON.stringify({ status: "completed" }));
  const pane = setInterval(() => {
    try {
      const { id, action, target } = JSON.parse(fs.readFileSync(path.join(dir, "s.request.json"), "utf8"));
      assert.deepEqual([action, target], ["forget", "2"]);
      fs.writeFileSync(path.join(dir, "s.reply.json"), JSON.stringify({ id, text: "forgot b", forgotten: ["b"], rows: [
        { n: 1, id: "a", label: "Alpha", status: "running", job, view: null },
        { n: 2, id: "c", label: "Gamma", status: "running", job: path.join(dir, "gone.json"), view: null },
      ] }));
    } catch {}
  }, 20);
  try {
    const reply = await askPane("s", "forget", "2", { dir, pollMs: 20 });
    assert.deepEqual(reply.rows.map((row) => row.disk), ["completed", "missing"]);
    const text = renderPaneReply("s", reply);
    assert.match(text, /1 Alpha · pane running · disk completed · STALE/);
    assert.match(text, /2 Gamma · pane running · disk missing · STALE/);
    assert.match(text, /hidden by forget: b/);
    await assert.rejects(askPane("absent", "list", "", { dir, timeoutMs: 100, pollMs: 20 }), /did not answer/);
    assert.equal(fs.existsSync(path.join(dir, "absent.request.json")), false);
  } finally {
    clearInterval(pane);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh waits for polling and refresh or pruning discards an old concurrent view read", async () => {
  for (const source of ["poll", "view", "prune"]) {
    const pane = await paneHarness();
    const read = pane.holdViewRead();
    const pending = source === "poll" ? pane.tick() : pane.viewTick();
    await read.reading;
    pane.list([]);
    const refreshed = source === "prune" ? pane.tick() : pane.command("refresh");
    if (source !== "poll") await refreshed;
    read.release();
    await pending;
    await refreshed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(await pane.render(), /Alpha task/, source);
  }
});

test("terminal receipts do not seed rows or prevent disk reconciliation", async () => {
  for (const status of ["running", "queued"]) {
    const stored = new Map([["codex:tasks:session", { "job-a": { terminal: "completed" } }]]);
    const pane = await paneHarness(stored);
    // The receipt is notification bookkeeping, not a rendered row or its status.
    assert.match(await pane.render(), /running/);
    pane.list(pane.listing.map((thread) => ({ ...thread, status })));
    pane.files.set(pane.jobPath, { ...pane.files.get(pane.jobPath), status: "completed", completedAt: new Date().toISOString() });
    await pane.tick();
    assert.match(await pane.render(), /completed/);
    assert.doesNotMatch(await pane.render(), /running|queued/);
  }
});

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
  // Tab keeps its place in the pane as a count of buttons, so the task rows
  // come first in the tree: folds coming and going must not move them.
  const withFold = { ...data, tail: [...data.tail, { seq: "5", at: data.endedAt, type: "command.completed", text: "$ ls", exitCode: 0 }] };
  const keys = [];
  const collect = (value) => {
    if (typeof value === "string") return;
    if (value.type === "Button") keys.push(value.props.key);
    (value.children ?? []).forEach(collect);
  };
  collect(paneBody(ui, [withFold], 100, 20, Date.parse(data.endedAt), null, () => {}, undefined, { isOpen: () => false, toggle: () => {} }));
  assert.deepEqual(keys.map((key) => key.split("_")[1]), ["tab", "fold"]);
});
