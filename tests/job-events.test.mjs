import { acceptDirectorEvents, deliveryRefs, eventFromRef, stripDeliveryTags, directorEvent, eventPaths, durableJson } from "../plugins/codex/scripts/lib/director-delivery.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { recordTerminalReports, streamJobEvents, terminalReportsPath } from "../plugins/codex/scripts/lib/job-events.mjs";
import { checkJobLiveness, ownerProcessAlive } from "../plugins/codex/scripts/lib/job-control.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { isolateTestEnvironment, makeTempDir } from "./helpers.mjs";

const job = { id: "job-1", threadId: "thread-1", status: "running" };

async function monitor(reports, handlers = {}, options = {}) {
  const controller = new AbortController();
  const lines = [];
  let poll = 0;
  await streamJobEvents("/repo", { pollMs: 1, signal: controller.signal, ...options }, {
    snapshot(cwd, options) {
      assert.equal(cwd, "/repo");
      assert.equal(options.all, true);
      if (poll === reports.length) controller.abort();
      return { running: [], latestFinished: null, recent: [], ...reports[poll++] };
    },
    status: async () => ({}),
    readJob: () => null,
    acknowledge: async () => assert.fail("Unexpected acknowledgement"),
    claimQuestion: async () => true,
    terminalReportsFile: path.join(makeTempDir(), "terminal-reports.json"),
    directorStateDir: path.join(handlers.terminalReportsFile ? path.dirname(handlers.terminalReportsFile) : makeTempDir(), "state", "repo"),
    ...handlers,
    writeLine: async (line) => {
      const output = async () => {
        const text = stripDeliveryTags(line);
        lines.push(text);
        await handlers.writeLine?.(text);
        return {};
      };
      const events = deliveryRefs(line).map(eventFromRef).filter(Boolean);
      if (events.length) await acceptDirectorEvents(events, "monitor", output);
      else await output();
    }
  });
  return lines;
}

test("session monitors catch terminals in the re-arm gap once across restarts", async () => {
  const terminalReportsFile = path.join(makeTempDir(), "terminal-reports.json");
  const mine = { ...job, sessionId: "session-a" };
  const handlers = { terminalReportsFile };
  await monitor([{ running: [mine] }], handlers, { session: "session-a" });
  const finished = ["completed", "failed", "cancelled"].map((status, index) => ({
    ...mine, id: `gap-${index}`, status, errorMessage: "Stopped"
  }));
  const report = { latestFinished: { ...mine, status: "completed" }, recent: [...finished,
    { ...mine, id: "foreign", sessionId: "session-b", status: "completed" }] };
  assert.deepEqual(await monitor([report, report], handlers, { session: "session-a" }), [
    "DONE job=job-1 thread=thread-1",
    "DONE job=gap-0 thread=thread-1",
    "FAILED job=gap-1 thread=thread-1 Stopped",
    "FAILED job=gap-2 thread=thread-1 Stopped"
  ]);
  assert.deepEqual(await monitor([report], handlers, { session: "session-a" }), []);
  const extra = { ...mine, id: "after-restart", status: "completed" };
  assert.deepEqual(await monitor([{ ...report, recent: [...report.recent, extra] }], handlers, { session: "session-a" }),
    ["DONE job=after-restart thread=thread-1"]);
});

test("a first session watch baselines old terminals even without emitting anything", async () => {
  const terminalReportsFile = path.join(makeTempDir(), "terminal-reports.json");
  const mine = { ...job, sessionId: "session" };
  const old = ["completed", "failed", "cancelled"].map((status, index) => ({ ...mine, id: `old-${index}`, status }));
  const handlers = { terminalReportsFile, status: async () => assert.fail("historical terminals must not read live state") };
  const report = { latestFinished: old[0], recent: old.slice(1) };
  assert.deepEqual(await monitor([report], handlers, { session: "session" }), []);
  assert.ok(fs.existsSync(terminalReportsFile), "the baseline must survive a restart with no output");
  const gap = { ...mine, id: "gap-job", status: "completed" };
  assert.deepEqual(await monitor([{ ...report, recent: [...report.recent, gap] }],
    { terminalReportsFile }, { session: "session" }), ["DONE job=gap-job thread=thread-1"]);
  assert.deepEqual(await monitor([report], handlers, { session: "session" }), []);
});

test("first watch still reports a running job that finishes after its baseline", async () => {
  const mine = { ...job, sessionId: "session" };
  const old = { ...mine, id: "old-job", status: "completed" };
  assert.deepEqual(await monitor([
    { running: [mine], latestFinished: old },
    { latestFinished: { ...mine, status: "completed" }, recent: [old] }
  ], {}, { session: "session" }), ["DONE job=job-1 thread=thread-1"]);
});

test("an existing 1.4.35 receipt retains deduplication and catches the re-arm gap", async () => {
  const terminalReportsFile = path.join(makeTempDir(), "terminal-reports.json");
  const mine = { ...job, sessionId: "session", status: "completed" };
  fs.writeFileSync(terminalReportsFile, JSON.stringify([mine.id]));
  const gap = { ...mine, id: "gap-job" };
  const report = { latestFinished: gap, recent: [mine] };
  assert.deepEqual(await monitor([report], { terminalReportsFile }, { session: "session" }),
    ["DONE job=gap-job thread=thread-1"]);
  assert.deepEqual(await monitor([report], { terminalReportsFile }, { session: "session" }), []);
});

test("a terminal output failure is retried by the next session monitor", async () => {
  const terminalReportsFile = path.join(makeTempDir(), "terminal-reports.json");
  await monitor([{ running: [{ ...job, sessionId: "session" }] }], { terminalReportsFile }, { session: "session" });
  const report = { latestFinished: { ...job, sessionId: "session", status: "completed" } };
  await assert.rejects(monitor([report], { terminalReportsFile, writeLine: async () => { throw new Error("output failed"); } },
    { session: "session" }), /output failed/);
  assert.deepEqual(await monitor([report], { terminalReportsFile }, { session: "session" }),
    ["DONE job=job-1 thread=thread-1"]);
});

for (const exitIdleMs of [undefined, 60000]) {
  test(`events exits after idle time with no jobs (${exitIdleMs ?? "default"}ms)`, async () => {
    const interval = exitIdleMs ?? 3600000;
    const startedAt = 123456;
    const times = [startedAt, startedAt + interval - 1, startedAt + interval];
    let clock = startedAt;
    let poll = 0;
    const lines = await monitor([], {
      now: () => clock,
      snapshot: () => {
        assert.ok(poll < times.length, "Monitor must return at the idle deadline");
        clock = times[poll++];
        return { running: [], latestFinished: null, recent: [] };
      }
    }, { exitIdleMs });
    assert.equal(poll, times.length);
    assert.deepEqual(lines, [
      `IDLE_EXIT no active job for ${interval / 60000}m; re-arm the monitor before the next dispatch`
    ]);
  });
}

test("events stays alive while a job is active beyond the idle timeout", async () => {
  let clock = 0;
  let calls = 0;
  const lines = await monitor(Array.from({ length: 3 }, () => ({ running: [job] })), {
    now: () => clock,
    progressAt: () => clock,
    status: async () => {
      calls += 1;
      clock += 60001;
      return {};
    }
  }, { exitIdleMs: 60000 });
  assert.equal(calls, 3);
  assert.deepEqual(lines, []);
});

for (const notified of [false, true]) {
  test(`events resets idle time when emitting ${notified ? "NOTIFIED and DONE" : "DONE"}`, async () => {
    const times = [0, 60000, 119999, 120000];
    const trace = [];
    let clock = 0;
    let poll = 0;
    const lines = await monitor([], {
      now: () => {
        trace.push("now");
        return clock;
      },
      progressAt: () => clock,
      snapshot: () => {
        assert.ok(poll < times.length, "Monitor must return one idle interval after DONE");
        clock = times[poll++];
        return {
          running: poll === 1 ? [job] : [],
          latestFinished: poll > 1 ? { ...job, status: "completed" } : null,
          recent: []
        };
      },
      status: async () => notified && poll === 2
        ? { notifications: [{ id: "note-1", message: "Ready" }] } : {},
      acknowledge: async () => {},
      writeLine: (line) => trace.push(line)
    }, { exitIdleMs: 60000 });
    const notification = "NOTIFIED job=job-1 thread=thread-1 Ready";
    const done = "DONE job=job-1 thread=thread-1";
    assert.equal(poll, times.length);
    assert.deepEqual(lines, [
      ...(notified ? [notification] : []),
      done,
      "IDLE_EXIT no active job for 1m; re-arm the monitor before the next dispatch"
    ]);
    if (notified) {
      // DONE also resets the deadline, so verify NOTIFIED samples the clock before DONE.
      assert.deepEqual(trace.slice(trace.indexOf(notification), trace.indexOf(done) + 1), [notification, "now", done]);
    }
  });
}

test("events acknowledges a note once and reports only jobs observed active", async () => {
  const acknowledged = [];
  const note = { id: "note-1", message: "Phase done\r\nNext step" };
  const finished = { ...job, status: "completed" };
  const old = { id: "old-job", status: "completed" };
  const lines = await monitor([
    { running: [job], latestFinished: old },
    { running: [job], latestFinished: old },
    { latestFinished: finished, recent: [old] },
    { latestFinished: finished, recent: [old] }
  ], {
    status: async () => ({ notifications: [note] }),
    acknowledge: async (cwd, current, ids) => acknowledged.push({ cwd, jobId: current.id, ids })
  });
  assert.deepEqual(lines, [
    "NOTIFIED job=job-1 thread=thread-1 Phase done Next step",
    "DONE job=job-1 thread=thread-1"
  ]);
  assert.deepEqual(acknowledged, [{ cwd: "/repo", jobId: job.id, ids: [note.id] }]);
});

test("events reports only jobs owned by the requested Claude session", async () => {
  const mine = { ...job, id: "mine", sessionId: "session-a" };
  const foreign = { ...job, id: "foreign", sessionId: "session-b" };
  const legacy = { ...job, id: "legacy" };
  const observed = [];
  const lines = await monitor([
    { running: [mine, foreign, legacy] },
    { latestFinished: { ...mine, status: "completed" }, recent: [
      { ...foreign, status: "completed" }, { ...legacy, status: "completed" }
    ] }
  ], {
    status: async (cwd, current) => { observed.push(current.id); return {}; }
  }, { session: "session-a" });
  assert.deepEqual(observed, ["mine", "mine"]);
  assert.deepEqual(lines, ["DONE job=mine thread=thread-1"]);
});

for (const terminal of ["completed", "failed"]) {
  test(`events includes the job label on every event (${terminal})`, async () => {
    const labeled = { ...job, label: "answer validation" };
    let clock = 0;
    let poll = 0;
    const lines = await monitor([
      { running: [labeled] }, { running: [labeled] },
      { latestFinished: { ...labeled, status: terminal, errorMessage: "Stopped" } }
    ], {
      now: () => clock,
      progressAt: () => 0,
      status: async () => {
        clock = poll++ * 120000;
        return { questions: [{ requestId: "request-1", questions: [{ question: "Choose?" }] }],
          notifications: [{ id: "note-1", message: "Ready", pendingRequestId: "request-1" }] };
      },
      acknowledge: async () => {}
    });
    assert.deepEqual(lines, [
      "QUESTION job=job-1 [answer validation] request=request-1 Choose?",
      "NOTIFIED job=job-1 [answer validation] thread=thread-1 pending_request=request-1 Ready",
      "QUESTION_PENDING job=job-1 [answer validation] request=request-1 2m unanswered: Choose?",
      terminal === "completed" ? "DONE job=job-1 [answer validation] thread=thread-1" : "FAILED job=job-1 [answer validation] thread=thread-1 Stopped"
    ]);
  });
}

test("a question line names the ids an answer must be keyed by", async () => {
  const lines = await monitor([{ running: [job] }], {
    status: async () => ({ questions: [{ requestId: "2", questions: [{ id: "scope", question: "Which scope?" }, { id: "depth" }] }] })
  });
  assert.deepEqual(lines, ["QUESTION job=job-1 request=2 ids=scope,depth [scope] Which scope? | [depth]"]);
});

test("a question line carries every question with its options and their trade-offs", async () => {
  const lines = await monitor([{ running: [job] }], {
    status: async () => ({ questions: [{ requestId: "3", questions: [
      { id: "source", header: "Source", question: "Task X, step 2: config.ts:40 and env disagree.\nWhich wins?",
        options: [{ label: "Env (Recommended)", description: "Matches production" }, { label: "Config", description: "Keeps tests as they are" }] },
      { id: "scope", question: "Fix callers too?", options: [{ label: "Yes" }, { label: "No" }] }
    ] }] })
  });
  assert.deepEqual(lines, ["QUESTION job=job-1 request=3 ids=source,scope [source] Task X, step 2: config.ts:40 and env disagree. Which wins? "
    + "Options: Env (Recommended) (Matches production); Config (Keeps tests as they are). | [scope] Fix callers too? Options: Yes; No."]);
});

test("events reports each request once with its full question on one line", async () => {
  const lines = await monitor([{ running: [job] }, { running: [job] }], {
    status: async () => ({ questions: [{ requestId: "request-1", questions: [
      { id: "a", question: `Choose\n${"x".repeat(300)}` }, { id: "b", question: "Second" }
    ] }, { requestId: "request-2", questions: [{ question: "y".repeat(2000) }] }] })
  });
  assert.deepEqual(lines, [`QUESTION job=job-1 request=request-1 ids=a,b [a] Choose ${"x".repeat(300)} | [b] Second`,
    `QUESTION job=job-1 request=request-2 ${"y".repeat(2000)}`]);
});

test("events omits answered questions and marks notifications with pending requests", async () => {
  let poll = 0;
  const lines = await monitor([{ running: [job] }, { running: [job] }], {
    status: async () => ++poll === 1
      ? { questions: [{ requestId: 8, questions: [{ question: "Choose?" }] }], notifications: [{ id: "note-1", message: "Need choice", pendingRequestId: 8 }] }
      : { questions: [], notifications: [] },
    acknowledge: async () => {}
  });
  assert.deepEqual(lines, [
    "QUESTION job=job-1 request=8 Choose?",
    "NOTIFIED job=job-1 thread=thread-1 pending_request=8 Need choice"
  ]);
});

test("events reminds pending questions at two-minute intervals and stops when removed or finished", async () => {
  const startedAt = 123456;
  const times = [0, 119999, 120000, 239999, 240000, 360000, 480000];
  const question = { requestId: "request-1", expiresAt: startedAt + 600000, questions: [
    { question: `Choose\n${"x".repeat(300)}` }, { question: "Do not show this" }
  ] };
  let clock = startedAt;
  let poll = 0;
  const lines = await monitor(times.map((time) => time === 480000
    ? { latestFinished: { ...job, status: "completed" } } : { running: [job] }), {
    now: () => clock,
    progressAt: () => clock,
    status: async () => {
      const time = times[poll++];
      clock = startedAt + time;
      return { questions: time === 360000 ? [] : [question] };
    }
  });
  const text = `Choose ${"x".repeat(193)}`;
  assert.deepEqual(lines, [
    `QUESTION job=job-1 request=request-1 [question] Choose ${"x".repeat(300)} | [question] Do not show this`,
    `QUESTION_PENDING job=job-1 request=request-1 2m unanswered, expires in 8m: ${text}`,
    `QUESTION_PENDING job=job-1 request=request-1 4m unanswered, expires in 6m: ${text}`,
    "DONE job=job-1 thread=thread-1"
  ]);
});

test("events tracks each question independently and supports a custom reminder interval", async () => {
  const times = [0, 30000, 59999, 60000, 90000];
  let clock = 0;
  let poll = 0;
  const lines = await monitor(times.map(() => ({ running: [job] })), {
    now: () => clock,
    progressAt: () => clock,
    status: async () => {
      clock = times[poll++];
      return { questions: [
        { requestId: "request-1", expiresAt: 90001, questions: [{ question: "First?" }] },
        ...(clock >= 30000 ? [{ requestId: "request-2", questions: [{ question: "Second?" }] }] : [])
      ] };
    }
  }, { questionRemindMs: 60000 });
  assert.deepEqual(lines, [
    "QUESTION job=job-1 request=request-1 First?",
    "QUESTION job=job-1 request=request-2 Second?",
    "QUESTION_PENDING job=job-1 request=request-1 1m unanswered, expires in 0m: First?",
    "QUESTION_PENDING job=job-1 request=request-2 1m unanswered: Second?"
  ]);
});

test("events silently retries unavailable broker state before reporting a failure", async () => {
  const failed = { ...job, status: "failed", errorMessage: "First error\nMore details" };
  let calls = 0;
  const lines = await monitor([
    { running: [job] }, { latestFinished: failed }, { latestFinished: failed }, { latestFinished: failed }
  ], { status: async () => ++calls < 3 ? { unavailable: "Broker offline" } : {} });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 First error"]);
});

test("events reads a turn failure from the stored result and falls back to unknown", async () => {
  const second = { ...job, id: "job-2", threadId: null };
  const lines = await monitor([
    { running: [job, second] },
    { latestFinished: { ...job, status: "failed" }, recent: [{ ...second, status: "failed" }] }
  ], { readJob: (cwd, id) => id === job.id ? { result: { error: { message: "Turn failed\nDetails" } } } : null });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 Turn failed", "FAILED job=job-2 thread=unknown unknown"]);
});

test("events retries acknowledgement and drains terminal notifications before DONE", async () => {
  let calls = 0;
  let attempts = 0;
  const finished = { ...job, status: "completed" };
  const lines = await monitor([
    { running: [job] }, { latestFinished: finished }, { latestFinished: finished }
  ], {
    status: async () => ++calls === 1 ? {} : { notifications: [{ id: "note-1", message: "Ready" }] },
    acknowledge: async () => { if (++attempts === 1) throw new Error("Broker offline"); }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(lines, ["NOTIFIED job=job-1 thread=thread-1 Ready", "DONE job=job-1 thread=thread-1"]);
});

test("events fails a dead owner once even when its broker is unavailable", async () => {
  const current = { ...job, pid: 123 };
  const failures = [];
  const lines = await monitor([{ running: [current] }, { latestFinished: current }], {
    ownerAlive: () => false,
    status: async () => ({ unavailable: "Broker offline" }),
    fail(cwd, record, reason) {
      failures.push(reason);
      Object.assign(current, { status: "failed", errorMessage: reason });
      return current;
    }
  });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 owner process exited"]);
  assert.deepEqual(failures, ["owner process exited"]);
});

test("a confirmed channel keeps Monitor fallback until the producer declares push support", async (t) => {
  isolateTestEnvironment(t);
  for (const directorPush of [undefined, false, true]) {
    const directorStateDir = path.join(makeTempDir(), "state", "repo");
    const current = { ...job, directorPush, sessionId: "owner", pid: process.pid };
    const event = directorEvent(current, "job.completed", {}, directorStateDir);
    const confirmationFile = path.join(makeTempDir(), "confirmed.json");
    durableJson(confirmationFile, { instance: "instance", sessionId: "owner", until: Date.now() + 60000 });
    durableJson(path.join(eventPaths(event).directory, "route.json"), { instance: "instance", sessionId: "owner", confirmed: true, confirmationFile });
    const lines = await monitor([{ running: [current] }, { latestFinished: { ...current, status: "completed" } }], {
      directorStateDir, status: async (_cwd, record) => record.status === "running" ? {
        questions: [{ requestId: "legacy-q", questions: [{ id: "source", question: "Which source?" }] }]
      } : {},
    }, { session: "owner" });
    assert.deepEqual(lines, directorPush === true ? [] : [
      "QUESTION job=job-1 request=legacy-q ids=source Which source?", "DONE job=job-1 thread=thread-1"
    ]);
  }
});

test("ACP owner loss still stages an ending when the channel is confirmed", async (t) => {
  isolateTestEnvironment(t);
  const directorStateDir = path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "repo");
  const current = { ...job, executor: "acp", sessionId: "owner", pid: 123 };
  const event = directorEvent(current, "job.failed", {}, directorStateDir);
  const confirmationFile = path.join(makeTempDir(), "channel-confirmed.json");
  durableJson(confirmationFile, { instance: "instance", sessionId: "owner", until: Date.now() + 60000 });
  durableJson(path.join(eventPaths(event).directory, "route.json"), { instance: "instance", sessionId: "owner", confirmed: true, confirmationFile });
  const lines = await monitor([{ running: [current] }], {
    directorStateDir, ownerAlive: () => false, status: async () => ({ unavailable: "worker exited" }),
    fail: (_cwd, record, reason) => ({ ...record, status: "failed", errorMessage: reason }),
  }, { session: "owner" });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 owner process exited"]);
});

test("an owner failure already marked by status is reported without acknowledging stale notes", async () => {
  let poll = 0;
  const lines = await monitor([
    { running: [job] }, { latestFinished: { ...job, status: "failed", errorMessage: "owner process exited" } }
  ], {
    status: async () => ++poll === 1 ? {} : { notifications: [{ id: "stale", message: "Pending" }] }
  });
  assert.deepEqual(lines, ["FAILED job=job-1 thread=thread-1 owner process exited"]);
});

test("broker liveness fails on the third consecutive miss and resets after success", () => {
  const failures = new Map();
  const options = { ownerAlive: () => true, fail: (cwd, current, reason) => ({ ...current, status: "failed", errorMessage: reason }) };
  const check = (live) => checkJobLiveness("/repo", job, live, failures, options);
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({}).status, "running");
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({ unavailable: "offline" }).status, "running");
  assert.equal(check({ unavailable: "offline" }).errorMessage, "broker unreachable");
  assert.equal(ownerProcessAlive(process.pid), true);
  assert.equal(ownerProcessAlive(null), null);
});

test("live broker deadline closes a socket even when initialize never replies", async (t) => {
  const root = makeTempDir("codex-live-deadline-");
  const socketPath = path.join(root, "broker.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await assert.rejects(CodexAppServerClient.connect(root, {
    brokerEndpoint: `unix://${socketPath}`, brokerTimeoutMs: 50
  }), /Live broker request timed out/);
});

test("endings delivered elsewhere join an existing watch record and never start one", async (t) => {
  isolateTestEnvironment(t);
  const repo = path.join(makeTempDir(), "state", "repo");
  assert.equal(await recordTerminalReports(repo, "s1", ["job-a"]), false);
  const file = terminalReportsPath(repo, "s1");
  assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(["job-old"]));
  assert.equal(await recordTerminalReports(repo, "s1", ["job-a", "job-old"]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).sort(), ["job-a", "job-old"]);
});
