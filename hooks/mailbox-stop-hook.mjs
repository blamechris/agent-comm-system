#!/usr/bin/env node
/**
 * Claude Code "Stop" hook — pings the agent to drain its agent-comm-system mailbox.
 *
 * When a Claude Code agent finishes a turn, this hook checks the mailbox for the
 * agent named by AGENT_COMM_ID. If unread messages are waiting, it blocks the
 * stop and tells the agent to drain them via the `receive_next` MCP tool. It is
 * NON-DESTRUCTIVE: it only peeks (the agent consumes via receive_next), and it
 * is loop-safe via the `stop_hook_active` guard.
 *
 * Configure (per agent / session):
 *   AGENT_COMM_ID    required — this agent's mailbox id (e.g. "coder")
 *   AGENT_COMM_BIN   optional — command to invoke the CLI (default: "agent-comm-system")
 *   AGENT_COMM_STORAGE optional — mailbox dir override (default ~/.agent-comm-system/messages)
 *
 * Register it in .claude/settings.json — see hooks/README.md.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf-8") || "{}");
  } catch {
    return {};
  }
}

function allow() {
  // Exit 0 with no output → let the agent stop normally.
  process.exit(0);
}

const input = readHookInput();

// Loop guard: if this stop was already triggered by a hook-induced continuation,
// don't block again (prevents an infinite stop→block→stop cycle).
if (input.stop_hook_active) {
  allow();
}

const agent = process.env.AGENT_COMM_ID;
if (!agent) {
  // No identity configured — nothing to check.
  allow();
}

const bin = process.env.AGENT_COMM_BIN || "agent-comm-system";
const result = spawnSync(bin, ["peek", agent], { encoding: "utf-8" });

if (result.status !== 0 || !result.stdout) {
  // Mailbox CLI unavailable — never block the agent on our account.
  allow();
}

let unread = [];
try {
  unread = JSON.parse(result.stdout.trim() || "[]");
} catch {
  allow();
}

if (!Array.isArray(unread) || unread.length === 0) {
  allow();
}

const preview = unread
  .slice(0, 5)
  .map((m, i) => `  ${i + 1}. from ${m.from}${m.subject ? ` — ${m.subject}` : ""}`)
  .join("\n");
const more = unread.length > 5 ? `\n  …and ${unread.length - 5} more` : "";

const reason =
  `📬 You have ${unread.length} unread mailbox message(s) for agent "${agent}".\n` +
  `Process them now: call the agent-comm-system MCP tool ` +
  `receive_next({ agent: "${agent}" }) repeatedly until it reports no unread, ` +
  `acting on each message, then ack({ message_id }) once a message is handled.\n\n` +
  `Waiting:\n${preview}${more}`;

// Block the stop and feed `reason` back to the model so it continues and drains.
console.log(JSON.stringify({ decision: "block", reason }));
process.exit(0);
