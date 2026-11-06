import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeActivity } from "../plugins/codex/scripts/activity-summary.mjs";

const HELPER = fileURLToPath(new URL("../plugins/codex/scripts/activity-summary.mjs", import.meta.url));
const INPUT = { task: "验证任务面板", notes: "读取面板代码\n运行相关测试", previousSummary: "正在定位任务面板的更新路径" };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activity-summary-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const command = path.join(directory, "qoder");
  const recording = path.join(directory, "record.json");
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const mode = process.argv[2];
process.on("SIGTERM", () => {});
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(recording)}, JSON.stringify({
    pid: process.pid, at: Date.now(), cwd: process.cwd(), args: process.argv.slice(2), input,
    proxy: Object.fromEntries(Object.entries(process.env).filter(([key]) => /proxy/i.test(key)))
  }));
  if (mode === "missing") return process.exit(0);
  if (mode === "malformed") { process.stdout.write("not-json\\n"); return; }
  const result = mode === "error" ? { type: "result", subtype: "error", is_error: true, result: "PRIVATE_BACKEND_CONTENT" }
    : { type: "result", subtype: "success", is_error: false,
      result: mode === "multiline" ? "第一行\\n第二行" : mode === "empty" ? " " : mode === "long" ? "测".repeat(61)
        : mode === "boundary" ? "测".repeat(56) + "a ！😀" : "正在验证任务面板的测试结果" };
  process.stderr.write("PRIVATE_BACKEND_CONTENT");
  const output = JSON.stringify(result) + "\\n";
  process.stdout.write('{"type":"assistant","message":"partial"}\\n' + output.slice(0, 20));
  setTimeout(() => process.stdout.write(output.slice(20)), 5);
  setInterval(() => {}, 1000);
});
`, { mode: 0o755 });
  return { directory, command, read: () => JSON.parse(fs.readFileSync(recording, "utf8")) };
}

function assertStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("CLI fixes Qoder configuration, sends stdin directly and stops after its final result", async (t) => {
  const fake = fixture(t);
  const child = spawn(process.execPath, [HELPER], {
    env: { ...process.env, PATH: `${fake.directory}${path.delimiter}${process.env.PATH}`,
      HTTPS_PROXY: "test-proxy", ACTIVITY_PROXY_TEST: "test-proxy" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(INPUT));
  const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '{"summary":"正在验证任务面板的测试结果"}\n');
  assert.equal(stderr, "");
  const record = fake.read();
  assert.ok(Date.now() - record.at < 2000, "a final result must not wait for Qoder to exit naturally");
  assert.deepEqual(JSON.parse(record.input), INPUT);
  assert.deepEqual(record.proxy, { NO_PROXY: "*", no_proxy: "*" });
  assert.deepEqual(record.args.slice(0, 6), ["-p", "--model", "dfmodel", "--thinking", "disabled", "--system-prompt"]);
  assert.match(record.args[6], /12 至 30 个字符/);
  assert.deepEqual(record.args.slice(7), ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "user", "--max-output-tokens", "512", "--max-model-request-retries", "0",
    "--no-session-persistence", "--output-format", "stream-json", "--include-partial-messages"]);
  assert.equal(fs.existsSync(record.cwd), false, "the neutral working directory is removed");
  assertStopped(record.pid);
});

test("accepts a 60-character summary including English, spaces and punctuation", async (t) => {
  const fake = fixture(t);
  assert.equal(await summarizeActivity(INPUT, { command: fake.command, args: ["boundary"] }), "测".repeat(56) + "a ！😀");
  assertStopped(fake.read().pid);
});

test("invalid or failed stream results produce safe failures", async (t) => {
  const fake = fixture(t);
  for (const mode of ["malformed", "error", "multiline", "empty", "long", "missing"]) {
    await assert.rejects(summarizeActivity(INPUT, { command: fake.command, args: [mode] }), (error) => {
      assert.match(error.message, /^Activity summary /);
      assert.doesNotMatch(error.message, /PRIVATE_BACKEND_CONTENT/);
      return true;
    });
    assertStopped(fake.read().pid);
  }
  await assert.rejects(summarizeActivity(INPUT, { command: path.join(fake.directory, "absent") }), /could not start/);
});

test("timeout terminates the helper's own unresponsive child", async (t) => {
  const fake = fixture(t);
  const pidFile = path.join(fake.directory, "timeout.pid");
  await assert.rejects(summarizeActivity(INPUT, { command: "/bin/sh", args: ["-c",
    'trap "" TERM; printf %s "$$" > "$1"; while :; do :; done', "timeout", pidFile], timeoutMs: 500 }), /timed out/);
  assertStopped(Number(fs.readFileSync(pidFile, "utf8")));
});
