# agent-comm-system

An MCP (Model Context Protocol) server that facilitates local communication between AI agents. This server enables multiple Claude instances or other LLM tools to exchange messages through a simple file-based storage system, eliminating the need for manual copy-pasting between different agent terminals.

📚 **[Quick Start Guide](QUICKSTART.md)** | 📖 **[Usage Examples](EXAMPLES.md)**

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

Read all messages addressed to a specific agent.

**Parameters:**
- `agent` (string, required): The identifier of the agent to read messages for

**Example:**
```
read_messages({
  agent: "coder"
})
```

### 3. list_messages

List metadata for all messages in the system, optionally filtered by recipient.

**Parameters:**
- `agent` (string, optional): Filter messages by recipient agent

**Example:**
```
list_messages({
  agent: "reviewer"
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

Messages are stored in `~/.agent-comm-system/messages/` as JSON files with the format:

```json
{
  "from": "orchestrator",
  "to": "coder",
  "timestamp": "2024-11-10T05:43:00.000Z",
  "subject": "Task description",
  "content": "Detailed message content..."
}
```

Each message file is named: `{from}-{to}-{timestamp}.json`

## Development

### Building

```bash
npm run build
```

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
├── src/
│   └── index.ts          # Main MCP server implementation
├── tests/                # Test files
│   ├── helpers.ts        # Test utilities
│   ├── index.test.ts     # Unit tests
│   ├── integration.test.ts # Integration tests
│   └── server.test.ts    # Server initialization tests
├── dist/                 # Compiled JavaScript output
├── coverage/             # Test coverage reports
├── package.json
├── tsconfig.json
├── jest.config.js
└── README.md
```

## Requirements

- Node.js 16 or higher
- npm 7 or higher

## License

ISC

