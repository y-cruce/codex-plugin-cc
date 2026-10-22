import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { gcPluginState, scheduleStateGc } from "../plugins/codex/scripts/lib/state-gc.mjs";
import { parseSessionTaskIndex, sessionTaskIndexPath } from "../plugins/codex/scripts/lib/session-task-index.mjs";

const DAY = 86_400_000;

test("state GC keeps usable or uncertain stores, deletes only idle garbage, and prunes every session index once daily", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-gc-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "state");
  fs.mkdirSync(root);
  const now = Date.now();
  const old = new Date(now - 4 * DAY);
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const age = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) age(file);
      else if (!entry.isSymbolicLink()) fs.utimesSync(file, old, old);
    }
    fs.utimesSync(dir, old, old);
  };
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace);
  const job = { id: "job", workspaceRoot: path.join(dataDir, "gone"), status: "completed", sessionId: "pre-ci" };
  const outside = path.join(dataDir, "other-plugin", "state");
  put(path.join(outside, "jobs", "job.json"), job);
  age(outside);
  const cases = [
    { name: "missing-workspace", remove: true },
    { name: "empty", empty: true, remove: true },
    { name: "existing-workspace", patch: { workspaceRoot: workspace } },
    { name: "mixed-workspaces", extra: { ...job, id: "existing", workspaceRoot: workspace } },
    { name: "recent-file", recent: "jobs/job.json" },
    { name: "recent-nested-file", recent: "thread-records/record/events.jsonl" },
    { name: "recent-directory", recent: "jobs" },
    { name: "recent-empty", empty: true, recent: "." },
    { name: "live-running", patch: { status: "running", pid: process.pid } },
    { name: "live-queued", patch: { status: "queued", pid: process.pid } },
    { name: "dead-owner", patch: { status: "running", pid: 2147483647 }, remove: true },
    { name: "unknown-owner", patch: { status: "running", pid: null } },
    { name: "unknown-workspace", patch: { workspaceRoot: null } },
    { name: "malformed-job", malformed: true },
    { name: "nested-symlink", symlink: true },
    { name: "legacy-live", legacy: true, patch: { status: "queued", pid: process.pid } },
    { name: "history-only", history: "job-history/job/manifest.json", remove: true },
    { name: "thread-only", history: "thread-records/record/rounds/job.json", patch: { workspaceRoot: workspace } },
  ];
  for (const row of cases) {
    const dir = path.join(root, row.name);
    fs.mkdirSync(dir);
    if (!row.empty) {
      const record = { ...job, ...row.patch };
      const value = row.legacy ? { jobs: [record] } : row.history ?
        row.history.startsWith("job-history") ? { metadata: { job: record } } : { job: record } : record;
      const file = path.join(dir, row.legacy ? "state.json" : row.history ?? "jobs/job.json");
      put(file, value);
      if (row.malformed) fs.writeFileSync(file, "{");
      if (row.extra) put(path.join(dir, "jobs", "extra.json"), row.extra);
    }
    if (row.symlink) fs.symlinkSync(outside, path.join(dir, "link"));
    if (row.recent?.includes("thread-records")) put(path.join(dir, row.recent), { event: "new" });
    age(dir);
    if (row.recent) fs.utimesSync(path.join(dir, row.recent), new Date(now), new Date(now));
  }
  fs.symlinkSync(outside, path.join(root, "symlink-store"));
  const indexes = ["pre-ci", "another-session"].map(session => sessionTaskIndexPath(root, session));
  const rows = [
    { complete: true, sessionId: "pre-ci" },
    ...cases.map(row => ({ stateDir: path.join(root, row.name), jobId: "job" })),
    { stateDir: outside, jobId: "job" },
  ];
  fs.mkdirSync(path.dirname(indexes[0]), { recursive: true });
  for (const file of indexes) {
    fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    fs.utimesSync(file, old, old);
  }
  const linkedIndex = path.join(path.dirname(indexes[0]), "linked.jsonl");
  const sentinel = path.join(dataDir, "other-plugin", "index.jsonl");
  fs.writeFileSync(sentinel, JSON.stringify(rows[1]));
  fs.symlinkSync(sentinel, linkedIndex);
  const before = indexes.map(file => fs.readFileSync(file, "utf8"));
  const dry = gcPluginState({ dataDir, dryRun: true, now });
  assert.deepEqual(dry.candidates.map(row => path.basename(row.stateDir)).sort(),
    cases.filter(row => row.remove).map(row => row.name).sort());
  assert.equal(dry.summary.byRule.noJobs.directories, 1);
  assert.equal(dry.summary.byRule.workspaceMissing.directories, 3);
  assert.equal(dry.summary.sessions["pre-ci"].jobs, 3);
  assert.ok(dry.summary.bytes > 0);
  assert.equal(fs.existsSync(path.join(root, ".gc")), false, "dry run writes no marker");
  for (const [i, file] of indexes.entries()) assert.equal(fs.readFileSync(file, "utf8"), before[i]);
  const run = gcPluginState({ dataDir, now });
  assert.equal(run.summary.directories, dry.summary.directories);
  for (const row of cases) assert.equal(fs.existsSync(path.join(root, row.name)), !row.remove, row.name);
  assert.ok(fs.existsSync(path.join(outside, "jobs/job.json")));
  assert.equal(fs.readFileSync(sentinel, "utf8"), JSON.stringify(rows[1]));
  for (const file of indexes) {
    const parsed = parseSessionTaskIndex(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.complete, true);
    assert.equal(parsed.entries.length, cases.length - 4 + 1);
    assert.ok(parsed.entries.some(row => row.stateDir === outside));
    assert.equal(fs.statSync(file).mtimeMs, old.getTime(), "pruning preserves index idle age");
  }
  const later = path.join(root, "later");
  put(path.join(later, "jobs/job.json"), job);
  age(later);
  assert.equal(gcPluginState({ dataDir, now: now + DAY - 1 }).skipped, "daily");
  assert.ok(fs.existsSync(later));
  const calls = [];
  const spawn = (...args) => { calls.push(args); return { on() {}, unref() { calls.push("unref"); } }; };
  assert.equal(scheduleStateGc({ dataDir, now, spawn }), false);
  const stamp = path.join(root, ".gc");
  fs.utimesSync(stamp, old, old);
  const lock = `${stamp}.lock`;
  fs.writeFileSync(lock, String(process.pid));
  assert.equal(gcPluginState({ dataDir, now: now + DAY }).skipped, "locked");
  assert.ok(fs.existsSync(later));
  fs.writeFileSync(lock, "2147483647");
  assert.equal(scheduleStateGc({ dataDir, now: now + DAY, spawn }), true);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].stdio, "ignore");
  assert.equal(calls[1], "unref");
  assert.equal(gcPluginState({ dataDir, now: now + DAY }).summary.directories, 1, "dead sweep lock recovers");
  put(path.join(later, "jobs/job.json"), job);
  age(later);
  const failDelete = t.mock.method(fs, "rmSync", () => { throw new Error("fixture deletion failure"); });
  assert.throws(() => gcPluginState({ dataDir, now: now + 2 * DAY }), /fixture deletion failure/);
  failDelete.mock.restore();
  assert.equal(gcPluginState({ dataDir, now: now + 2 * DAY }).skipped, "daily", "failed sweeps also throttle");
  fs.rmSync(root, { recursive: true });
  fs.symlinkSync(outside, root);
  assert.equal(gcPluginState({ dataDir, now: now + 2 * DAY }).skipped, "unsafe-root");
  assert.ok(fs.existsSync(path.join(outside, "jobs/job.json")));
});
