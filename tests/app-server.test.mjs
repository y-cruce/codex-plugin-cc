import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { isolateTestEnvironment, makeTempDir, waitFor, within } from "./helpers.mjs";

test("app-server preserves Unicode separators in JSONL responses and notifications", async (t) => {
  isolateTestEnvironment(t);
  const bin = makeTempDir();
  installFakeCodex(bin, "unicode-separators");
  const client = await CodexAppServerClient.connect(bin, { disableBroker: true, env: buildEnv(bin) });
  t.after(() => client.close());
  const notifications = [];
  client.setNotificationHandler((message) => notifications.push(message));

  const { thread } = await within(client.request("thread/start", { cwd: bin }), 1000, "Unicode response");
  const expected = "before\u2028between\u2029after";
  assert.equal(thread.name, expected);
  await waitFor(() => notifications.length, "Unicode notification", 1000);
  assert.equal(notifications[0].params.thread.name, expected);
  const result = await within(client.request("thread/list", {}), 1000, "request after Unicode message");
  assert.equal(result.data[0].name, expected);
});

test("failed app-server connections reject pending and later requests", async (t) => {
  isolateTestEnvironment(t);
  const bin = makeTempDir();
  installFakeCodex(bin);
  for (const failure of ["protocol", "exit"]) {
    const client = await CodexAppServerClient.connect(bin, { disableBroker: true, env: buildEnv(bin) });
    t.after(() => client.close());
    const sent = [];
    t.mock.method(client, "sendMessage", (message) => sent.push(message));
    const pending = Promise.allSettled([
      client.request("thread/list", {}), client.request("account/read", {})
    ]);
    if (failure === "protocol") client.handleChunk("{invalid JSON}\n");
    else client.proc.stdin.end();
    const expected = failure === "protocol" ? /Failed to parse codex app-server JSONL/ : /connection closed/;
    for (const result of await within(pending, 1000, `${failure} pending requests`)) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, expected);
    }
    await assert.rejects(within(Promise.resolve().then(() => client.request("thread/list", {})),
      1000, `${failure} later request`), expected);
    assert.equal(client.pending.size, 0);
    assert.equal(sent.length, 2);
    await client.close();
  }
});
