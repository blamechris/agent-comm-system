# Agent Communication System - Usage Examples

This document provides practical examples of using the Agent Communication System.

## Scenario 1: Orchestrator Coordinating Development Tasks

### Step 1: Orchestrator sends tasks to specialized agents

**Orchestrator Agent (Terminal 1):**

```
Use the send_message tool:
- from: "orchestrator"
- to: "coder"
- subject: "Implement user authentication"
- content: "Create a user authentication system with login, logout, and session management."

Use the send_message tool:
- from: "orchestrator"
- to: "tester"
- subject: "Prepare test plan"
- content: "Create a test plan for the user authentication system. Include unit tests and integration tests."
```

### Step 2: Coder receives and works on the task

**Coder Agent (Terminal 2):**

```
Use the read_messages tool:
- agent: "coder"

# Output shows: "Implement user authentication" task

# ... Coder does the work ...

Use the send_message tool:
- from: "coder"
- to: "reviewer"
- subject: "Authentication code ready for review"
- content: "I've implemented the authentication system. Files changed: auth.ts, login.tsx, session.ts. Please review for security issues and code quality."
```

### Step 3: Reviewer checks the work

**Reviewer Agent (Terminal 3):**

```
Use the read_messages tool:
- agent: "reviewer"

# Output shows: "Authentication code ready for review"

# ... Reviewer checks the code ...

Use the send_message tool:
- from: "reviewer"
- to: "coder"
- subject: "Review feedback on authentication"
- content: "Great work! Found 2 minor issues: 1) Session timeout should be configurable, 2) Add rate limiting to login endpoint."

Use the send_message tool:
- from: "reviewer"
- to: "orchestrator"
- subject: "Authentication review complete"
- content: "Review done. 2 minor issues found and communicated to coder. Overall implementation is solid."
```

## Scenario 2: Parallel Task Execution

### Orchestrator delegates multiple independent tasks

**Orchestrator:**

```
# Send multiple messages
send_message(from: "orchestrator", to: "frontend-dev", content: "Build user profile page")
send_message(from: "orchestrator", to: "backend-dev", content: "Create user profile API")
send_message(from: "orchestrator", to: "designer", content: "Design user profile mockups")

# Check for responses later
list_messages(agent: "orchestrator")
read_messages(agent: "orchestrator")
```

## Scenario 3: Status Updates and Progress Tracking

### Agents report progress back to orchestrator

**Any Agent:**

```
send_message(
  from: "database-admin",
  to: "orchestrator",
  subject: "Database migration status",
  content: "Migration 50% complete. Estimated 10 minutes remaining. No errors encountered."
)
```

**Orchestrator checks all updates:**

```
read_messages(agent: "orchestrator")
# Shows all progress updates from various agents
```

## Scenario 4: Cleanup and Message Management

### List messages before cleanup

```
list_messages()
# Shows all message IDs and metadata
```

### Delete specific message

```
delete_message(message_id: "orchestrator-coder-1699564800000")
```

### Clear messages for specific agent

```
clear_messages(agent: "coder")
# Removes all messages addressed to "coder"
```

### Clear all messages

```
clear_messages()
# Removes all messages from the system
```

## Best Practices

1. **Use descriptive agent names**: Instead of "agent1", use "coder", "reviewer", "orchestrator", etc.

2. **Include subject lines**: Makes it easier to identify messages when listing them.

3. **Be specific in content**: Provide enough context so the receiving agent understands the task without needing additional information.

4. **Clean up regularly**: Use `clear_messages` to remove completed tasks and keep the system organized.

5. **Check for responses**: Orchestrator should regularly check for responses using `read_messages`.

6. **Use list_messages for overview**: Before reading full message content, use `list_messages` to see what's available.

## Multi-Agent Workflows

### Research → Write → Review → Publish Pipeline

1. **Researcher** → sends findings to **Writer**
2. **Writer** → sends draft to **Editor**
3. **Editor** → sends feedback to **Writer**
4. **Writer** → sends final version to **Publisher**
5. **Publisher** → confirms publication to **Project Manager**

Each agent only needs to know their immediate upstream and downstream agents!

### Parallel Processing with Aggregation

1. **Orchestrator** → sends same task to multiple agents (A, B, C)
2. **Agents A, B, C** → all send results back to **Orchestrator**
3. **Orchestrator** → aggregates results and makes decision
4. **Orchestrator** → sends final decision to **Executor**

This enables true parallel processing without terminal juggling!

## Scenario 5: Draining a mailbox as a FIFO queue (v2.1)

Instead of re-reading the whole inbox, an agent consumes messages oldest-first:

```
// Coder, on waking up, processes everything waiting for it:
unread_count({ agent: "coder" })
// → "Unread messages for coder: 2"

receive_next({ agent: "coder" })
// → oldest unread (e.g. "Implement login page"); now marked read
//   "Remaining unread: 1"

// ...do the work...
ack({ message_id: "orchestrator-1699564800000" })   // optional cleanup

receive_next({ agent: "coder" })
// → next oldest ("Add tests"); "Remaining unread: 0"

receive_next({ agent: "coder" })
// → "No unread messages for agent: coder"
```

`receive_next({ agent: "coder", peek: true })` shows the next message without consuming it.

### Self-mailbox (deferred self-tasks)

An agent can leave itself a note to pick up later — useful for long jobs that span turns:

```
send_message({ from: "coder", to: "coder", subject: "resume", content: "After CI: cut the release tag" })
// ...later...
receive_next({ agent: "coder" })   // → "After CI: cut the release tag"
```

### Pinging a recipient on send (delivery hook)

Run the server with `AGENT_COMM_EMIT_WEBHOOK` set so every send notifies an external
delivery layer (a Claude Code idle hook, or a daemon like chroxy) that can wake the
recipient to drain its queue:

```
AGENT_COMM_EMIT_WEBHOOK="https://my-daemon.local/mailbox" \
AGENT_COMM_EMIT_HEADER="Authorization: Bearer <token>" \
  agent-comm-system

# every send_message then fires (best-effort, never blocks the send):
# POST { to, from, id, subject, unread_count }
```
