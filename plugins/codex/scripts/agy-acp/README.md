# Official agy ACP steering extension

This local extension runs the installed official `agy_acp_server.par` and
`localharness_external` from `~/.local/share/antigravity-acp/1.4.4/`.
It adds `_session/steering` to the ACP connection using the official SDK's
`send_trigger_notification` transport: an `automatedTrigger` JSON message on
the existing harness WebSocket.

```sh
# Run from the plugin repository root.
npm ci --ignore-scripts
node plugins/codex/scripts/agy-acp/acp-proxy.mjs
# Or select it for director dispatches from this checkout:
export CODEX_DIRECTOR_ANTIGRAVITY_COMMAND="$PWD/plugins/codex/scripts/agy-acp/acp-proxy.mjs"
```

The default is `gemini-4-argon` with high thinking (`gemini-4-argon-high` in
the official runtime's combined model form). The proxy passes the launcher's proxy
environment to the official ACP server and its helper. OAuth, account, quota,
settings and the official binaries are used in place. No global installation or
launcher modification is performed by these commands.

For this machine's mihomo mixed port, set these in the ACP launcher before its
`exec` line. Set both casings so an inherited value cannot select a different
proxy; bypass only loopback traffic used by the local ACP harness and OAuth
callback:

```sh
export HTTP_PROXY="http://127.0.0.1:7890" HTTPS_PROXY="http://127.0.0.1:7890"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY"
export ALL_PROXY="$HTTP_PROXY" all_proxy="$HTTP_PROXY"
export NO_PROXY="localhost,127.0.0.1,::1,[::1]"
export no_proxy="$NO_PROXY"
```

The local `~/.local/share/antigravity-acp/1.4.4/launch.sh` uses this configuration.
The official personal-account ACP client uses Python `urllib` for CCPA requests,
which reads these proxy variables. `sandboxProxy` configures sandboxed terminal
commands in the CLI; it is not the ACP server's outbound proxy setting.

This adapter reports lowercase `clientInfo.name: "zed"` to the official server
on initialize, preserving the client's other fields and capabilities. Official
ACP 1.4.4 filters third-party models by client surface; `zed` is on that list.
This is an explicit compatibility identity choice, not a separate Zed process.
The model catalog and selection are still validated by the official server for
the signed-in account. The default model is Gemini 4 Argon with high thinking.

Plugin 1.4.103 includes both proxy scripts under `scripts/agy-acp/` and their
runtime dependency. An installed plugin's `scripts/agy-acp/acp-proxy.mjs` can
also be used as the executor command. Selecting the proxy requires the existing
official 1.4.4 runtime; the stock server alone does not advertise steering.

On the development machine, `~/.local/bin/agy_acp_server.par` resolves to the
existing 1.4.4 `launch.sh`, which starts this checkout's proxy. Keep the checkout
in place while that launcher is installed. To restore direct official-server
launch after this local installation:

```sh
cp "$HOME/.local/share/antigravity-acp/1.4.4/launch.sh.before-steering" \
   "$HOME/.local/share/antigravity-acp/1.4.4/launch.sh"
```

The extension advertises top-level `_meta.steering.supported:true` for the
verified official 1.4.4 server. `_session/steering` accepts nonempty text content
blocks. It returns `{outcome:"injected",accepted:true}` after a same-session
active harness WebSocket write succeeds. This confirms the injection write;
there is no separate per-message model-consumption acknowledgment. When no ACP
prompt is running, it returns `{outcome:"promptRequired",reason:"noRunningTurn"}`
without sending a trigger.

The helper proxy passes the length-prefixed InputConfig through unchanged and
changes only the OutputConfig port. Its API key remains opaque in memory. It
passes existing WebSocket frames through and inserts steering on that same
connection. It does not send a second ACP prompt or a halt/cancel for steering.
The proxy completes its WebSocket handshake after the original helper connects,
so the official SDK's startup connection retry window remains effective.

Validation: one isolated official Argon High prompt ran `sleep 7`; an automated
trigger sent during execution changed the answer to its unique marker before
the original ACP prompt returned `end_turn`. The helper exited normally.
Offline tests cover config preservation, framing, the root-response idle
boundary observed in that run, capability advertisement, and a helper that
starts listening 400 milliseconds after publishing its configuration.

`AGY_OFFICIAL_RUNTIME_DIR` may specify the existing runtime directory.
`AGY_STEERING_EVIDENCE` optionally records selected transport events for a local
test; it is off by default. The helper script must be executable.
