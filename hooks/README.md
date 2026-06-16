# Mailbox delivery — Claude Code Stop hook

`mailbox-stop-hook.mjs` is a [Claude Code **Stop** hook](https://docs.claude.com/en/docs/claude-code/hooks)
that _pings_ an agent to drain its [agent-comm-system](../README.md) mailbox whenever it
finishes a turn. This is the portable half of the mailbox delivery layer — it needs no
daemon and works in any repo.

## How it works

1. On every Stop, Claude Code runs the hook with the hook payload on stdin.
2. The hook reads `AGENT_COMM_ID` (this agent's mailbox id) and peeks the mailbox via the
   one-shot CLI (`agent-comm-system peek <id>` — **non-destructive**).
3. If unread messages are waiting, it returns `{ "decision": "block", "reason": "..." }`,
   which keeps the agent going and tells it to drain the queue with the `receive_next` MCP
   tool. If the mailbox is empty (or unreadable, or no id is set), it allows the stop.
4. It is **loop-safe**: when a stop was already triggered by a hook-induced continuation
   (`stop_hook_active`), it does not block again.

Because the hook only peeks, the queue stays authoritative — the agent consumes messages
itself via `receive_next` / `ack`.

## Prerequisites

- `agent-comm-system` v2.2.0+ installed so the `agent-comm-system` CLI is on `PATH`
  (`npm install -g .` from the repo root), **or** set `AGENT_COMM_BIN` to a launcher
  (e.g. `"node /abs/path/to/dist/index.js"` — note: a multi-word command is not supported;
  prefer the global install).
- The same `agent-comm-system` MCP server configured for the agent (so it can call
  `receive_next` to drain).

## Configure

Set the agent's identity in its environment (per session / per agent):

```bash
export AGENT_COMM_ID="coder"
# optional overrides:
# export AGENT_COMM_BIN="agent-comm-system"
# export AGENT_COMM_STORAGE="$HOME/.agent-comm-system/messages"
```

Register the hook in `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/agent-comm-system/hooks/mailbox-stop-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

## Try it

```bash
# Leave a message for "coder", then simulate a Stop hook firing:
agent-comm-system  # (in an MCP client) send_message → to: "coder"
echo '{"stop_hook_active":false}' | AGENT_COMM_ID=coder node hooks/mailbox-stop-hook.mjs
# → {"decision":"block","reason":"📬 You have 1 unread mailbox message(s) ..."}

# With an empty mailbox it prints nothing and exits 0 (allows the stop).
```

## Notes & roadmap

- Delivery is at **turn boundaries** (when the agent would otherwise stop) — the natural,
  portable moment to drain a queue.
- For an **immediate** interrupt of a live session (rather than waiting for idle), a daemon
  such as chroxy can consume `AGENT_COMM_EMIT_WEBHOOK` (set on the sender) and inject a
  wakeup into the running session. That live-interrupt path is a separate, optional layer.
