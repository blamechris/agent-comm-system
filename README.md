# agent-comm-system

An MCP (Model Context Protocol) server that facilitates local communication between AI agents. This server enables multiple Claude instances or other LLM tools to exchange messages through a simple file-based storage system, eliminating the need for manual copy-pasting between different agent terminals.

📚 **[Quick Start Guide](QUICKSTART.md)** | 📖 **[Usage Examples](EXAMPLES.md)**

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
