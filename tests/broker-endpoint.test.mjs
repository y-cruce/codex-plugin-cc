import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { ensureBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { BROKER_READY_MS, isolateTestEnvironment, makeTempDir, run } from "./helpers.mjs";

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});

test("a broker that never binds is killed when the startup wait runs out", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const script = path.join(cwd, "silent-broker.mjs");
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const alive = () => run("pgrep", ["-f", script]).status === 0;
  t.after(() => run("pkill", ["-f", script]));
  assert.equal(await ensureBrokerSession(cwd, { scriptPath: script, timeoutMs: 500 }), null);
  const deadline = Date.now() + BROKER_READY_MS;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false, "the broker the wait gave up on is still running");
});

test("a broker that exits before binding fails promptly and keeps its log", async (t) => {
  isolateTestEnvironment(t);
  const cwd = makeTempDir();
  const script = path.join(cwd, "exiting-broker.mjs");
  const marker = "broker-start-diagnostics-exit-23";
  fs.writeFileSync(script, `console.error(${JSON.stringify(marker)}); process.exit(23);\n`);
  let sessionDir;
  let pid;
  const logFile = path.join(resolveStateDir(cwd), "broker-start-failure.log");
  await assert.rejects(ensureBrokerSession(cwd, {
    scriptPath: script,
    timeoutMs: BROKER_READY_MS,
    requireBroker: true,
    createBrokerEndpoint(dir) {
      sessionDir = dir;
      return createBrokerEndpoint(dir);
    },
    killProcess(processId) {
      pid = processId;
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }), (error) => {
    assert.match(error.message, /exited with code 23/);
    assert.ok(error.message.includes(`pid ${pid}`));
    assert.ok(error.message.includes(logFile));
    return true;
  });
  assert.ok(fs.readFileSync(logFile, "utf8").includes(marker));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(fs.existsSync(sessionDir), false);
});
