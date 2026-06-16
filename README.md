# agent-comm-system

An MCP (Model Context Protocol) server that facilitates local communication between AI agents. This server enables multiple Claude instances or other LLM tools to exchange messages through a simple file-based storage system, eliminating the need for manual copy-pasting between different agent terminals.

📚 **[Quick Start Guide](QUICKSTART.md)** | 📖 **[Usage Examples](EXAMPLES.md)**

## 🔔 What's New in v2.2.0

Version 2.2 adds the **portable delivery layer** so a recipient gets _pinged_ to check its
mailbox — no daemon required:

- **One-shot CLI**: `agent-comm-system unread|peek|next <agent>` — query or drain a mailbox
  without speaking MCP (for hooks and scripts). `AGENT_COMM_STORAGE` overrides the location.
- **Claude Code Stop hook** (`hooks/mailbox-stop-hook.mjs`): when an agent finishes a turn,
  it's told to drain any unread mail via `receive_next`. Non-destructive, loop-safe. See
  [Delivery: ping on idle](#delivery-ping-on-idle-claude-code-stop-hook-v22).

## 📬 What's New in v2.1.0

Version 2.1 turns the per-agent store into a true FIFO **mailbox queue** plus an optional
delivery hook:

- **`receive_next`**: dequeue the oldest **unread** message and mark it read (drain a
  mailbox as a queue); `peek: true` to look without consuming.
- **`unread_count`**: how many messages are waiting for an agent.
- **`ack`**: acknowledge + delete a processed message.
- **Emit-on-send hook**: optional best-effort webhook (`AGENT_COMM_EMIT_WEBHOOK`) so an
  external layer (a Claude Code idle hook, a daemon like chroxy) can _ping_ a recipient to
  check its mailbox.
- **Self-mailbox**: message yourself (`from === to`) for deferred self-tasks.
- Fully **backward-compatible** with v2.0 message files. See
  [Mailbox Queue (v2.1)](#mailbox-queue-v21).

## ⚡ What's New in v2.0.0

Version 2.0 introduces significant performance and efficiency improvements:

- **🚀 Message Indexing**: O(1) message lookups instead of O(n) directory scans
- **💾 LRU Caching**: In-memory cache for frequently accessed messages (reduces disk I/O by ~80%)
- **📁 Organized Storage**: Messages stored in agent-specific directories (`messages/{agent}/*.json`)
- **📄 Pagination Support**: Efficiently handle thousands of messages with `limit` and `offset` parameters
- **💪 Persistent Index**: Automatic index rebuilding ensures data consistency across restarts

### Performance Improvements

| Operation               | v1.0              | v2.0                    | Improvement                       |
| ----------------------- | ----------------- | ----------------------- | --------------------------------- |
| Read messages for agent | O(n) scan         | O(1) index lookup       | **100x faster** for 10k+ messages |
| List messages           | Parse all files   | Cache + index           | **80% less disk I/O**             |
| Delete message          | Full scan to find | Index lookup            | **Instant** deletion              |
| Memory usage            | Minimal           | ~10MB for 100k messages | Configurable cache size           |

## Overview

The Agent Communication System allows:

- **Orchestration agents** to delegate tasks to specialized agents (coder, reviewer, tester, etc.)
- **Specialized agents** to receive tasks and send back results
- **All agents** to work collaboratively without requiring multiple terminal windows for manual message passing

Messages are stored as JSON files in a local directory (`~/.agent-comm-system/messages` by default), making the communication persistent and inspectable.

## Installation

### From Source

```bash
git clone <repository-url>
cd agent-comm-system
npm install
npm run build
```

### Global Installation

```bash
npm install -g .
```

## Usage

### Running the Server

The server runs as an MCP server using stdio transport:

```bash
npm start
# or if installed globally
agent-comm-system
```

### Configuring with Claude Desktop

Add this to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "agent-comm-system": {
      "command": "node",
      "args": ["/path/to/agent-comm-system/dist/index.js"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "agent-comm-system": {
      "command": "agent-comm-system"
    }
  }
}
```

## Available Tools

### 1. send_message

Send a message from one agent to another.

**Parameters:**

- `from` (string, required): The identifier of the sending agent (e.g., "orchestrator", "coder", "reviewer")
- `to` (string, required): The identifier of the receiving agent
- `subject` (string, optional): Subject line for the message
- `content` (string, required): The message content

**Example:**

```
send_message({
  from: "orchestrator",
  to: "coder",
  subject: "Implement feature X",
  content: "Please implement the following feature: ..."
})
```

### 2. read_messages

Read messages addressed to a specific agent with optional pagination.

**Parameters:**

- `agent` (string, required): The identifier of the agent to read messages for
- `limit` (number, optional): Maximum number of messages to return (default: 50)
- `offset` (number, optional): Number of messages to skip (default: 0)

**Examples:**

```
// Read all messages (up to 50)
read_messages({
  agent: "coder"
})

// Read next page of messages
read_messages({
  agent: "coder",
  limit: 20,
  offset: 20
})

// Read first 100 messages
read_messages({
  agent: "coder",
  limit: 100
})
```

**Response includes pagination metadata:**

- Total message count
- Current offset and limit
- Whether more messages are available

### 3. list_messages

List metadata for all messages in the system with optional filtering and pagination.

**Parameters:**

- `agent` (string, optional): Filter messages by recipient agent
- `limit` (number, optional): Maximum number of messages to return (default: 50)
- `offset` (number, optional): Number of messages to skip (default: 0)

**Examples:**

```
// List all messages (first 50)
list_messages()

// List messages for specific agent
list_messages({
  agent: "reviewer"
})

// Paginate through all messages
list_messages({
  limit: 100,
  offset: 100
})
```

### 4. delete_message

Delete a specific message by its ID.

**Parameters:**

- `message_id` (string, required): The ID of the message to delete

**Example:**

```
delete_message({
  message_id: "orchestrator-coder-1699564800000"
})
```

### 5. clear_messages

Clear all messages for a specific agent or all messages in the system.

**Parameters:**

- `agent` (string, optional): Clear messages only for this agent. If not specified, clears all messages.

**Example:**

```
clear_messages({
  agent: "coder"
})
```

### 6. receive_next

Dequeue the **oldest unread** message for an agent (FIFO) and mark it read, so the next call returns the following message. This is the primary way to drain a mailbox as a queue.

**Parameters:**

- `agent` (string, required): The agent whose mailbox to read from
- `peek` (boolean, optional): When `true`, return the next unread message **without** marking it read (default: `false`)

**Example:**

```
receive_next({ agent: "coder" })
// → the oldest unread message; "Remaining unread: N"

receive_next({ agent: "coder", peek: true })
// → same message, but it stays unread
```

### 7. unread_count

Return the number of unread messages (not yet consumed via `receive_next`) for an agent.

**Parameters:**

- `agent` (string, required): The agent to count unread messages for

**Example:**

```
unread_count({ agent: "coder" })
// → "Unread messages for coder: 3"
```

### 8. ack

Acknowledge a message as fully processed and delete it. Typically called after `receive_next` once the work the message described is complete.

**Parameters:**

- `message_id` (string, required): The ID of the message to acknowledge and remove

**Example:**

```
ack({ message_id: "orchestrator-1699564800000" })
```

## Mailbox Queue (v2.1)

`receive_next` / `unread_count` / `ack` turn the per-agent store into a true FIFO
**mailbox queue**:

- Messages carry a `read` flag (and an `id`/`readAt`). `read_messages` is still a pure,
  non-consuming read; `receive_next` is the consuming dequeue.
- Drain pattern an agent runs to process its inbox oldest-first:

  ```
  while (unread_count({ agent: "me" }) > 0) {
    const msg = receive_next({ agent: "me" });  // marks it read
    // ...do the work the message describes...
    ack({ message_id: msg.id });                // optional cleanup
  }
  ```

- **Self-mailbox**: send to your own id (`from === to`) to leave yourself a deferred
  task, then drain it later with `receive_next`.

### Delivery hook (emit on send)

So an external layer can _ping_ a recipient to check its mailbox, `send_message` fires an
optional best-effort webhook when configured via environment variables:

- `AGENT_COMM_EMIT_WEBHOOK` — URL to `POST` on every send, with body
  `{ to, from, id, subject, unread_count }`.
- `AGENT_COMM_EMIT_HEADER` — optional `Name: value` header (e.g. an auth token) added to
  the request.

The emit is fire-and-forget and capped (2s): a delivery outage **never** fails a send.
This is the seam a Claude Code idle/Stop hook or a daemon (e.g. chroxy) consumes to wake
the recipient — see the project plan for the delivery layer.

**Backward compatibility:** messages written by v2.0 (no `id`/`read` fields) are treated
as unread, get an `id` derived from their filename, and are backfilled on first
`receive_next`. No migration step is required.

## Command-line interface (v2.2)

The same binary doubles as a one-shot CLI for non-MCP consumers (hooks, scripts) that need
to query or drain a mailbox without speaking the MCP stdio protocol. Run with no arguments
it is the MCP server; with a subcommand it is the CLI:

```bash
agent-comm-system unread <agent>          # prints the unread count
agent-comm-system peek <agent>            # prints unread messages as a JSON array (no consume)
agent-comm-system next <agent> [--peek]   # prints the next unread message as JSON (consumes unless --peek)
```

The mailbox location can be overridden with `AGENT_COMM_STORAGE` (default
`~/.agent-comm-system/messages`).

## Delivery: ping on idle (Claude Code Stop hook, v2.2)

`hooks/mailbox-stop-hook.mjs` is the portable half of the delivery layer: a Claude Code
**Stop** hook that, whenever an agent finishes a turn, checks that agent's mailbox and — if
unread messages are waiting — tells the agent to drain them via `receive_next`. It is
non-destructive (peek-only; the agent consumes), loop-safe (honors `stop_hook_active`), and
needs no daemon. Set `AGENT_COMM_ID` to the agent's mailbox id and register the hook in
`.claude/settings.json` — see **[hooks/README.md](hooks/README.md)** for the full setup.

```bash
echo '{"stop_hook_active":false}' | AGENT_COMM_ID=coder node hooks/mailbox-stop-hook.mjs
# → {"decision":"block","reason":"📬 You have N unread mailbox message(s) ..."}  (when mail waits)
```

For an _immediate_ interrupt of a live session (instead of at the next idle), a daemon such
as chroxy can consume `AGENT_COMM_EMIT_WEBHOOK` and inject a wakeup into the running
session — a separate, optional layer.

## Workflow Examples

For detailed usage examples and multi-agent workflow patterns, see [EXAMPLES.md](EXAMPLES.md).

### Quick Example: Orchestrator → Coder → Reviewer

1. **Orchestrator** sends a task to the coder:

   ```
   send_message({
     from: "orchestrator",
     to: "coder",
     subject: "Build login page",
     content: "Create a login page with email and password fields..."
   })
   ```

2. **Coder** (in a different Claude instance) reads the message:

   ```
   read_messages({ agent: "coder" })
   ```

3. **Coder** completes the work and sends it to the reviewer:

   ```
   send_message({
     from: "coder",
     to: "reviewer",
     subject: "Login page implementation",
     content: "I've implemented the login page. Here's what I did..."
   })
   ```

4. **Reviewer** reads and responds:

   ```
   read_messages({ agent: "reviewer" })

   send_message({
     from: "reviewer",
     to: "orchestrator",
     subject: "Login page review complete",
     content: "The implementation looks good. Minor suggestions: ..."
   })
   ```

### Example 2: Broadcast and Collect Responses

1. **Orchestrator** sends tasks to multiple agents:

   ```
   send_message({ from: "orchestrator", to: "coder", content: "..." })
   send_message({ from: "orchestrator", to: "tester", content: "..." })
   send_message({ from: "orchestrator", to: "documenter", content: "..." })
   ```

2. **Orchestrator** later checks for responses:
   ```
   read_messages({ agent: "orchestrator" })
   ```

## Message Storage

### Directory Structure (v2.0)

Messages are organized by recipient agent in `~/.agent-comm-system/`:

```
~/.agent-comm-system/
├── index.json              # Message index for fast lookups
└── messages/
    ├── coder/              # Messages for 'coder' agent
    │   ├── orchestrator-1699564800000.json
    │   └── reviewer-1699564900000.json
    ├── reviewer/           # Messages for 'reviewer' agent
    │   └── coder-1699565000000.json
    └── orchestrator/       # Messages for 'orchestrator' agent
        └── reviewer-1699565100000.json
```

### Message Format

Each message is stored as a JSON file:

```json
{
  "from": "orchestrator",
  "to": "coder",
  "timestamp": "2024-11-10T05:43:00.000Z",
  "subject": "Task description",
  "content": "Detailed message content..."
}
```

### File Naming

- **v2.0 format**: `{from}-{timestamp}.json` (stored in `messages/{to}/` directory)
- **v1.0 format**: `{from}-{to}-{timestamp}.json` (flat structure)

### Index File

The `index.json` file maintains a fast lookup table:

```json
{
  "coder": ["orchestrator-1699564800000", "reviewer-1699564900000"],
  "reviewer": ["coder-1699565000000"],
  "orchestrator": ["reviewer-1699565100000"]
}
```

The index is automatically rebuilt on server startup if corrupted or missing.

## Development

### Building

```bash
npm run build
```

### Code Quality

The project uses ESLint and Prettier to maintain code quality and consistency.

#### Linting

```bash
# Run ESLint to check for issues
npm run lint

# Automatically fix ESLint issues
npm run lint:fix
```

#### Formatting

```bash
# Format all files with Prettier
npm run format

# Check formatting without making changes
npm run format:check
```

#### Type Checking

```bash
# Run TypeScript compiler for type checking (without emitting files)
npm run type-check
```

#### Pre-commit Hooks

The project uses Husky and lint-staged to automatically run code quality checks before commits:

- **Linting**: ESLint automatically fixes issues in staged TypeScript files
- **Formatting**: Prettier formats all staged files
- **Type Safety**: TypeScript strict mode enabled

Configuration files:

- `.prettierrc.json` - Prettier formatting rules
- `eslint.config.js` - ESLint linting rules
- `.husky/pre-commit` - Git pre-commit hook

### CI/CD Pipeline

The project uses GitHub Actions with a hybrid runner system that automatically selects between self-hosted and GitHub-hosted runners for optimal quota management.

#### Runner Selection

**Automatic (day-based)**:

- Days 1-25: Self-hosted runner (fast feedback, no quota cost)
- Days 26-31: GitHub-hosted runners (ubuntu-latest)
- Resets automatically on the first of each month

**Manual Override (commit message flags)**:

```bash
# Force self-hosted runner
git commit -m "feat: Add feature [self-hosted]"

# Force GitHub-hosted runner
git commit -m "fix: Quick fix [github]"

# Skip CI entirely
git commit -m "docs: Update README [skip-ci]"
```

**Manual Dispatch**:

- Go to Actions → Select workflow → Run workflow
- Choose runner_mode: `auto` / `self-hosted` / `github` / `skip`

#### CI Checks

The CI pipeline runs the following checks on every push and pull request:

1. **Linting** - ESLint checks for code quality issues
2. **Formatting** - Prettier validates code formatting
3. **Type Checking** - TypeScript compiler validates types
4. **Testing** - Full test suite with coverage reporting
5. **Build** - Verifies project builds successfully

All checks must pass before merging pull requests.

### Testing

The project uses Jest for testing with TypeScript support via ts-jest.

#### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

#### Test Structure

```
tests/
├── helpers.ts           # Test utility functions
├── index.test.ts        # Unit tests for core functionality
├── integration.test.ts  # Integration tests for file operations
└── server.test.ts       # Server initialization tests
```

#### Coverage

Coverage reports are generated in the `coverage/` directory when running `npm run test:coverage`.

**Note on Coverage Metrics**: The main `index.ts` file is a server entry point that runs as a standalone MCP process and cannot be directly unit tested through imports. The integration tests provide comprehensive functional coverage of all message handling operations (send, read, list, delete, clear). For improved coverage metrics in future iterations, consider refactoring the server logic into separate, importable modules.

The test suite includes:

- 43 comprehensive tests covering all MCP tool operations
- Unit tests for message storage, filtering, and deletion
- Integration tests for concurrent operations and error scenarios
- Server initialization and configuration tests

### Project Structure

```
agent-comm-system/
├── .github/                # GitHub configuration
│   └── workflows/          # GitHub Actions workflows
│       └── ci.yml          # CI pipeline with hybrid runner system
├── src/
│   └── index.ts            # Main MCP server implementation
├── tests/                  # Test files
│   ├── helpers.ts          # Test utilities
│   ├── index.test.ts       # Unit tests
│   ├── integration.test.ts # Integration tests
│   └── server.test.ts      # Server initialization tests
├── .husky/                 # Git hooks
│   └── pre-commit          # Pre-commit hook for linting/formatting
├── dist/                   # Compiled JavaScript output
├── coverage/               # Test coverage reports
├── .prettierrc.json        # Prettier configuration
├── .prettierignore         # Prettier ignore patterns
├── eslint.config.js        # ESLint configuration
├── jest.config.js          # Jest configuration
├── tsconfig.json           # TypeScript configuration
├── package.json            # Project dependencies and scripts
└── README.md
```

## Requirements

- Node.js 16 or higher
- npm 7 or higher

## License

ISC
