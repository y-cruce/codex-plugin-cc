import test from "node:test";
import assert from "node:assert/strict";
import { directorTools, dispatchInput, registerDirectorTools, startDirectorTools } from "../plugins/codex/hooks/director-tools/register.ts";

const WORKER = "/home/test/.claude/skills/code-director/scripts/dispatch.sh";
const COMPANION = "/plugin/scripts/codex-companion.mjs";

function harness({ files = [WORKER, COMPANION, "/repo"], exitCode = 0, stdout = "STATUS: started\nJOB: task-a-b\n", stderr = "" } = {}) {
  const hooks = new Map();
  const on = (event, matcher, hook) => hooks.set(`${event}:${matcher.tool}`, hook);
  const registered = [];
  const runs = [];
  const writes = new Map();
  const exists = new Set(files);
  const $ = {
    plugin: { name: "codex", root: "/plugin" },
    env: { get: async (name) => ({ HOME: "/home/test", TMPDIR: "/tmp/" })[name] },
    fs: { exists: async (path) => exists.has(path), write: async (path, text) => { writes.set(path, text); } },
    session: { id: async () => "session-1" },
    clock: { now: async () => 1000 },
    tool: { register: async (spec) => { registered.push(spec); return { tool: `mcp__codex__${spec.name}` }; } },
    process: { run: async (argv, init) => { runs.push({ argv, init }); return { exitCode, stdout, stderr }; } },
    ui: { log: () => {} },
  };
  const tools = directorTools();
  registerDirectorTools(on, tools);
  const call = (name, input) => hooks.get(`tool.call:mcp__codex__${name}`)($, { tool: `mcp__codex__${name}`, ...input }, () => assert.fail("next must not run"));
  return { $, tools, hooks, registered, runs, writes, call };
}

test("dispatchInput writes the headers dispatch.sh reads, then the brief", () => {
  assert.equal(
    dispatchInput({ brief: "Find it.", cwd: "/repo", name: "locate x", mode: "continue", thread: "t-1", write: true, executor: "codex" }),
    "MODE: continue\nNAME: locate x\nCWD: /repo\nTHREAD: t-1\nWRITE: yes\nEXECUTOR: codex\n\nFind it.\n",
  );
  assert.equal(dispatchInput({ mode: "investigate", name: "n", cwd: "/r", brief: "b\n", write: false, base: "" }), "MODE: investigate\nNAME: n\nCWD: /r\n\nb\n");
});

test("dispatchInput refuses a header value that would start another header, and an empty brief", () => {
  assert.throws(() => dispatchInput({ mode: "investigate", name: "a\nMODE: implement", cwd: "/r", brief: "b" }), /name must be one line/);
  assert.throws(() => dispatchInput({ mode: "investigate", name: "a", cwd: "/r", brief: "  \n" }), /brief is empty/);
});

test("the tools are registered in the prompt's tool list only where dispatch.sh is installed", async () => {
  const installed = harness();
  await startDirectorTools(installed.$, installed.tools);
  assert.deepEqual(installed.registered.map((spec) => spec.name), ["dispatch", "message", "answer", "result", "status"]);
  assert.ok(installed.registered.every((spec) => spec.isDeferred === false));
  assert.deepEqual(installed.tools.context, { worker: WORKER, companion: COMPANION, tmp: "/tmp" });

  const missing = harness({ files: [COMPANION] });
  await startDirectorTools(missing.$, missing.tools);
  assert.deepEqual(missing.registered, []);
  assert.deepEqual(await missing.call("dispatch", {}), { deny: "the code-director skill is not installed, so there is no dispatch.sh to run" });
});

test("dispatch runs dispatch.sh with the brief on stdin and the plugin's own companion", async () => {
  const h = harness();
  await startDirectorTools(h.$, h.tools);
  const answer = await h.call("dispatch", { mode: "investigate", name: "locate x", cwd: "/repo", brief: "Find it." });
  assert.deepEqual(answer, { result: "STATUS: started\nJOB: task-a-b" });
  assert.equal(h.runs.length, 1);
  const [{ argv, init }] = h.runs;
  assert.deepEqual(argv, ["bash", WORKER, "dispatch"]);
  assert.equal(init.cwd, "/repo");
  assert.equal(init.stdin, "MODE: investigate\nNAME: locate x\nCWD: /repo\n\nFind it.\n");
  assert.deepEqual(init.env, { CODEX_COMPANION: COMPANION, CODEX_COMPANION_SESSION_ID: "session-1" });
  assert.equal(h.tools.pending, true, "the pane is told to rescan");
});

test("a failed dispatch reaches the model as an error and does not ask the pane to rescan", async () => {
  const h = harness({ exitCode: 1, stdout: "NAME_REQUIRED: add a NAME: header\n" });
  await startDirectorTools(h.$, h.tools);
  assert.deepEqual(await h.call("dispatch", { mode: "investigate", name: "x", cwd: "/repo", brief: "b" }), { deny: "NAME_REQUIRED: add a NAME: header" });
  assert.equal(h.tools.pending, false);
  assert.deepEqual(await h.call("dispatch", { mode: "investigate", name: "x", cwd: "relative", brief: "b" }), { deny: "cwd must be an absolute path" });
  assert.deepEqual(await h.call("dispatch", { mode: "investigate", name: "x", cwd: "/gone", brief: "b" }), { deny: "cwd does not exist: /gone" });
  assert.equal(h.runs.length, 1);
});

test("message writes the correction to a file and passes the delivery as dispatch.sh's flag", async () => {
  const h = harness({ stdout: "MESSAGED job=task-a-b queued=task-c-d\n" });
  await startDirectorTools(h.$, h.tools);
  for (const [delivery, flags] of [["queue", ["--queue"]], ["steer", []], ["interrupt", ["--interrupt"]]]) {
    h.runs.length = 0;
    await h.call("message", { job: "task-a-b", cwd: "/repo", text: "Stop editing tests.", delivery });
    const [{ argv }] = h.runs;
    assert.deepEqual(argv.slice(0, 3), ["bash", WORKER, "message"]);
    assert.deepEqual(argv.slice(5), ["--cwd", "/repo", ...flags]);
    assert.equal(h.writes.get(argv[4]), "Stop editing tests.");
    assert.match(argv[4], /^\/tmp\/codex-director-session-1-1000-\d+\.md$/);
    assert.deepEqual(h.runs[1].argv, ["rm", "-f", argv[4]], "the file is removed once dispatch.sh has read it");
  }
  assert.deepEqual(await h.call("message", { job: "j", cwd: "/repo", text: "x", delivery: "now" }), { deny: "delivery must be queue, steer or interrupt" });
});

test("answer writes the answers map as JSON for dispatch.sh answer", async () => {
  const h = harness({ stdout: "ANSWERED job=j request=0\n" });
  await startDirectorTools(h.$, h.tools);
  const answers = { q1: { answers: ["yes"] } };
  assert.deepEqual(await h.call("answer", { job: "j", cwd: "/repo", request: "0", answers }), { result: "ANSWERED job=j request=0" });
  const [{ argv }] = h.runs;
  assert.deepEqual([argv[2], argv[3], argv[4]], ["answer", "j", "0"]);
  assert.deepEqual(JSON.parse(h.writes.get(argv[5])), answers);
  assert.deepEqual(await h.call("answer", { job: "j", cwd: "/repo", request: "0", answers: [] }), { deny: "answers must be an object keyed by question id" });
});

test("result and status run the plugin's companion directly", async () => {
  const h = harness({ stdout: "{}\n" });
  await startDirectorTools(h.$, h.tools);
  await h.call("result", { job: "j", cwd: "/repo" });
  await h.call("status", { job: "j", cwd: "/repo" });
  await h.call("status", { cwd: "/repo" });
  assert.deepEqual(h.runs.map((run) => run.argv), [
    ["node", COMPANION, "result", "j", "--cwd", "/repo"],
    ["node", COMPANION, "status", "j", "--cwd", "/repo", "--json"],
    ["node", COMPANION, "status", "--cwd", "/repo", "--json"],
  ]);
});
