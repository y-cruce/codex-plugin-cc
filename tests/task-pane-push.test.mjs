import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirectorChannel } from "../plugins/codex/scripts/director-channel.mjs";
import { runIngress } from "../plugins/codex/scripts/director-ingress.mjs";
import { DirectorPublisher, directorEvent, deliveryRoot, wasDelivered, eventPaths } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import { admitDirector, directorChannel, directorIngress } from "../plugins/codex/hooks/director-channel/register.ts";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { goalCommand, goalFromMessages, pushLine, registerTaskPane, shouldDropMonitorEnd, shouldDropMonitorExpiry } from "../plugins/codex/hooks/task-pane/register.ts";
import { paneBody } from "../plugins/codex/hooks/task-pane/pane.ts";
import { isOver } from "../plugins/codex/hooks/live-tool-row/view.ts";
import { askPane, renderPaneReply } from "../plugins/codex/scripts/lib/pane-channel.mjs";
import { buildSingleJobSnapshot, readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { observationThreads } from "../plugins/codex/scripts/lib/observation-paths.mjs";
import { resolveStateDir, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

// The pane runs the director ingress ahead of its own prompt.submit; this is that chain.
const through = (director) => async ($, e, next) => {
  const admitted = await admitDirector($, director, e);
  if ("drop" in admitted) return admitted;
  const result = await next(admitted.event);
  if (!result?.drop && admitted.accept) await directorIngress($, "accept", admitted.accept);
  return result;
};

// The hooks run the delivery record's script through $.process.run; here it runs in-process.
const ingressRun = async (args) => String(args[1] ?? "").endsWith("/director-ingress.mjs")
  ? { exitCode: 0, stdout: JSON.stringify(await runIngress(args[2], JSON.parse(args[3]))), stderr: "" } : null;

const view = {
  pendingQuestion: { requestId: "0", text: "是否允许修改测试文件？", openedAt: "", expiresAt: null },
  lastMessage: { kind: "assistant", text: "四条都修好了", at: "" },
};

const clockSleep = (_ms, { signal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

async function paneHarness(stored = new Map(), openResult = { isPlaced: false, reason: "narrow terminal" }, sessionId = "session", options = {}) {
  const hooks = new Map();
  const timers = new Map();
  const opened = [];
  const files = new Map();
  const dirs = new Set(["/work", ...(options.dirs ?? [])]);
  const logs = [];
  const debugLogs = [];
  const toasts = [];
  const notices = [];
  let now = options.now ?? Date.now();
  let startedAt = options.startedAt ?? now;
  const workspaceRoot = options.workspaceRoot ?? "/work";
  dirs.add(workspaceRoot);
  const statPaths = [];
  const observed = [];
  const acks = [];
  const base = options.fallback ? "/tmp/codex-companion/main" : "/home/test/.claude/plugins/data/codex/state/main";
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
  files.set(jobPath, { id: "job-a", sessionId, workspaceRoot, status: "running" });
  files.set(viewPath, live);
  for (const [file, value] of options.preset ?? []) files.set(file, value);
  const listing = [{ id: "record-a", recordId: "record-a", jobId: "job-a", label: live.label,
    status: "running", live: true, sessionIds: [sessionId], viewPath, historyAvailable: false, directorPush: true }];
  let threads = listing;
  let writes = 0;
  let failWrites = options.failWrites ?? 0;
  let viewRead;
  let viewReadPath = viewPath;
  let threadRead = options.threadRead;
  let mtime = options.mtime ?? now;
  const read = async (path) => {
    if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return JSON.stringify(files.get(path));
  };
  const element = (type) => (props) => ({ type, ...props });
  const engine = {
    plugin: { name: "codex", root: "/plugin" },
    session: { surfaces: async () => ["terminal"], cwd: async () => "/work", id: async () => sessionId, usage: async () => ({ startedAt }),
      messages: async () => options.messages ?? [] },
    env: { get: async (name) => name === "TMPDIR" ? "/tmp" : "/home/test" },
    clock: { now: async () => { if (options.clockNow) await options.clockNow(); return now; }, sleep: clockSleep, every: (ms, fn) => timers.set(ms, fn), after: (_ms, fn) => setImmediate(fn) },
    store: { get: async (key) => { if (options.storeRead) await options.storeRead(key); return stored.get(key); }, set: async (key, value) => {
      if (options.storeWrite) await options.storeWrite(key, value);
      if (key === `codex:tasks:${sessionId}` && failWrites-- > 0) throw new Error("Lock file is already being held");
      stored.set(key, value);
      if (key === `codex:tasks:${sessionId}`) writes++;
    } },
    fs: {
      exists: async (path) => files.has(path) || path === "/plugin/scripts/codex-companion.mjs" || path === "/home/test/.claude/skills/code-director/scripts/dispatch.sh",
      list: async (path) => options.fsList ? options.fsList(path, files) : path.endsWith("plugins/data") ? options.fallback ? [] : [{ kind: "dir", name: "codex" }]
        : path.endsWith("/state") || options.fallback && path === "/tmp/codex-companion" ? [{ kind: "dir", name: "main" }]
        : path.endsWith("/jobs") && files.has(jobPath) ? [{ name: "job-a.json", kind: "file", mtimeMs: mtime, isLink: false, ...options.jobEntry }] : [],
      stat: async (path) => {
        statPaths.push(path);
        if (dirs.has(path)) return { kind: "dir", mtimeMs: mtime };
        await read(path);
        return { mtimeMs: mtime };
      },
      write: async (path, text) => { if (options.fileWrite) await options.fileWrite(path); files.set(path, JSON.parse(text)); },
      read: async (path) => {
        const text = await read(path);
        if (path === viewReadPath && viewRead) {
          const wait = viewRead;
          viewRead = null;
          await wait();
        }
        return text;
      },
    },
    process: { run: async (args, init) => {
      const routed = await ingressRun(args);
      if (routed) return routed;
      if (args[0] === "sh" && options.ppid) return { exitCode: 0, stdout: `${options.ppid}\n`, stderr: "" };
      // Node names the command, not the directory, when a spawn's cwd is gone.
      if (!dirs.has(init.cwd)) throw new Error(`spawn ${args[0]} ENOENT`);
      if (args[0] === "bash") return { exitCode: 0, stdout: "/companion.mjs", stderr: "" };
      if (args[0] === "pgrep" && options.pgrep) return options.pgrep(args)
      if (args[0] === "pgrep") return { exitCode: options.watch === false ? 1 : 0, stdout: "123", stderr: "" };
      if (args.includes("ack") || args.includes("reported")) { acks.push(args); return { exitCode: 0, stdout: "{}", stderr: "" }; }
      observed.push(init.cwd);
      if (args.includes('replay')) return { exitCode: 0, stdout: await options.replay(args), stderr: '' };
      if (threadRead) {
        const wait = threadRead;
        threadRead = null;
        await wait();
      }
      if (threads instanceof Error) throw threads;
      return { exitCode: 0, stdout: JSON.stringify({ threads: init.cwd === workspaceRoot ? threads : [] }), stderr: "" };
    } },
    tool: { call: async (request) => options.toolCall ? options.toolCall(request) : assert.fail("no real monitors") },
    ui: { panes: async () => options.panes ?? [], open: async (request) => { if (options.open) await options.open(); opened.push(request); return request.focus ? options.focusResult ?? { isPlaced: true } : openResult; }, close: async () => {}, invalidate: () => {}, log: (text, options) => (options?.to === "debug" ? debugLogs : logs).push(text), toast: (text) => toasts.push(text),
      notify: async (text) => { notices.push(text); if (options.notify) return options.notify(); return { isSent: true, channel: "terminal_bell" }; },
      scroll: async () => {}, resolve: () => Object.fromEntries(["Box", "Text", "Code", "Markdown", "Button"].map((key) => [key, element(key)])) },
  };
  registerTaskPane((event, options, callback) => hooks.set(`${event}:${options?.component ?? ""}`, callback ?? options), new Set(), undefined, options.push ?? false);
  // A round writes the ledger only when it changed, so one that changed nothing
  // is done once its queued work has drained.
  const settle = async (previous) => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (writes > previous) return;
    }
  };
  await hooks.get("session.start:")(engine, { isInteractive: true }, async () => {});
  await settle(0);
  return {
    files, jobPath, viewPath, live, stored, listing, opened, logs, debugLogs, toasts, notices, statPaths, observed, acks, writes: () => writes,
    autocomplete: async (text) => { const token = /\S*$/.exec(text)[0]; return hooks.get("prompt.autocomplete:")(engine,
      { text, token, cursor: text.length, start: text.length - token.length }, async () => ({ suggestions: [] })); },
    removeDir: (path) => { dirs.delete(path); },
    holdViewRead: (path = viewPath) => {
      viewReadPath = path;
      let started, release;
      const reading = new Promise((resolve) => { started = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      viewRead = () => { started(); return pending; };
      return { reading, release };
    },
    holdThreadsRead: () => {
      let started, release;
      const reading = new Promise((resolve) => { started = resolve; });
      const pending = new Promise((resolve) => { release = resolve; });
      threadRead = () => { started(); return pending; };
      return { reading, release };
    },
    viewTick: (unchanged = false) => { if (!unchanged) mtime++; timers.get(500)(); },
    touch: () => { mtime++; },
    list: (value) => { threads = value === true ? listing : value; },
    tick: async () => { const previous = writes; timers.get(2000)(); await settle(previous); },
    advance: (ms) => { now += ms; },
    dispatched: async (command) => {
      await hooks.get("tool.call:")(engine, { command }, async () => ({ stdout: "STATUS: started JOB: new-job NAME: New job" }));
      await settle(writes);
    },
    band: async () => hooks.get("ui.render:AbovePrompt")(engine, { props: {} }, async () => {}),
    close: async (kind = "person") => hooks.get("ui.close:")(engine, { id: "codex_tasks", origin: { kind } }, async () => {}),
    end: async (reason = "resume") => hooks.get("session.end:")(engine, { reason }, async () => {}),
    prompt: async (event, next) => hooks.get("prompt.submit:")(engine, event, next),
    session: (value) => {
      sessionId = value;
      startedAt = now;
      files.set(jobPath, { ...files.get(jobPath), sessionId });
      listing[0].sessionIds = [sessionId];
    },
    goal: async (args, text) => { await hooks.get("command.run:")(engine, { command: "goal", args }, async () => ({ text })); await settle(writes); },
    turn: async (reason = "answer") => hooks.get("turn.complete:")(engine, { reason }, async () => ({ text: "" })),
    command: async (args) => hooks.get("command.run:")(engine, { command: "codex:tasks", args }, async () => assert.fail("command escaped")),
    render: async () => JSON.stringify(await hooks.get("ui.render:Pane")(engine,
      { requestId: "codex_tasks", props: { bodyColumns: 100 } }, async () => {})),
  };
}

test("subagent turns leave director bootstrap and completion polling alone", async () => {
  const hooks = new Map();
  registerTaskPane((event, matcher, callback) => hooks.set(event, callback ?? matcher));
  const scheduled = [];
  const engine = { clock: { after: (_ms, callback) => scheduled.push(callback) } };
  const next = async () => {};
  await hooks.get("turn.start")(engine, { agentId: "child" }, next);
  await hooks.get("turn.complete")(engine, { agentId: "child" }, next);
  assert.equal(scheduled.length, 0);
  await hooks.get("turn.start")(engine, {}, next);
  await hooks.get("turn.complete")(engine, {}, next);
  assert.equal(scheduled.length, 2);
});

test("task completion notifies once even when the notification channel fails", async () => {
  const pane = await paneHarness(new Map(), undefined, "session", { notify: async () => { throw new Error("channel failed"); } });
  pane.listing[0].status = "completed";
  pane.live.status = "completed";
  pane.live.activeRoundId = null;
  pane.live.endedAt = new Date().toISOString();
  pane.touch();
  await pane.tick();
  await pane.tick();
  assert.equal(pane.notices.length, 1);
  assert.match(pane.notices[0], /job.completed/);
  assert.equal(pane.stored.get("codex:tasks:session")["job-a"].terminal, "completed");
});

test("task selectors complete record IDs while messages complete only running job IDs", async () => {
  const pane = await paneHarness();
  const observed = pane.observed.length;
  for (const [text, id] of [["/codex:tasks Alp", "record-a"], ["/codex:tasks forget record", "record-a"], ["/codex:message Alp", "job-a"]]) {
    const result = await pane.autocomplete(text);
    assert.equal(result.suggestions[0].text, id);
    assert.equal(result.suggestions[0].label, "Alpha task");
  }
  assert.equal(pane.observed.length, observed, "completion reads the cached rows without a process call");
  assert.deepEqual((await pane.autocomplete("/codex:message job-a revise Alp")).suggestions, []);
  pane.live.pendingQuestion = { requestId: "request", text: "Choose", openedAt: "", expiresAt: null };
  pane.touch();
  await pane.tick();
  assert.deepEqual((await pane.autocomplete("/codex:message Alp")).suggestions, []);
  pane.live.status = "waiting-for-answer";
  pane.touch();
  await pane.tick();
  assert.deepEqual((await pane.autocomplete("/codex:message Alp")).suggestions, []);
});

test("an unplaced tasks command keeps its open control available", async () => {
  const pane = await paneHarness(new Map(), undefined, "session", { focusResult: { isPlaced: false, reason: "no-surface" } });
  assert.match((await pane.command("")).text, /no-surface/);
  assert.equal((await pane.band()).children[0].key, "codex_tasks_open");
});

test("pane rendering uses the cached clock without I/O", async () => {
  let reading = false;
  const pane = await paneHarness(new Map(), undefined, "session", { clockNow: () => assert.equal(reading, false) });
  reading = true;
  assert.match(await pane.render(), /Alpha task/);
});

test("store lock refusals do not interrupt pane controls and pending choices are retried", async () => {
  let locked = false;
  const pane = await paneHarness(new Map(), undefined, "session", { storeWrite: () => {
    if (locked) throw new Error("Lock file is already being held");
  } });
  locked = true;
  assert.match((await pane.command("")).text, /Alpha task/);
  assert.match((await pane.command("")).text, /closed/);
  assert.match((await pane.command("forget 1")).text, /forgot/);
  await pane.tick();
  assert.doesNotMatch(await pane.render(), /Alpha task/);
  await pane.close();
  locked = false;
  await pane.tick();
  assert.equal(pane.stored.get("codex:tasks:session:dismissed"), true);
  assert.deepEqual(pane.stored.get("codex:tasks:session:forgotten"), ["record-a"]);
  assert.deepEqual(pane.logs, []);
});

test("unreadable pane store falls back to live state without a startup error", async () => {
  const pane = await paneHarness(new Map(), undefined, "session", { storeRead: () => { throw new Error("store is unreadable"); } });
  assert.match((await pane.command("")).text, /Alpha task/);
  assert.deepEqual(pane.logs, []);
  assert.match(pane.debugLogs.join("\n"), /unreadable/);
});

test("pane discovers cross-repository jobs in the temp store without a command env export", async () => {
  const pane = await paneHarness(new Map(), undefined, "session", { fallback: true, workspaceRoot: "/work/other" });
  assert.match(await pane.render(), /Alpha task/);
  assert.ok(pane.observed.includes("/work/other"));
});

test("pane listings recover after five companion failures without a person-visible notice", async () => {
  for (const source of ["threads", "replay"]) {
    let failed = true;
    let replays = 0;
    const pane = await paneHarness(new Map(), undefined, "session", { replay: () => {
      replays++;
      if (failed) throw new Error("companion failed");
      return '{"type":"end","nextCursor":"0"}';
    } });
    if (source === "threads") pane.list(new Error("companion failed"));
    else pane.listing[0].historyAvailable = true;
    for (let i = 0; i < 5; i++) await pane.tick();
    const calls = source === "threads" ? pane.observed.length : replays;
    failed = false;
    pane.list(true);
    for (let i = 0; i < 16; i++) await pane.tick();
    assert.ok((source === "threads" ? pane.observed.length : replays) > calls, `${source} must be retried`);
    assert.deepEqual(pane.logs, []);
    assert.match(pane.debugLogs.join("\n"), /companion failed/);
  }
});

test("pane channel retries a request after its reply write fails", async () => {
  let fail = true;
  const pane = await paneHarness(new Map(), undefined, "session", { fileWrite: () => {
    if (fail) throw new Error("reply temporarily unwritable");
  } });
  const base = "/home/test/.claude/plugins/data/codex-tasks-pane/session";
  pane.files.set(`${base}.request.json`, { id: "retry", action: "list" });
  await pane.tick();
  fail = false;
  await pane.tick();
  assert.equal(pane.files.get(`${base}.reply.json`)?.id, "retry");
  assert.deepEqual(pane.logs, []);
});

test("a failed automatic pane open is retried on the next poll", async () => {
  let fail = true;
  const pane = await paneHarness(new Map(), undefined, "session", { open: () => {
    if (fail) throw new Error("pane temporarily unavailable");
  } });
  fail = false;
  await pane.tick();
  assert.equal(pane.opened.length, 1);
  assert.deepEqual(pane.logs, []);
});

test("session resume returns while a monitor stop never returns", async (t) => {
  const stop = Promise.withResolvers();
  t.after(stop.resolve);
  for (const reason of ["resume", "clear"]) {
    let monitors = 0;
    const stopped = [];
    const pane = await paneHarness(new Map(), undefined, "session", { watch: false, toolCall: request => {
      if (request.tool === "Monitor") return { result: { taskId: `monitor-${++monitors}` } };
      stopped.push(request.task_id);
      return stop.promise;
    } });
    let timer;
    await Promise.race([pane.end(reason), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("session end waited for TaskStop")), 1000);
    })]).finally(() => clearTimeout(timer));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(pane.stored.get("codex:tasks:session:retiredMonitors"), ["monitor-1"]);
    pane.session("next");
    await pane.command("");
    await pane.tick();
    assert.deepEqual(stopped, ["monitor-1"], reason);
    assert.equal(monitors, 2, "the next session's monitor runs while the old stop is pending");
  }
});

test("an expired monitor stays retired when its last task finished in the gap", async () => {
  const calls = [];
  const pane = await paneHarness(new Map(), undefined, "session", { watch: false, toolCall: request => {
    calls.push(request);
    return { result: { taskId: `monitor-${calls.length}` } };
  } });
  assert.equal(calls.length, 1);
  pane.advance(1800001);
  pane.list([{ ...pane.listing[0], status: "completed", live: false }]);
  pane.files.set(pane.jobPath, { ...pane.files.get(pane.jobPath), status: "completed" });
  pane.files.set(pane.viewPath, { ...pane.live, status: "completed", activeRoundId: null, endedAt: new Date().toISOString() });
  await pane.tick();
  assert.equal(calls.length, 1);
  await pane.tick();
  assert.equal(calls.length, 1);
  assert.match(pane.toasts.join("\n"), /job.completed/);
});

test("an old replay cannot write its ledger into a new session", async () => {
  const entered = Promise.withResolvers();
  const replay = Promise.withResolvers();
  const pane = await paneHarness(new Map(), undefined, "session", { replay: () => {
    entered.resolve();
    return replay.promise;
  } });
  pane.listing[0].historyAvailable = true;
  const pending = pane.tick();
  await entered.promise;
  pane.session("next");
  pane.files.delete(pane.jobPath);
  pane.list([]);
  assert.match((await pane.command("")).text, /nothing dispatched/);
  replay.resolve('{"type":"end","nextCursor":"old-session"}');
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pane.stored.get("codex:tasks:next")?.["job-a"], undefined);
  assert.doesNotMatch(await pane.render(), /Alpha task/);
});

test("tasks opens and answers while the background companion never returns, then fills in", async (t) => {
  const blocked = Promise.withResolvers();
  t.after(() => blocked.resolve());
  const pane = await paneHarness(new Map(), { isPlaced: true }, "session", { threadRead: () => blocked.promise });
  const started = performance.now();
  let timeout;
  const reply = await Promise.race([pane.command(""), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("tasks waited for the background poll")), 1000);
  })]).finally(() => clearTimeout(timeout));
  assert.match(reply.text, /job-a/, "the job file is visible before the companion returns");
  assert.ok(performance.now() - started < 1000);
  assert.equal(pane.opened.length, 1);
  assert.match((await pane.command("")).text, /closed/);
  assert.match((await pane.command("")).text, /job-a/);
  blocked.resolve();
  await pane.tick();
  assert.match(await pane.render(), /Alpha task/);
});

test("tasks refresh opens and answers before a pending poll, then rebuilds the pane", async (t) => {
  const pane = await paneHarness();
  const blocked = pane.holdThreadsRead();
  t.after(blocked.release);
  const pending = pane.tick();
  await blocked.reading;
  pane.list([]);
  let timeout;
  const reply = await Promise.race([pane.command("refresh"), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("refresh waited for the background poll")), 1000);
  })]).finally(() => clearTimeout(timeout));
  assert.equal(reply.text, "Codex tasks · refreshing");
  assert.equal(pane.opened.at(-1).focus, true);
  blocked.release();
  await pending;
  await pane.tick();
  assert.doesNotMatch(await pane.render(), /Alpha task/);
});

test("refresh starts a new rebuild immediately and retains rows until it is ready or fails", async (t) => {
  isolateTestEnvironment(t);
  for (const outcome of ["ready", "failed"]) {
    const pane = await paneHarness();
    const old = pane.holdThreadsRead();
    t.after(old.release);
    const oldPoll = pane.tick();
    await old.reading;
    const fresh = pane.holdThreadsRead();
    t.after(fresh.release);
    const betaJob = pane.jobPath.replace("job-a.json", "job-b.json");
    const betaView = pane.viewPath.replace("record-a/", "record-b/");
    pane.files.set(betaJob, { id: "job-b", status: "running" });
    pane.files.set(betaView, { ...pane.live, jobId: "job-b", recordId: "record-b", label: "Beta task", activeRoundId: "job-b", latestRoundId: "job-b" });
    const listing = [{ ...pane.listing[0], id: "record-b", recordId: "record-b", jobId: "job-b", label: "Beta task", viewPath: betaView }];
    const result = outcome === "ready" ? listing : new Error("rebuild failed");
    pane.list(result);
    assert.equal((await pane.command("refresh")).text, "Codex tasks · refreshing");
    let timeout;
    const started = await Promise.race([fresh.reading.then(() => true), new Promise(resolve => {
      timeout = setTimeout(() => resolve(false), 1000);
    })]).finally(() => clearTimeout(timeout));
    assert.equal(started, true, "refresh does not join the held old poll");
    assert.match(await pane.render(), /Alpha task/, "the rebuilding pane keeps its previous rows");
    pane.list([{ ...pane.listing[0], status: "queued" }]);
    old.release();
    await oldPoll;
    await new Promise(resolve => setImmediate(resolve));
    pane.list(result);
    const requests = pane.observed.length;
    await pane.tick();
    assert.equal(pane.observed.length, requests, "the old poll cannot release the fresh poll's slot");
    assert.match(await pane.render(), /Alpha task/);
    const replacement = outcome === "ready" ? pane.holdViewRead(betaView) : null;
    if (replacement) t.after(replacement.release);
    fresh.release();
    if (replacement) {
      const reading = await Promise.race([replacement.reading.then(() => true), new Promise(resolve => {
        timeout = setTimeout(() => resolve(false), 1000);
      })]).finally(() => clearTimeout(timeout));
      assert.equal(reading, true);
      assert.match(await pane.render(), /Alpha task/, "old rows stay on screen while replacement files are being read");
      assert.doesNotMatch(await pane.render(), /Beta task/, "partial rebuilt rows stay off-screen");
      replacement.release();
    }
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    const rendered = await pane.render();
    assert.match(rendered, outcome === "ready" ? /Beta task/ : /Alpha task/);
    if (outcome === "ready") assert.doesNotMatch(rendered, /Alpha task/, "rows are replaced only after the rebuilt view is loaded");
  }
});

test("tasks answers during a stalled bootstrap and retries without a startup failure notice", async () => {
  const hooks = new Map();
  const timers = [];
  const stored = new Map();
  const entered = Promise.withResolvers();
  const stalled = Promise.withResolvers();
  const sleeps = [];
  const opened = [];
  const retries = [];
  let firstRead = true;
  const engine = {
    plugin: { name: "codex", root: "/plugin" },
    session: { surfaces: async () => ["terminal"], cwd: async () => "/work", id: async () => "session", usage: async () => ({ startedAt: 0 }) },
    env: { get: async () => "/home/test" },
    clock: { now: async () => 0, every: (ms, fn) => timers.push([ms, fn]), after: (ms, fn) => ms ? retries.push(fn) : setImmediate(fn), sleep: (ms, { signal }) => {
      const wait = Promise.withResolvers();
      sleeps.push({ ms, signal, ...wait });
      signal.addEventListener("abort", () => wait.reject(signal.reason), { once: true });
      return wait.promise;
    } },
    store: { get: async (key) => {
      if (firstRead) {
        firstRead = false;
        entered.resolve();
        await stalled.promise;
      }
      return stored.get(key);
    }, set: async (key, value) => stored.set(key, value) },
    fs: {
      exists: async (path) => path === "/plugin/scripts/codex-companion.mjs"
        || path === "/home/test/.claude/skills/codex-director/scripts/codex-worker.sh",
      list: async () => [], stat: async () => ({}),
    },
    process: { run: async (args) => {
      assert.equal(args[0], "node", "bootstrap must not spawn companion discovery");
      assert.equal(args[1], "/plugin/scripts/codex-companion.mjs");
      return { exitCode: 0, stdout: '{"threads":[]}', stderr: "" };
    } },
    ui: { panes: async () => [], open: async (request) => { opened.push(request); return { isPlaced: true }; }, invalidate: () => {}, log: () => {} },
  };
  registerTaskPane((event, options, callback) => hooks.set(event, callback ?? options));
  const command = (args = "") => hooks.get("command.run")(engine, { command: "codex:tasks", args },
    async () => assert.fail("command escaped to Markdown"));
  const pending = command();
  let deadline;
  assert.equal((await Promise.race([pending, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("command joined bootstrap")), 1000);
  })]).finally(() => clearTimeout(deadline))).text, "Codex tasks · starting");
  await entered.promise;
  assert.equal(sleeps[0].ms, 5000);
  sleeps[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stored.size, 0);
  assert.equal(timers.length, 0);

  assert.equal(retries.length, 1);
  retries[0]();
  for (let i = 0; i < 20 && !timers.length; i++) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await command("refresh")).text, /refreshing/);
  assert.equal(stored.get("codex:tasks:session:dismissed"), false);
  assert.equal(timers.length, 3);
  assert.ok(sleeps.every((wait) => wait.signal.aborted), "each host clock wait is cancelled");
  stalled.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 3, "the late first attempt installs no timers");
  assert.equal(opened.length, 2);
  assert.ok([...stored.keys()].every((key) => key.startsWith("codex:tasks:session")));
});

test("the tasks button follows placement and only a person's close stops automatic opens", async (t) => {
  for (const [name, result, close] of [
    ["unplaced", { isPlaced: false, reason: "unasked below 144 columns" }, "person"],
    ["placed", { isPlaced: true }, "person"],
    ["plugin close", { isPlaced: false, reason: "narrow terminal" }, "plugin"],
    ["engine unload", { isPlaced: false, reason: "narrow terminal" }, "unload"],
    ["command close", { isPlaced: false, reason: "narrow terminal" }, "command"],
  ]) {
    await t.test(name, async () => {
      const pane = await paneHarness(new Map(), result);
      const button = result?.isPlaced ? undefined : "codex_tasks_open";
      assert.equal((await pane.band())?.children[0].key, button);
      await pane.tick();
      await pane.tick();
      assert.equal(pane.opened.length, 1, "poll opens once while waiting for placement");
      assert.equal((await pane.band())?.children[0].key, button);
      await pane.render();
      assert.equal(await pane.band(), undefined, "Pane render proves the pane is drawn");
      if (close === "command") assert.match((await pane.command("")).text, /closed/);
      else await pane.close(close);
      assert.equal((await pane.band()).children[0].key, "codex_tasks_open");
      const blocked = close === "person" || close === "command";
      await pane.tick();
      await pane.tick();
      assert.equal(pane.opened.length, blocked ? 1 : 2, "only a person's close stops poll opens");
      if (blocked) assert.equal((await pane.band()).children[0].key, "codex_tasks_open");

      const reloaded = await paneHarness(pane.stored, result);
      const automatic = blocked ? 0 : 1;
      assert.equal(reloaded.opened.length, automatic, "the person's choice survives reload");
      assert.equal((await reloaded.band())?.children[0].key, blocked ? "codex_tasks_open" : button);
      await reloaded.tick();
      assert.equal(reloaded.opened.length, automatic);
      reloaded.session("new-session");
      await reloaded.tick();
      assert.equal(reloaded.opened.length, automatic + 1, "a new session allows automatic opens");
    });
  }
});

test("reload restores pane placement before its first render", async (t) => {
  for (const [isShown, isPlaced] of [[true, true], [true, false], [false, true]]) {
    await t.test(`shown ${isShown}, placed ${isPlaced}`, async () => {
      const pane = await paneHarness(new Map(), undefined, "session", {
        panes: [{ id: "codex_tasks", title: "Codex tasks", isShown, isPlaced, isFocused: false }],
      });
      assert.equal(pane.opened.length, 0, "poll does not reopen an existing pane");
      const button = (await pane.band())?.children[0];
      assert.equal(button?.key, isShown && isPlaced ? undefined : "codex_tasks_open");
      if (isShown && isPlaced) assert.match((await pane.command("")).text, /closed/);
      else {
        await button.onPress();
        assert.equal(pane.opened.at(-1).focus, true);
        assert.equal(await pane.band(), undefined);
      }
    });
  }
});

test("reload and resumed sessions discover jobs from the session's first start", async (t) => {
  const now = Date.now();
  const startedAt = now - 3_600_000;
  for (const [name, jobEntry] of [["file", undefined], ["link", { kind: "other", isLink: true, mtimeMs: 0 }], ["directory", { kind: "dir", mtimeMs: 0 }]]) {
    await t.test(name, async () => {
      const options = { now, startedAt, mtime: now - 1_800_000, workspaceRoot: "/work/earlier", jobEntry };
      const stored = new Map([["codex:tasks:session:since", now - 60_000]]);
      const pane = await paneHarness(stored, undefined, "session", options);
      assert.ok(pane.observed.includes(options.workspaceRoot), "resuming finds an earlier job in another repository");
      assert.match(await pane.render(), /Alpha task/);
      assert.equal(pane.statPaths.includes(pane.jobPath), Boolean(jobEntry), "only entries without a file mtime need stat");
      const reloaded = await paneHarness(stored, undefined, "session", { ...options, now: now + 1_800_000 });
      assert.ok(reloaded.observed.includes(options.workspaceRoot), "reload does not advance the scan floor");
      assert.match(await reloaded.render(), /Alpha task/);
      const beforeSession = await paneHarness(new Map(), undefined, "session", { ...options, mtime: startedAt - 1 });
      assert.equal(beforeSession.observed.includes(options.workspaceRoot), false, "files from before the session are skipped");
    });
  }
});

test("asking to open a waiting or closed pane hides the button and clears the saved close", async (t) => {
  for (const source of ["button", "command"]) {
    for (const closed of [false, true]) {
      await t.test(`${source}: ${closed ? "closed" : "waiting"}`, async () => {
        const result = { isPlaced: false, reason: "narrow terminal" };
        let pane = await paneHarness(new Map(), result);
        if (closed) {
          await pane.render();
          await pane.close();
          pane = await paneHarness(pane.stored, result);
          assert.equal(pane.opened.length, 0);
        }
        const previous = pane.opened.length;
        if (source === "button") await (await pane.band()).children[0].onPress();
        else assert.match((await pane.command("")).text, /Alpha task/);
        assert.equal(pane.opened.length, previous + 1);
        assert.equal(pane.opened.at(-1).focus, true);
        assert.equal(await pane.band(), undefined);
        const reloaded = await paneHarness(pane.stored, result);
        assert.equal(reloaded.opened.length, 1, "an explicit open restores automatic opens across reload");
      });
    }
  }
});

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

test("an older queued listing cannot roll an active round back", async (t) => {
  isolateTestEnvironment(t);
  const pane = await paneHarness();
  pane.list([{ ...pane.listing[0], status: "queued" }]);
  await pane.tick();
  assert.match(await pane.render(), /running/);
  assert.doesNotMatch(await pane.render(), /queued/);
});

test("the independent view timer reconciles a job while a poll waits and mtime stays unchanged", async (t) => {
  isolateTestEnvironment(t);
  const pane = await paneHarness();
  const held = pane.holdThreadsRead();
  const polling = pane.tick();
  await held.reading;
  pane.files.set(pane.jobPath, { ...pane.files.get(pane.jobPath), status: "completed", completedAt: new Date().toISOString() });
  pane.viewTick(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(await pane.render(), /completed/);
  assert.doesNotMatch(await pane.render(), /running/);
  held.release();
  await polling;
});

test("discovery drops seventy old roots and finds a piped dispatch while the current poll waits", async (t) => {
  isolateTestEnvironment(t);
  const now = Date.now();
  const base = "/home/test/.claude/plugins/data/codex/state";
  const old = Array.from({ length: 70 }, (_, i) => `/work/old-${i}`);
  const pane = await paneHarness(new Map(), undefined, "session", {
    now, dirs: [...old, "/work/new"],
    fsList: (directory, files) => {
      if (directory.endsWith("plugins/data")) return [{ kind: "dir", name: "codex" }];
      if (directory === `${base}`) return ["main", "new", ...old.map((_, i) => `old-${i}`)].map(name => ({ kind: "dir", name }));
      if (!directory.endsWith("/jobs")) return [];
      if (directory.includes("/old-")) {
        const id = directory.split("/").at(-2);
        files.set(`${directory}/${id}.json`, { id, sessionId: "session", workspaceRoot: `/work/${id}`, status: "completed", completedAt: new Date(now - 3600000).toISOString() });
      }
      return [...files.keys()].filter(file => file.startsWith(`${directory}/`)).map(file => ({ kind: "file", name: file.split("/").at(-1), mtimeMs: now, isLink: false }));
    },
  });
  assert.equal(pane.observed.some(root => old.includes(root)), false, "old roots never spawn a listing");
  const held = pane.holdThreadsRead();
  const polling = pane.tick();
  await held.reading;
  pane.files.set(`${base}/new/jobs/new-job.json`, { id: "new-job", label: "New job", sessionId: "session", workspaceRoot: "/work/new", status: "queued", createdAt: new Date(now).toISOString() });
  await pane.tick();
  assert.match(await pane.render(), /New job/, "the independent discovery timer does not join the pending poll");
  await pane.dispatched("bash dispatch.sh dispatch < brief | tr '\\n' ' '; cd /work; git status");
  assert.match(await pane.render(), /New job/);
  assert.match(await pane.render(), /queued/);
  pane.files.set(`${base}/new/job-history/new-job/live-view.json`, { ...pane.live, jobId: "new-job", recordId: undefined, label: "New job", activeRoundId: undefined, latestRoundId: undefined, history: { continuity: "legacy", committedSeq: "0" } });
  await pane.dispatched("bash dispatch.sh dispatch < brief");
  pane.files.set(`${base}/new/job-index/new-job.json`, { schemaVersion: 1, jobId: "new-job", roundId: "new-job", recordId: "record-new" });
  pane.files.set(`${base}/new/thread-records/record-new/live-view.json`, { ...pane.live, jobId: "new-job", recordId: "record-new", label: "New job", activeRoundId: "new-job", latestRoundId: "new-job" });
  pane.files.set(`${base}/new/jobs/new-job.json`, { ...pane.files.get(`${base}/new/jobs/new-job.json`), status: "running" });
  await pane.dispatched("bash dispatch.sh dispatch < brief | tr '\\n' ' '");
  const rendered = await pane.render();
  assert.match(rendered, /codex_tab_record-new/);
  assert.doesNotMatch(rendered, /codex_tab_new-job/, "binding replaces the provisional row even at the same job mtime");
  held.release();
  await polling;
});

test("the ledger is written only when it changed, and a failed write is retried without a log line", async () => {
  const pane = await paneHarness(new Map(), undefined, "session", { failWrites: 1 });
  assert.equal(pane.stored.has("codex:tasks:session"), false);
  assert.deepEqual(pane.logs, []);
  assert.match(pane.debugLogs.join("\n"), /Lock file is already being held/);
  await pane.tick();
  assert.deepEqual(pane.stored.get("codex:tasks:session"), { "job-a": {} });
  await pane.tick();
  assert.equal(pane.writes(), 1);
});

test("a repository deleted after its jobs ran stops being polled without a log line", async () => {
  const pane = await paneHarness();
  pane.removeDir("/work");
  for (let i = 0; i < 5; i++) await pane.tick();
  assert.deepEqual(pane.logs, []);
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
    await pane.tick();
    await pane.tick();
    assert.match(await pane.render(), /Alpha task/);
    assert.match((await pane.command("forget absent")).text, /No task matches/);
    assert.match((await pane.command("forget")).text, /Usage/);
    pane.list([]);
    assert.match((await pane.command("refresh")).text, /refresh/i);
    await pane.tick();
    await pane.tick();
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

test("refresh or pruning discards an old concurrent view read", async () => {
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
    await pane.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(await pane.render(), /Alpha task/, source);
  }
});

test("orphan status and fallback pane rows follow the job instead of freezing the view", async (t) => {
  isolateTestEnvironment(t);
  for (const [status, dead] of [["running", true], ["queued", true], ["running", false], ["completed", false]]) {
    for (const source of ["status", "threads"]) {
      const cwd = makeTempDir();
      const job = { id: "job-a", workspaceRoot: cwd, status, pid: dead ? 2147483647 : process.pid };
      writeJobFile(cwd, job.id, job);
      const directory = path.join(resolveStateDir(cwd), "job-history", job.id);
      fs.mkdirSync(directory, { recursive: true });
      const legacy = { schemaVersion: 1, jobId: job.id, status: "queued", history: { continuity: "legacy" } };
      fs.writeFileSync(path.join(directory, "live-view.json"), JSON.stringify(legacy));
      const expected = dead ? "failed" : status;
      if (source === "status") {
        const reported = buildSingleJobSnapshot(cwd, job.id).job;
        assert.equal(reported.status, expected);
        if (dead) {
          assert.equal(reported.errorMessage, "owner process exited");
          assert.equal(readStoredJob(cwd, job.id).pid, null);
        }
      }
      const [{ thread }] = await observationThreads(resolveStateDir(cwd));
      assert.equal(thread.status, expected, `${source}/${status}/${dead}`);
      const pane = await paneHarness();
      pane.files.set(pane.viewPath, { ...pane.live, status: "queued", history: { continuity: "legacy" } });
      pane.files.set(pane.jobPath, { ...job, ...(source === "status" ? readStoredJob(cwd, job.id) : {}) });
      pane.list(pane.listing.map((entry) => ({ ...entry, status: thread.status })));
      await pane.tick();
      assert.match(await pane.render(), new RegExp(expected), `${source}/${status}/${dead}`);
      if (dead || status === "completed") assert.doesNotMatch(await pane.render(), /running|queued/);
    }
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

test("a cursor rebuilt after reload does not replay a terminal already in history", async () => {
  // After /reload-plugins the ledger can come back without this job, and the
  // cursor is rebuilt from the round's first event. A follow-up queued on the
  // thread lists it as queued while its latest round is the one that failed.
  const failed = { type: "job.failed", seq: "3", text: "old failure" };
  let pages = [[{ type: "job.started", seq: "1" }, { type: "director.notified", seq: "2", text: "old note" }, failed]];
  let committedSeq = "3";
  const afters = [];
  const pane = await paneHarness(new Map(), undefined, "session", { replay: (args) => {
    const at = args.indexOf("--after");
    afters.push(at < 0 ? null : args[at + 1]);
    const events = pages.shift() ?? [];
    return [...events, { type: "end", nextCursor: `c${events.at(-1)?.seq ?? committedSeq}`, committedSeq }]
      .map((row) => JSON.stringify(row)).join("\n");
  } });
  pane.list([{ ...pane.listing[0], status: "queued", historyAvailable: true }]);
  await pane.tick();
  assert.deepEqual(pane.toasts.filter((text) => /job\.failed/.test(text)), [], "history is not news");
  assert.equal(pane.stored.get("codex:tasks:session")?.["job-a"]?.cursor, "c3");
  assert.equal(afters.at(-1), null, "the first read rebuilt the cursor from the start");

  // An ending committed after the rebuild is still reported once.
  pages = [[{ type: "job.started", seq: "4" }, { type: "job.failed", seq: "5", text: "new failure" }]];
  committedSeq = "5";
  pane.list([{ ...pane.listing[0], status: "running", historyAvailable: true }]);
  await pane.tick();
  assert.deepEqual(pane.toasts.filter((text) => /job\.failed/.test(text)), ["Alpha task · job.failed: new failure"]);
  assert.equal(afters.at(-1), "c3");
});

test("an ending reported from the view is not reported again when its event is replayed", async () => {
  let pages = [];
  const pane = await paneHarness(new Map(), undefined, "session", { replay: () => {
    const events = pages.shift() ?? [];
    return [...events, { type: "end", nextCursor: `c${events.at(-1)?.seq ?? "0"}`, committedSeq: events.at(-1)?.seq ?? "0" }]
      .map((row) => JSON.stringify(row)).join("\n");
  } });
  pane.list([{ ...pane.listing[0], historyAvailable: true }]);
  await pane.tick();
  // The view says the job is over before its job.completed is committed.
  Object.assign(pane.live, { status: "completed", activeRoundId: null, endedAt: new Date().toISOString(),
    lastMessage: { kind: "assistant", text: "done", at: "" } });
  pane.touch();
  pane.viewTick();
  await pane.tick();
  pages = [[{ type: "job.completed", seq: "7" }]];
  pane.list([{ ...pane.listing[0], status: "completed", historyAvailable: true }]);
  await pane.tick();
  await pane.tick();
  assert.equal(pane.toasts.filter((text) => /job\.completed/.test(text)).length, 1, pane.toasts.join("\n"));
});

test("confirmed channels retain fallback for undeclared producers and ACP owner exit", async () => {
  for (const [kind, declared] of [["codex", true], ["codex", false], ["codex", undefined], ["acp", true]]) {
    let replays = 0
    const calls = []
    const now = Date.now()
    const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", push: true, watch: false, now,
      preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
      toolCall: async request => { calls.push(request.tool); return { result: { taskId: "fallback-monitor" } } },
      replay: () => {
        replays++
        return [
          { type: "question.opened", seq: "1", payload: { requestId: "old-q" }, text: "request=old-q ids=source: Which?" },
          { type: "end", nextCursor: "c1", committedSeq: "1" },
        ].map(JSON.stringify).join("\n")
      } })
    pane.live.executor = { kind, label: kind }
    pane.live.pendingQuestion = { requestId: "old-q", text: "Which?", openedAt: "", expiresAt: null }
    pane.touch()
    pane.viewTick()
    pane.listing[0].historyAvailable = true
    pane.listing[0].directorPush = declared
    await pane.tick()
    assert.equal(replays > 0, declared !== true)
    assert.equal(pane.toasts.some(text => text.includes('request=old-q')), declared !== true)
    assert.equal(calls.filter(tool => tool === 'Monitor').length, kind === 'acp' || declared !== true ? 1 : 0)
    assert.equal(pane.acks.length, 0)
    assert.deepEqual([...pane.files].filter(([file]) => file.includes('.spool/')), [])
  }
})

test("a fallback Monitor survives a poll whose listing of its repository failed", async () => {
  const calls = []
  const now = Date.now()
  const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", push: true, watch: false, now,
    preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
    toolCall: async request => { calls.push(request.tool); return { result: { taskId: "fallback-monitor" } } },
    replay: () => JSON.stringify({ type: "end", nextCursor: "c0", committedSeq: "0" }) })
  pane.listing[0].historyAvailable = true
  pane.listing[0].directorPush = false
  await pane.tick()
  assert.equal(calls.filter(tool => tool === 'Monitor').length, 1)
  pane.list(new Error("listing timed out"))
  await pane.tick()
  pane.list(true)
  await pane.tick()
  assert.deepEqual(calls.filter(tool => tool !== 'Bash'), ['Monitor'], "kept through the failed listing, not stopped and rearmed")
})

test("Monitors require a live job record with and without a confirmed channel", async () => {
  for (const confirmed of [true, false]) for (const [status, live] of [["running", false], ["completed", false],
    ["queued", true], ["running", true]]) {
    const calls = [];
    const now = Date.now();
    const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", push: true, watch: false, now,
      preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
      toolCall: async request => { calls.push(request.tool); return { result: { taskId: "fallback-monitor" } } } });
    if (!confirmed) pane.files.delete("/tmp/codex-channel/4242.confirmed.json");
    pane.list([{ ...pane.listing[0], status, live, activeRoundId: "stale-round", directorPush: false }]);
    await pane.tick();
    assert.equal(calls.filter(tool => tool === "Monitor").length, live ? 1 : 0, `${confirmed}/${status}/${live}`);
  }
});

test("a queued Monitor frame dropped after retirement stays pending for channel ingress recovery", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const stateDir = resolveStateDir(cwd);
  const job = { id: "job-a", workspaceRoot: cwd, sessionId: "session", status: "running", pid: process.pid };
  const publisher = new DirectorPublisher();
  const payload = { id: "queued-note", message: "queued before confirmation" };
  const event = directorEvent(job, "director.notified", payload, stateDir);
  publisher.publish(job, event.type, payload, stateDir);
  const abort = new AbortController();
  const lines = [];
  let polls = 0;
  await streamJobEvents(cwd, { session: job.sessionId, threadRecords: false, signal: abort.signal, pollMs: 1 }, {
    directorStateDir: stateDir, status: async () => ({ unavailable: "broker exited" }),
    snapshot: () => { if (polls++) abort.abort(); return { running: [job], recent: [] }; },
    writeLine: async line => { lines.push(line); },
  });
  assert.equal(lines.length, 1);
  assert.equal(wasDelivered(event), false, "printing a Monitor line cannot commit ingress acceptance");
  const pane = await paneHarness(new Map([["codex:tasks:session:retiredMonitors", ["retired"]]]));
  const ingress = through(directorChannel());
  const engine = { plugin: { root: "/plugin" }, session: { id: async () => job.sessionId }, process: { run: ingressRun } };
  const notification = { origin: { kind: "task-notification" },
    text: `<task-notification><task-id>retired</task-id><event>${lines[0]}</event></task-notification>` };
  const rejected = await ingress(engine, notification, e => pane.prompt(e, async () => assert.fail("retired Monitor reached director")));
  assert.ok(rejected.drop);
  assert.equal(wasDelivered(event), false);
  assert.ok(fs.existsSync(eventPaths(event).item));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxd-pane-"));
  let accepted = 0;
  const channel = new DirectorChannel({ root: deliveryRoot(stateDir), dir, send: async message => {
    const attributes = Object.entries(message.params.meta).map(([key, value]) => `${key}="${value}"`).join(" ");
    await ingress(engine, { origin: { kind: "channel", server: "plugin:codex:director" },
      text: `<channel ${attributes}>${message.params.content}</channel>` }, async () => { accepted++; return {}; });
  } });
  t.after(async () => { await channel.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await channel.start(job.sessionId);
  await channel.handle({ action: "confirm", sessionId: job.sessionId, instance: channel.instance, nonce: channel.nonce });
  assert.equal(accepted, 1);
  assert.equal(wasDelivered(event), true);
  assert.ok((await ingress(engine, notification, async () => assert.fail("already accepted Monitor replay"))).drop);
});

test("a rebuilt cursor announces a historical question only while its live view still has that request pending", async () => {
  for (const pending of [true, false]) {
    const pane = await paneHarness(new Map(), undefined, "session", { replay: () => [
      { type: "question.opened", seq: "1", payload: { requestId: "q1" }, text: "request=q1 ids=source: Which source?" },
      { type: "end", nextCursor: "c1", committedSeq: "1" },
    ].map(JSON.stringify).join("\n") })
    pane.listing[0].historyAvailable = true
    if (pending) {
      pane.live.pendingQuestion = { requestId: "q1", text: "Which source?", openedAt: "", expiresAt: null }
      pane.touch()
      pane.viewTick()
    }
    await pane.tick()
    assert.equal(pane.toasts.filter(text => text.includes('question.opened')).length, pending ? 1 : 0)
  }
})

test("a channel goal hold stops after the last job ends by status or reconciliation on either delivery route", async () => {
  for (const directorPush of [true, false]) for (const source of ["status", "reconciliation"]) {
    const calls = [];
    const now = Date.now();
    const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", push: true, now,
      preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
      toolCall: async request => { calls.push(request); return { result: { backgroundTaskId: "hold-1" } }; },
      replay: () => JSON.stringify({ type: "end", nextCursor: "c0", committedSeq: "0" }),
    });
    const first = { ...pane.listing[0], historyAvailable: true, directorPush };
    const second = { ...first, id: "record-b", recordId: "record-b", jobId: "job-b", activeRoundId: "job-b", latestRoundId: "job-b",
      viewPath: pane.viewPath.replace("record-a", "record-b") };
    const secondJob = pane.jobPath.replace("job-a", "job-b");
    pane.files.set(secondJob, { id: "job-b", sessionId: "session", workspaceRoot: "/work", status: "running" });
    pane.files.set(second.viewPath, { ...pane.live, recordId: "record-b", jobId: "job-b", activeRoundId: "job-b", latestRoundId: "job-b" });
    pane.list([first, second]);
    await pane.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.filter(request => request.tool === "Bash"), [], "no goal, no hold");
    await pane.goal("all jobs merged", "Goal set: all jobs merged");
    await pane.tick();
    await new Promise(resolve => setImmediate(resolve));
    const holds = calls.filter(request => request.tool === "Bash");
    assert.equal(holds.length, 1);
    assert.equal(holds[0].run_in_background, true);
    assert.match(holds[0].command, /^: Codex jobs running, \/goal waits.*while :; do sleep 3600; done; : session$/);
    await pane.tick();
    assert.equal(calls.filter(request => request.tool === "Bash").length, 1, "one hold for both live jobs");
    pane.list([{ ...first, status: "completed" }, second]);
    await pane.tick();
    assert.equal(calls.filter(request => request.tool === "TaskStop").length, 0, "the other job still keeps the goal waiting");
    if (source === "status") pane.list([{ ...first, status: "completed" }, { ...second, status: "completed" }]);
    else {
      pane.files.set(secondJob, { ...pane.files.get(secondJob), status: "completed", completedAt: new Date(now).toISOString() });
      pane.touch();
      pane.viewTick();
    }
    await pane.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.filter(request => request.tool === "TaskStop"), [{ tool: "TaskStop", task_id: "hold-1" }]);
    assert.equal(pane.toasts.filter(text => text.includes('job.completed')).length, directorPush ? 0 : 2,
      "a broker ending releases the hold without requiring a pane ending line");
    const dropped = await pane.prompt({ origin: { kind: "task-notification" },
      text: "<task-notification><task-id>hold-1</task-id><status>killed</status></task-notification>" }, async () => assert.fail("hold stop reached the director"));
    assert.ok(dropped.drop);
  }
});

test("a stale running index does not hold /goal, and a goal turn ended with no job live keeps the goal", async () => {
  const calls = [];
  const now = Date.now();
  const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", push: true, now,
    preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
    toolCall: async request => { calls.push(request); return { result: { backgroundTaskId: "hold-1" } }; },
    replay: () => JSON.stringify({ type: "end", nextCursor: "c0", committedSeq: "0" }),
  });
  pane.list([{ ...pane.listing[0], historyAvailable: true, directorPush: true, live: false }]);
  await pane.goal("all jobs merged", "Goal set: all jobs merged");
  await pane.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(request => request.tool === "Bash"), []);
  // Other background work put the goal's check off; it is still on.
  await pane.turn();
  pane.list([{ ...pane.listing[0], historyAvailable: true, directorPush: true, live: true }]);
  await pane.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(request => request.tool === "Bash").length, 1);
});

test("reload finds the existing session goal hold and stops it without starting a second shell", async () => {
  const now = Date.now();
  const calls = [];
  const probes = [];
  const stored = new Map([["codex:tasks:session:goal", true],
    ["codex:tasks:session:hold", { armedAt: now - 60000, taskId: "saved-hold" }]]);
  const pane = await paneHarness(stored, undefined, "session", { ppid: "4242", push: true, now,
    preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
    pgrep: async args => { probes.push(args[2]); return { exitCode: 0, stdout: "123", stderr: "" }; },
    toolCall: async request => { calls.push(request); return { result: {} }; },
    replay: () => assert.fail("a push-capable job does not need pane replay"),
  });
  await pane.tick();
  assert.ok(probes.some(pattern => pattern.includes('the codex plugin stops this when they end') && pattern.endsWith(': session')));
  assert.equal(calls.filter(request => request.tool === "Bash").length, 0);
  pane.list([{ ...pane.listing[0], status: "queued" }]);
  Object.assign(pane.live, { status: "completed", activeRoundId: null, endedAt: new Date(now).toISOString() });
  pane.touch();
  pane.viewTick();
  await pane.tick();
  assert.equal(calls.filter(request => request.tool === "TaskStop").length, 0, "a queued round can still display its predecessor");
  pane.list([{ ...pane.listing[0], status: "completed" }]);
  await pane.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(request => request.tool === "TaskStop"), [{ tool: "TaskStop", task_id: "saved-hold" }]);
  const dropped = await pane.prompt({ origin: { kind: "task-notification" },
    text: "<task-notification><task-id>saved-hold</task-id><status>killed</status></task-notification>" }, async () => assert.fail("hold stop reached the director"));
  assert.ok(dropped.drop);
});

test("a goal cleared drops the hold, and a turn's end leaves it", async () => {
  const calls = [];
  const now = Date.now();
  const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", push: true, now,
    preset: [["/tmp/codex-channel/4242.confirmed.json", { sessionId: "session", until: now + 60000 }]],
    // A resumed session takes its goal from the transcript.
    messages: [{ role: "user", text: "<command-name>/goal</command-name>\n<command-args>ship it</command-args>" }],
    toolCall: async (request) => { calls.push(request); return { result: { backgroundTaskId: `hold-${calls.length}` } }; },
    replay: () => JSON.stringify({ type: "end", nextCursor: "c1", committedSeq: "1" }) });
  await pane.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((request) => request.tool === "Bash").length, 1);
  await pane.turn();
  await pane.goal("clear", "Goal cleared: ship it");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((request) => request.tool === "TaskStop"), [{ tool: "TaskStop", task_id: "hold-1" }]);
  await pane.goal("ship it again", "Goal set: ship it again");
  pane.advance(20000);
  await pane.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((request) => request.tool === "Bash").length, 2);
  await pane.turn("aborted");
  await pane.tick();
  assert.equal(calls.filter((request) => request.tool === "TaskStop").length, 1, "an interrupt leaves the goal on");
});

test("goal commands and transcripts read as set or cleared", () => {
  assert.equal(goalCommand("x", "Goal set: x"), true);
  assert.equal(goalCommand("", "No goal set"), false);
  assert.equal(goalCommand("", "Goal: x · 3 turns"), undefined);
  assert.equal(goalCommand("OFF"), false);
  assert.equal(goalFromMessages([{ role: "user", text: "<command-name>/goal</command-name><command-args>a</command-args>" },
    { role: "user", text: "<command-name>/goal</command-name><command-args>clear</command-args>" }]), false);
  assert.equal(goalFromMessages([{ role: "assistant", text: "hi" }]), undefined);
});

test("without the channel no hold is armed", async () => {
  const calls = [];
  const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242",
    toolCall: async (request) => { calls.push(request.tool); return { result: { taskId: "m1" } }; },
    replay: () => JSON.stringify({ type: "end", nextCursor: "c0", committedSeq: "0" }) });
  await pane.goal("all jobs merged", "Goal set: all jobs merged");
  await pane.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((tool) => tool === "Bash"), []);
});

test("a question committed before its view is written is still pushed, and an answered one is not", async () => {
  let pages = [[], [{ type: "question.opened", seq: "2", payload: { requestId: "q1" }, text: "request=q1 ids=source: Which source?" }],
    [{ type: "question.opened", seq: "3", payload: { requestId: "q2" }, text: "request=q2: Old?" },
      { type: "question.resolved", seq: "4", payload: { requestId: "q2" } }]];
  const pane = await paneHarness(new Map(), undefined, "session", { replay: () => {
    const events = pages.shift() ?? [];
    return [...events, { type: "end", nextCursor: `c${events.at(-1)?.seq ?? "1"}`, committedSeq: events.at(-1)?.seq ?? "1" }]
      .map((row) => JSON.stringify(row)).join("\n");
  } });
  pane.listing[0].historyAvailable = true;
  // The view still has no pending question.
  await pane.tick();
  await pane.tick();
  await pane.tick();
  assert.deepEqual(pane.toasts.filter((text) => /question\.opened/.test(text)),
    ["Alpha task · question.opened: request=q1 ids=source: Which source?"]);
});

test("while a probe is on its way the pane arms no Monitor, and arms one once the hold is over", async () => {
  const calls = [];
  const now = Date.now();
  const pane = await paneHarness(new Map(), undefined, "session", { ppid: "4242", watch: false, now,
    preset: [["/tmp/codex-channel/4242.probing.json", { at: now, until: now + 15000 }]],
    toolCall: async (request) => { calls.push(request.tool); return { result: { taskId: "m1" } }; },
    replay: () => JSON.stringify({ type: "end", nextCursor: "c0", committedSeq: "0" }) });
  await pane.tick();
  assert.deepEqual(calls.filter((tool) => tool === "Monitor"), []);
  pane.advance(20000);
  await pane.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((tool) => tool === "Monitor"), ["Monitor"]);
});

test("branch stops inherited pane monitors and watches only its own dispatches", async () => {
  const hooks = new Map();
  const timers = [];
  const observed = [];
  const monitors = [];
  const opened = [];
  const stored = new Map();
  const now = 1_000_000;
  let sessionId = "session-a";
  let startedAt = now - 3_600_000;
  const usageStarts = [];
  let jobs = ["a.json"];
  const job = (id) => JSON.stringify({ sessionId: `session-${id}`, workspaceRoot: `/work/${id}` });
  const live = (id) => JSON.stringify({
    schemaVersion: 1, recordId: `job-${id}`, jobId: `job-${id}`, label: `job ${id}`,
    status: "running", startedAt: new Date(now).toISOString(), endedAt: null,
    activeRoundId: `job-${id}`, latestRoundId: `job-${id}`, rounds: [], tail: [],
  });
  const engine = {
    plugin: { name: "codex", root: "/plugin" },
    session: { surfaces: async () => ["terminal"], cwd: async () => "/work/main", id: async () => sessionId, usage: async () => { usageStarts.push(startedAt); return { startedAt }; } },
    env: { get: async () => "/home/test" },
    clock: { now: async () => now, sleep: clockSleep, every: (ms, fn) => timers.push([ms, fn]), after: (_ms, fn) => setImmediate(fn) },
    store: { get: async (key) => stored.get(key), set: async (key, value) => { stored.set(key, value); } },
    fs: {
      exists: async (path) => path === "/plugin/scripts/codex-companion.mjs" || path === "/home/test/.claude/skills/code-director/scripts/dispatch.sh",
      list: async (path) => path === "/home/test/.claude/plugins/data" ? [{ kind: "dir", name: "codex" }]
        : path === "/home/test/.claude/plugins/data/codex/state" ? [{ kind: "dir", name: "main" }]
        : path.endsWith("/jobs") ? jobs.map((name) => ({ name, kind: "file", mtimeMs: name === "a.json" ? now - 1_800_000 : now, isLink: false })) : [],
      stat: async () => ({ mtimeMs: now }),
      read: async (path) => path.endsWith(".json") ? job(path.endsWith("a.json") ? "a" : "b")
        : live(path.endsWith("/a") ? "a" : "b"),
    },
    process: { run: async (args, options) => {
      if (args[0] === "bash") return { exitCode: 0, stdout: "/companion.mjs\n", stderr: "" };
      if (args[0] === "pgrep" && options.pgrep) return options.pgrep(args)
      if (args[0] === "pgrep") return { exitCode: 1, stdout: "", stderr: "" };
      observed.push({ cwd: options.cwd, sessionId: options.env.CODEX_COMPANION_SESSION_ID });
      const id = options.cwd.slice(-1);
      return { exitCode: 0, stdout: JSON.stringify({ threads: options.cwd === `/work/${id}` && options.env.CODEX_COMPANION_SESSION_ID === `session-${id}`
        ? [{ id: `job-${id}`, recordId: `job-${id}`, jobId: `job-${id}`, label: `job ${id}`,
          status: "running", live: true, sessionIds: [`session-${id}`], viewPath: `/view/${id}`, historyAvailable: false }] : [] }), stderr: "" };
    } },
    tool: { call: async (request) => {
      monitors.push(request);
      return request.tool === "Monitor" ? { result: { taskId: `monitor-${sessionId}` } } : {};
    } },
    ui: { panes: async () => [], open: async (request) => { opened.push(request); return { isPlaced: true }; }, invalidate: () => {}, log: () => {}, toast: () => {} },
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
  assert.ok(monitors.some((request) => request.command?.includes("--session session-a")));
  await until(() => stored.get("codex:tasks:session-a:ownedMonitors")?.includes("monitor-session-a"));
  const ended = await hooks.get("prompt.submit")(engine, {
    origin: { kind: "task-notification" },
    text: '<task-notification><task-id>monitor-session-a</task-id><status>completed</status><summary>Monitor "Codex job events in a" stream ended</summary></task-notification>',
  }, async () => assert.fail("the pane's own idle exit reached the director"));
  assert.ok(ended.drop);

  assert.ok(hooks.has("session.end"), "resume must detach this process's watches");
  await hooks.get("session.end")(engine, { reason: "resume", sessionId }, async () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(monitors.filter((request) => request.tool === "TaskStop"),
    [{ tool: "TaskStop", task_id: "monitor-session-a" }]);
  sessionId = "session-b";
  startedAt = now;
  const stale = await hooks.get("prompt.submit")(engine, {
    origin: { kind: "task-notification" },
    text: '<task-notification><task-id>monitor-session-a</task-id><event>QUESTION job=job-a</event></task-notification>',
  }, async () => assert.fail("inherited Monitor event reached the branch"));
  assert.ok(stale.drop);
  assert.equal(monitors.filter((request) => request.tool === "Monitor").length, 1);
  assert.match((await hooks.get("command.run")(engine, { command: "tasks", args: "" }, async () => {})).text,
    /nothing dispatched/);
  jobs = ["a.json", "b.json"];
  observed.length = 0;
  await hooks.get("tool.call")(engine, { command: "bash dispatch.sh" }, async () => {});
  await until(() => monitors.some((request) => request.command?.includes("events --cwd /work/b --session session-b")));

  assert.equal(timers.length, 3);
  assert.deepEqual(usageStarts, [now - 3_600_000, now]);
  assert.equal(stored.has("codex:tasks:session-b:since"), false);
  assert.ok(observed.some((call) => call.cwd === "/work/b" && call.sessionId === "session-b"));
  assert.equal(observed.some((call) => call.cwd === "/work/a"), false);
  assert.ok(monitors.some((request) => request.command?.includes("events --cwd /work/b --session session-b")));
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
    // Committed before the view caught up: its own text carries it.
    [{ type: "question.opened", text: "request=q1 ids=source: Which source?" }, { pendingQuestion: null, lastMessage: null },
      "job · question.opened: request=q1 ids=source: Which source?"],
  ];
  for (const [event, data, expected] of cases) {
    assert.equal(pushLine("job", event, data), expected, event.type);
  }
});

test("a restored pane drops its monitor's expiry after all jobs are gone", async () => {
  const stored = new Map([["codex:tasks:session:ownedMonitors", ["monitor-1"]]]);
  const pane = await paneHarness(stored, undefined, "session", { fsList: () => [] });
  pane.list([]);
  await pane.tick();
  const text = '<task-notification><task-id>monitor-1</task-id><summary>Monitor event: "Codex job events in work"</summary><event>[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]</event></task-notification>';
  const result = await pane.prompt({ origin: { kind: "task-notification" }, text }, async () => ({ forwarded: true }));
  assert.ok(result.drop, "expiry after the last job was handled must not wake the director");
});

test("only expiry notices for monitors owned by the task pane are dropped", () => {
  const notice = (taskId, event) => `<task-notification>
<task-id>${taskId}</task-id>
<summary>Monitor event: "Codex job events in alpha"</summary>
<event>${event}</event>
</task-notification>`;
  const owned = new Set(["monitor-1"]);
  const expiry = "[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]";
  const cases = [
    [notice("monitor-1", expiry), true],
    [notice("monitor-1", "[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]"), true],
    [notice("monitor-1", "[Monitor timed out — re-arm if needed.]"), true],
    [notice("monitor-2", expiry), false],
    [notice("", expiry), false],
    [notice("monitor-1", "[Monitor stopped]"), false],
    ...["DONE", "FAILED", "QUESTION", "NOTIFIED", "STALLED", "QUESTION_PENDING"].map(type =>
      [notice("monitor-1", `${type} job=job-1`), false]),
    [notice("monitor-1", `${expiry}\nDONE job=job-1`), false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(shouldDropMonitorExpiry(text, owned), expected, text);
  }
});

test("only idle exits of monitors the task pane armed are dropped", () => {
  const owned = new Set(["monitor-1"]);
  const end = (taskId, status, summary, body = "") => `<task-notification>
<task-id>${taskId}</task-id>
<status>${status}</status>
<summary>${summary}</summary>
${body ? `<event>${body}</event>` : ""}
</task-notification>`;
  const event = (taskId, line) => `<task-notification>
<task-id>${taskId}</task-id>
<summary>Monitor event: "Codex job events in alpha"</summary>
<event>${line}</event>
</task-notification>`;
  const cases = [
    [end("monitor-1", "completed", 'Monitor "Codex job events in alpha" stream ended'), true],
    [end("monitor-1", "completed", 'Monitor "Codex job events in alpha" ended without producing output (exit 0)'), true],
    [event("monitor-1", "IDLE_EXIT no active job for 60m; re-arm the monitor before the next dispatch"), true],
    [end("monitor-1", "failed", 'Monitor "Codex job events in alpha" script failed (exit 2)', "IDLE_EXIT no active job for 0m"), false],
    [end("monitor-1", "killed", 'Monitor "Codex job events in alpha" stopped'), false],
    [event("monitor-1", "DONE job=job-1 [alpha] finished"), false],
    [end("monitor-1", "completed", 'Monitor "Codex job events in alpha" stream ended', "DONE job=job-1 [alpha] finished\nIDLE_EXIT no active job for 0m"), false],
    [end("monitor-2", "completed", 'Monitor "Codex job events in alpha" stream ended'), false],
    [event("monitor-2", "IDLE_EXIT no active job for 60m; re-arm the monitor before the next dispatch"), false],
    ['<task-notification><summary>Monitor "Codex job events in alpha" stream ended</summary></task-notification>', false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(shouldDropMonitorEnd(text, owned), expected, text);
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
  const ui = { Box: element("Box"), Text: element("Text"), Code: element("Code"), Markdown: element("Markdown"), Button: element("Button") };
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
  let selected;
  const tree = paneBody(ui, [data], 100, 20, Date.parse(data.endedAt), null, (id) => { selected = id; });
  const nodes = [];
  const visit = (value) => {
    if (typeof value === "string") return value;
    nodes.push(value);
    if (value.type === "Markdown") return value.props.text;
    return (value.children ?? []).map(visit).join("\n");
  };
  const text = visit(tree);
  assert.equal(tree.props.paddingRight, 2);
  assert.ok(nodes.filter((node) => node !== tree && typeof node.props.width === "number").every((node) => node.props.width <= 98));
  const empty = paneBody(ui, [], 100, 20, Date.parse(data.endedAt), null, () => {});
  assert.equal(empty.props.paddingRight, 2);
  assert.equal(nodes.filter((node) => node.type === "Button").length, 1);
  assert.equal(nodes.find((node) => node.type === "Button").props.key, "codex_tab_task-old");
  const button = nodes.find((node) => node.type === "Button");
  assert.equal(button.children[1].type, "Text");
  assert.match(button.children[1].children[0], /completed/);
  button.props.onPress();
  assert.equal(selected, "task-old");
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
  nodes.length = 0;
  visit(paneBody(ui, [data], 20, 20, Date.parse(data.endedAt), null, () => {}));
  assert.ok(nodes.slice(1).filter((node) => typeof node.props.width === "number").every((node) => node.props.width <= 18));
});
