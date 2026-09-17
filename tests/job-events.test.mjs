import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { streamJobEvents } from "../plugins/codex/scripts/lib/job-events.mjs";
import { checkJobLiveness, ownerProcessAlive } from "../plugins/codex/scripts/lib/job-control.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { makeTempDir } from "./helpers.mjs";

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
    ...handlers,
    writeLine: (line) => {
      lines.push(line);
      handlers.writeLine?.(line);
    }
  });
  return lines;
}

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
    }, { stallMs: 120000 });
    assert.deepEqual(lines, [
      "QUESTION job=job-1 [answer validation] request=request-1 Choose?",
      "NOTIFIED job=job-1 [answer validation] thread=thread-1 pending_request=request-1 Ready",
      "STALLED job=job-1 [answer validation] thread=thread-1 2m without progress",
      "QUESTION_PENDING job=job-1 [answer validation] request=request-1 2m unanswered: Choose?",
      terminal === "completed" ? "DONE job=job-1 [answer validation] thread=thread-1" : "FAILED job=job-1 [answer validation] thread=thread-1 Stopped"
    ]);
  });
}

test("events reports each request once and limits the first question to one line of 200 characters", async () => {
  const lines = await monitor([{ running: [job] }, { running: [job] }], {
    status: async () => ({ questions: [{ requestId: "request-1", questions: [
      { question: `Choose\n${"x".repeat(300)}` }, { question: "Do not show this" }
    ] }] })
  });
  assert.deepEqual(lines, [`QUESTION job=job-1 request=request-1 Choose ${"x".repeat(193)}`]);
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
    `QUESTION job=job-1 request=request-1 ${text}`,
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

test("events reports a stall once per interval and new progress resets the interval", async () => {
  let clock = 20 * 60000;
  let progress = 0;
  let poll = 0;
  const lines = await monitor(Array.from({ length: 5 }, () => ({ running: [job] })), {
    now: () => clock,
    progressAt: () => progress,
    status: async () => {
      poll += 1;
      if (poll === 2) clock += 60000;
      if (poll === 3) clock += 15 * 60000;
      if (poll === 4) progress = clock;
      if (poll === 5) clock += 60000;
      return {};
    }
  });
  assert.deepEqual(lines, [
    "STALLED job=job-1 thread=thread-1 20m without progress",
    "STALLED job=job-1 thread=thread-1 36m without progress"
  ]);
});

test("events uses recent log progress when monitoring an hour-old job", async () => {
  const started = Date.now();
  let clock = started;
  const logFile = path.join(makeTempDir(), "job.log");
  fs.writeFileSync(logFile, "still working\n");
  const current = { ...job, startedAt: new Date(started - 60 * 60000).toISOString(), logFile };
  const lines = await monitor(Array.from({ length: 3 }, () => ({ running: [current] })), {
    now: () => clock,
    status: async () => {
      fs.utimesSync(logFile, new Date(clock), new Date(clock));
      clock += 60000;
      return {};
    }
  });
  assert.deepEqual(lines, []);
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
