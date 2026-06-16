# Quick Start Guide

Get started with the Agent Communication System in under 5 minutes!

## Installation

```bash
# Clone the repository
git clone https://github.com/blamechris/agent-comm-system.git
cd agent-comm-system

# Install dependencies
npm install

# Build the project
npm run build
```

## Configure Claude Desktop

1. Open your Claude Desktop configuration file:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

2. Add the server configuration:

```json
{
  "mcpServers": {
    "agent-comm-system": {
      "command": "node",
      "args": ["/absolute/path/to/agent-comm-system/dist/index.js"]
    }
  }
}
```

3. Replace `/absolute/path/to/agent-comm-system` with your actual path

4. Restart Claude Desktop

## Verify Installation

After restarting Claude Desktop, you should see the agent communication tools available. Ask Claude:

> "What tools do you have available?"

You should see 5 tools:

- `send_message`
- `read_messages`
- `list_messages`
- `delete_message`
- `clear_messages`

## Your First Message

Try sending a message:

> "Use send_message to send a message from 'orchestrator' to 'coder' with the subject 'Test' and content 'Hello from the orchestrator!'"

Then in a different Claude instance (or the same one), read the message:

> "Use read_messages to read messages for 'coder'"

## What's Next?

- Read [EXAMPLES.md](EXAMPLES.md) for real-world workflow patterns
- Check [README.md](README.md) for detailed documentation
- Experiment with multi-agent workflows!

## Troubleshooting

### "Tools not showing up"

- Make sure you restarted Claude Desktop after configuration
- Verify the path in your config is absolute and correct
- Check that the build completed successfully (`npm run build`)

### "Cannot find module"

- Ensure you ran `npm install` and `npm run build`
- Check that `dist/index.js` exists

### "Permission denied"

- Make sure the dist/index.js file is executable: `chmod +x dist/index.js`

## Mailbox queue (v2.1)

Drain your inbox oldest-first instead of re-reading everything:

```
unread_count({ agent: "coder" })          // how many are waiting
receive_next({ agent: "coder" })          // dequeue the oldest UNREAD (marks it read)
ack({ message_id: "<id from receive_next>" })  // optional: delete once handled
```

Repeat `receive_next` until it reports "No unread messages". Use
`receive_next({ agent, peek: true })` to look without consuming. Send to your own id to
leave yourself a deferred task.

**Ping on send (optional):** set `AGENT_COMM_EMIT_WEBHOOK` (and optionally
`AGENT_COMM_EMIT_HEADER: "Name: value"`) and every send fires a best-effort
`POST { to, from, id, subject, unread_count }` so an external layer can wake the recipient.

## Support

For issues or questions, please open an issue on GitHub.
