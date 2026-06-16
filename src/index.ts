#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Default storage directory
const DEFAULT_STORAGE_DIR = path.join(os.homedir(), ".agent-comm-system", "messages");
const INDEX_FILE = "index.json";
const DEFAULT_CACHE_SIZE = 100;
const DEFAULT_PAGE_LIMIT = 50;

interface MessageMetadata {
  from: string;
  to: string;
  timestamp: string;
  subject?: string;
  /**
   * Stable message id (also the file stem). Persisted in the body since v2.1;
   * messages written by older versions omit it and have it derived from the
   * filename on read.
   */
  id?: string;
  /**
   * Mailbox-queue consume state (v2.1). `receive_next` flips this to true.
   * Messages written by older versions omit it and are treated as unread.
   */
  read?: boolean;
  /** ISO timestamp set when the message is consumed via `receive_next` (v2.1). */
  readAt?: string;
}

interface Message extends MessageMetadata {
  content: string;
}

interface MessageIndex {
  [agent: string]: string[]; // agent -> array of message IDs
}

interface PaginationMetadata {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
}

// Tool argument types
interface SendMessageArgs {
  from?: string;
  to?: string;
  subject?: string;
  content?: string;
}

interface ReadMessagesArgs {
  agent?: string;
  limit?: number;
  offset?: number;
}

interface ListMessagesArgs {
  agent?: string;
  limit?: number;
  offset?: number;
}

interface DeleteMessageArgs {
  message_id?: string;
}

interface ClearMessagesArgs {
  agent?: string;
}

interface ReceiveNextArgs {
  agent?: string;
  peek?: boolean;
}

interface UnreadCountArgs {
  agent?: string;
}

interface AckArgs {
  message_id?: string;
}

/**
 * Simple LRU (Least Recently Used) Cache implementation
 */
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number = DEFAULT_CACHE_SIZE) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict least recently used if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, value);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

class AgentCommServer {
  private server: Server;
  private storageDir: string;
  private messageCache: LRUCache<string, Message>;
  private messageIndex: MessageIndex;
  private indexPath: string;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {
    this.storageDir = storageDir || DEFAULT_STORAGE_DIR;
    this.indexPath = path.join(path.dirname(this.storageDir), INDEX_FILE);
    this.messageCache = new LRUCache<string, Message>(cacheSize);
    this.messageIndex = {};

    this.server = new Server(
      {
        name: "agent-comm-system",
        version: "2.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      await this.saveIndex();
      await this.server.close();
      process.exit(0);
    });
  }

  private async ensureStorageDir(): Promise<void> {
    try {
      await fs.access(this.storageDir);
    } catch {
      await fs.mkdir(this.storageDir, { recursive: true });
    }
  }

  /**
   * Get the directory path for a specific agent's messages
   */
  private getAgentDir(agent: string): string {
    return path.join(this.storageDir, agent);
  }

  /**
   * Load the message index from disk
   */
  private async loadIndex(): Promise<void> {
    try {
      const indexData = await fs.readFile(this.indexPath, "utf-8");
      this.messageIndex = JSON.parse(indexData);
    } catch {
      // Index doesn't exist yet or is corrupted, rebuild it
      await this.rebuildIndex();
    }
  }

  /**
   * Save the message index to disk
   */
  private async saveIndex(): Promise<void> {
    try {
      await fs.writeFile(this.indexPath, JSON.stringify(this.messageIndex, null, 2));
    } catch (error) {
      console.error("[Index Save Error]", error);
    }
  }

  /**
   * Rebuild the index by scanning all message files
   */
  private async rebuildIndex(): Promise<void> {
    this.messageIndex = {};

    try {
      // Check if storage directory exists
      await fs.access(this.storageDir);
      const agentDirs = await fs.readdir(this.storageDir, { withFileTypes: true });

      for (const dirent of agentDirs) {
        if (dirent.isDirectory()) {
          const agent = dirent.name;
          const agentDir = this.getAgentDir(agent);
          const files = await fs.readdir(agentDir);

          const messageIds = files
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.replace(".json", ""));

          if (messageIds.length > 0) {
            this.messageIndex[agent] = messageIds;
          }
        }
      }

      await this.saveIndex();
    } catch {
      // Storage directory doesn't exist yet, that's okay
    }
  }

  /**
   * Add a message to the index
   */
  private async addToIndex(agent: string, messageId: string): Promise<void> {
    if (!this.messageIndex[agent]) {
      this.messageIndex[agent] = [];
    }
    this.messageIndex[agent].push(messageId);
    await this.saveIndex();
  }

  /**
   * Remove a message from the index
   */
  private async removeFromIndex(agent: string, messageId: string): Promise<void> {
    if (this.messageIndex[agent]) {
      this.messageIndex[agent] = this.messageIndex[agent].filter((id) => id !== messageId);
      if (this.messageIndex[agent].length === 0) {
        delete this.messageIndex[agent];
      }
      await this.saveIndex();
    }
  }

  /**
   * Clear all messages for an agent from the index
   */
  private async clearAgentFromIndex(agent: string): Promise<void> {
    delete this.messageIndex[agent];
    await this.saveIndex();
  }

  /**
   * Load a message by id from cache or disk, normalizing v2.1 fields for
   * backward compatibility (missing `id` ← filename, missing `read` ← false).
   * Returns null when the file is missing.
   */
  private async loadMessage(agent: string, messageId: string): Promise<Message | null> {
    let message = this.messageCache.get(messageId);
    if (!message) {
      const filePath = path.join(this.getAgentDir(agent), `${messageId}.json`);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        message = JSON.parse(content) as Message;
      } catch {
        return null;
      }
    }
    const normalized: Message = {
      ...message,
      id: message.id ?? messageId,
      read: message.read ?? false,
    };
    this.messageCache.set(messageId, normalized);
    return normalized;
  }

  /**
   * Load every message for an agent (cache-first), sorted oldest-first (FIFO).
   * A stable sort keeps same-millisecond messages in index (send) order.
   */
  private async getAgentMessages(agent: string): Promise<Message[]> {
    const messageIds = this.messageIndex[agent] || [];
    const messages: Message[] = [];
    for (const messageId of messageIds) {
      const message = await this.loadMessage(agent, messageId);
      if (message) {
        messages.push(message);
      }
    }
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return messages;
  }

  /**
   * Count unread (`read !== true`) messages for an agent.
   */
  private async countUnread(agent: string): Promise<number> {
    const messages = await this.getAgentMessages(agent);
    return messages.filter((m) => !m.read).length;
  }

  /**
   * Persist `read = true` (+ `readAt`) for a message and refresh the cache.
   */
  private async markRead(agent: string, messageId: string, message: Message): Promise<Message> {
    const updated: Message = {
      ...message,
      id: messageId,
      read: true,
      readAt: new Date().toISOString(),
    };
    const filePath = path.join(this.getAgentDir(agent), `${messageId}.json`);
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2));
    this.messageCache.set(messageId, updated);
    return updated;
  }

  /**
   * Delete a message by id from disk, index, and cache. Returns the owning
   * agent. Throws when the id is not present in the index.
   */
  private async deleteById(message_id: string): Promise<string> {
    let foundAgent: string | null = null;
    for (const [agent, messageIds] of Object.entries(this.messageIndex)) {
      if (messageIds.includes(message_id)) {
        foundAgent = agent;
        break;
      }
    }

    if (!foundAgent) {
      throw new Error(`Failed to find message: ${message_id} not found`);
    }

    const filePath = path.join(this.getAgentDir(foundAgent), `${message_id}.json`);
    try {
      await fs.unlink(filePath);
    } catch {
      // File already gone — still reconcile the index and cache below.
    }
    await this.removeFromIndex(foundAgent, message_id);
    this.messageCache.delete(message_id);
    return foundAgent;
  }

  /**
   * Best-effort "new mail" ping, consumed by an optional external delivery
   * layer (e.g. a Claude Code idle hook or chroxy). Fires only when
   * `AGENT_COMM_EMIT_WEBHOOK` is set. Capped (2s) and fully error-swallowed:
   * a delivery outage must never fail a send.
   */
  private async emitOnSend(message: Message): Promise<void> {
    const webhook = process.env.AGENT_COMM_EMIT_WEBHOOK;
    if (!webhook) {
      return;
    }
    try {
      if (typeof fetch !== "function") {
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const headerSpec = process.env.AGENT_COMM_EMIT_HEADER;
      if (headerSpec && headerSpec.includes(":")) {
        const idx = headerSpec.indexOf(":");
        const name = headerSpec.slice(0, idx).trim();
        const value = headerSpec.slice(idx + 1).trim();
        if (name) {
          headers[name] = value;
        }
      }
      const unreadCount = await this.countUnread(message.to);
      const body = JSON.stringify({
        to: message.to,
        from: message.from,
        id: message.id ?? null,
        subject: message.subject ?? null,
        unread_count: unreadCount,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(webhook, { method: "POST", headers, body, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Swallow — delivery is best-effort and must never break a send.
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      const tools: Tool[] = [
        {
          name: "send_message",
          description:
            "Send a message from one agent to another. Messages are stored as files and can be retrieved by the recipient agent.",
          inputSchema: {
            type: "object",
            properties: {
              from: {
                type: "string",
                description:
                  "The identifier of the sending agent (e.g., 'orchestrator', 'coder', 'reviewer')",
              },
              to: {
                type: "string",
                description: "The identifier of the receiving agent",
              },
              subject: {
                type: "string",
                description: "Optional subject line for the message",
              },
              content: {
                type: "string",
                description: "The message content to send",
              },
            },
            required: ["from", "to", "content"],
          },
        },
        {
          name: "read_messages",
          description:
            "Read messages addressed to a specific agent with optional pagination. Returns messages with metadata.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent to read messages for",
              },
              limit: {
                type: "number",
                description: `Optional: Maximum number of messages to return (default: ${DEFAULT_PAGE_LIMIT})`,
              },
              offset: {
                type: "number",
                description: "Optional: Number of messages to skip (default: 0)",
              },
            },
            required: ["agent"],
          },
        },
        {
          name: "list_messages",
          description:
            "List metadata for all messages in the system, optionally filtered by agent with pagination support.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "Optional: filter messages by recipient agent",
              },
              limit: {
                type: "number",
                description: `Optional: Maximum number of messages to return (default: ${DEFAULT_PAGE_LIMIT})`,
              },
              offset: {
                type: "number",
                description: "Optional: Number of messages to skip (default: 0)",
              },
            },
          },
        },
        {
          name: "delete_message",
          description: "Delete a specific message by its ID.",
          inputSchema: {
            type: "object",
            properties: {
              message_id: {
                type: "string",
                description: "The ID of the message to delete (format: from-to-timestamp)",
              },
            },
            required: ["message_id"],
          },
        },
        {
          name: "clear_messages",
          description: "Clear all messages for a specific agent or all messages in the system.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description:
                  "Optional: clear messages only for this agent. If not specified, clears all messages.",
              },
            },
          },
        },
        {
          name: "receive_next",
          description:
            "Dequeue the oldest UNREAD message for an agent (FIFO) and mark it read, so the next call returns the following message. This is the primary way to drain a mailbox as a queue. Pass peek=true to look at the next unread message without consuming it.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent whose mailbox to read from",
              },
              peek: {
                type: "boolean",
                description:
                  "Optional: when true, return the next unread message WITHOUT marking it read (default: false)",
              },
            },
            required: ["agent"],
          },
        },
        {
          name: "unread_count",
          description:
            "Return the number of unread messages (not yet consumed via receive_next) for an agent.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent to count unread messages for",
              },
            },
            required: ["agent"],
          },
        },
        {
          name: "ack",
          description:
            "Acknowledge a message as fully processed and delete it. Typically called after receive_next once the work the message described is complete.",
          inputSchema: {
            type: "object",
            properties: {
              message_id: {
                type: "string",
                description: "The ID of the message to acknowledge and remove",
              },
            },
            required: ["message_id"],
          },
        },
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        await this.ensureStorageDir();

        const args = request.params.arguments || {};

        switch (request.params.name) {
          case "send_message":
            return await this.handleSendMessage(args as SendMessageArgs);
          case "read_messages":
            return await this.handleReadMessages(args as ReadMessagesArgs);
          case "list_messages":
            return await this.handleListMessages(args as ListMessagesArgs);
          case "delete_message":
            return await this.handleDeleteMessage(args as DeleteMessageArgs);
          case "clear_messages":
            return await this.handleClearMessages(args as ClearMessagesArgs);
          case "receive_next":
            return await this.handleReceiveNext(args as ReceiveNextArgs);
          case "unread_count":
            return await this.handleUnreadCount(args as UnreadCountArgs);
          case "ack":
            return await this.handleAck(args as AckArgs);
          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }

  private async handleSendMessage(args: SendMessageArgs) {
    const { from, to, subject, content } = args;

    if (!from || !to || !content) {
      throw new Error("Missing required parameters: from, to, and content are required");
    }

    const timestamp = new Date().toISOString();
    const messageId = `${from}-${Date.now()}`;
    const fileName = `${messageId}.json`;

    // Ensure agent directory exists
    const agentDir = this.getAgentDir(to);
    await fs.mkdir(agentDir, { recursive: true });

    const filePath = path.join(agentDir, fileName);

    const message: Message = {
      from,
      to,
      timestamp,
      id: messageId,
      read: false,
      ...(subject && { subject }),
      content,
    };

    await fs.writeFile(filePath, JSON.stringify(message, null, 2));

    // Update index and cache
    await this.addToIndex(to, messageId);
    this.messageCache.set(messageId, message);

    // Best-effort "new mail" ping for an optional external delivery layer
    // (idle hook / chroxy). Never throws; never blocks success on a failure.
    await this.emitOnSend(message);

    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully!\nID: ${messageId}\nFrom: ${from}\nTo: ${to}\n${subject ? `Subject: ${subject}\n` : ""}Timestamp: ${timestamp}`,
        },
      ],
    };
  }

  private async handleReadMessages(args: ReadMessagesArgs) {
    const { agent, limit = DEFAULT_PAGE_LIMIT, offset = 0 } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    // Use index to get message IDs for this agent
    const messageIds = this.messageIndex[agent] || [];

    if (messageIds.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No messages found for agent: ${agent}`,
          },
        ],
      };
    }

    // Load messages (using cache when possible)
    const messages: Message[] = [];
    const agentDir = this.getAgentDir(agent);

    for (const messageId of messageIds) {
      // Check cache first
      let message = this.messageCache.get(messageId);

      if (!message) {
        // Not in cache, load from disk
        const filePath = path.join(agentDir, `${messageId}.json`);
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const parsedMessage = JSON.parse(content) as Message;
          this.messageCache.set(messageId, parsedMessage);
          message = parsedMessage;
        } catch {
          // File doesn't exist, skip it
          continue;
        }
      }

      messages.push(message);
    }

    // Sort by timestamp
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Apply pagination
    const total = messages.length;
    const paginatedMessages = messages.slice(offset, offset + limit);
    const pagination: PaginationMetadata = {
      total,
      offset,
      limit,
      returned: paginatedMessages.length,
      hasMore: offset + limit < total,
    };

    if (paginatedMessages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No messages in the requested range (offset: ${offset}, limit: ${limit}). Total messages: ${total}`,
          },
        ],
      };
    }

    const messageText = paginatedMessages
      .map((msg, idx) => {
        return `\n--- Message ${offset + idx + 1} ---\nFrom: ${msg.from}\nTo: ${msg.to}\nTimestamp: ${msg.timestamp}${msg.subject ? `\nSubject: ${msg.subject}` : ""}\n\nContent:\n${msg.content}\n`;
      })
      .join("\n");

    const paginationInfo = `\n\n--- Pagination ---\nShowing: ${offset + 1}-${offset + paginatedMessages.length} of ${total}\nHas more: ${pagination.hasMore ? "Yes" : "No"}`;

    return {
      content: [
        {
          type: "text",
          text: `Found ${total} message(s) for ${agent}:${messageText}${paginationInfo}`,
        },
      ],
    };
  }

  private async handleListMessages(args: ListMessagesArgs) {
    const { agent, limit = DEFAULT_PAGE_LIMIT, offset = 0 } = args;

    const messageList: Array<MessageMetadata & { id: string }> = [];

    if (agent) {
      // List messages for specific agent using index
      const messageIds = this.messageIndex[agent] || [];
      const agentDir = this.getAgentDir(agent);

      for (const messageId of messageIds) {
        // Try to get from cache first
        let message = this.messageCache.get(messageId);

        if (!message) {
          // Load metadata from file
          const filePath = path.join(agentDir, `${messageId}.json`);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsedMessage = JSON.parse(content) as Message;
            message = parsedMessage;
          } catch {
            continue;
          }
        }

        messageList.push({
          id: messageId,
          from: message.from,
          to: message.to,
          timestamp: message.timestamp,
          ...(message.subject && { subject: message.subject }),
        });
      }
    } else {
      // List all messages for all agents
      for (const [agentName, messageIds] of Object.entries(this.messageIndex)) {
        const agentDir = this.getAgentDir(agentName);

        for (const messageId of messageIds) {
          // Try cache first
          let message = this.messageCache.get(messageId);

          if (!message) {
            const filePath = path.join(agentDir, `${messageId}.json`);
            try {
              const content = await fs.readFile(filePath, "utf-8");
              const parsedMessage = JSON.parse(content) as Message;
              message = parsedMessage;
            } catch {
              continue;
            }
          }

          messageList.push({
            id: messageId,
            from: message.from,
            to: message.to,
            timestamp: message.timestamp,
            ...(message.subject && { subject: message.subject }),
          });
        }
      }
    }

    if (messageList.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: agent
              ? `No messages found for agent: ${agent}`
              : "No messages found in the system",
          },
        ],
      };
    }

    // Sort by timestamp
    messageList.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Apply pagination
    const total = messageList.length;
    const paginatedList = messageList.slice(offset, offset + limit);
    const pagination: PaginationMetadata = {
      total,
      offset,
      limit,
      returned: paginatedList.length,
      hasMore: offset + limit < total,
    };

    if (paginatedList.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No messages in the requested range (offset: ${offset}, limit: ${limit}). Total messages: ${total}`,
          },
        ],
      };
    }

    const listText = paginatedList
      .map((msg) => {
        return `ID: ${msg.id}\n  From: ${msg.from} → To: ${msg.to}\n  Timestamp: ${msg.timestamp}${msg.subject ? `\n  Subject: ${msg.subject}` : ""}`;
      })
      .join("\n\n");

    const paginationInfo = `\n\n--- Pagination ---\nShowing: ${offset + 1}-${offset + paginatedList.length} of ${total}\nHas more: ${pagination.hasMore ? "Yes" : "No"}`;

    return {
      content: [
        {
          type: "text",
          text: `Found ${total} message(s)${agent ? ` for ${agent}` : ""}:\n\n${listText}${paginationInfo}`,
        },
      ],
    };
  }

  private async handleDeleteMessage(args: DeleteMessageArgs) {
    const { message_id } = args;

    if (!message_id) {
      throw new Error("Missing required parameter: message_id");
    }

    // Find which agent this message belongs to
    let foundAgent: string | null = null;
    for (const [agent, messageIds] of Object.entries(this.messageIndex)) {
      if (messageIds.includes(message_id)) {
        foundAgent = agent;
        break;
      }
    }

    if (!foundAgent) {
      throw new Error(`Failed to delete message: ${message_id} not found`);
    }

    const fileName = `${message_id}.json`;
    const agentDir = this.getAgentDir(foundAgent);
    const filePath = path.join(agentDir, fileName);

    try {
      await fs.unlink(filePath);
      await this.removeFromIndex(foundAgent, message_id);
      this.messageCache.delete(message_id);

      return {
        content: [
          {
            type: "text",
            text: `Message ${message_id} deleted successfully`,
          },
        ],
      };
    } catch {
      throw new Error(`Failed to delete message: ${message_id} not found`);
    }
  }

  private async handleClearMessages(args: ClearMessagesArgs) {
    const { agent } = args;
    let deletedCount = 0;

    if (agent) {
      // Clear messages for specific agent
      const messageIds = this.messageIndex[agent] || [];
      const agentDir = this.getAgentDir(agent);

      for (const messageId of messageIds) {
        const filePath = path.join(agentDir, `${messageId}.json`);
        try {
          await fs.unlink(filePath);
          this.messageCache.delete(messageId);
          deletedCount++;
        } catch {
          // File already deleted or doesn't exist
        }
      }

      await this.clearAgentFromIndex(agent);

      // Try to remove the agent directory if it's empty
      try {
        await fs.rmdir(agentDir);
      } catch {
        // Directory not empty or doesn't exist, that's okay
      }
    } else {
      // Clear all messages for all agents
      for (const [agentName, messageIds] of Object.entries(this.messageIndex)) {
        const agentDir = this.getAgentDir(agentName);

        for (const messageId of messageIds) {
          const filePath = path.join(agentDir, `${messageId}.json`);
          try {
            await fs.unlink(filePath);
            this.messageCache.delete(messageId);
            deletedCount++;
          } catch {
            // File already deleted
          }
        }

        // Try to remove the agent directory
        try {
          await fs.rmdir(agentDir);
        } catch {
          // Directory not empty or doesn't exist
        }
      }

      // Clear the entire index
      this.messageIndex = {};
      await this.saveIndex();
      this.messageCache.clear();
    }

    return {
      content: [
        {
          type: "text",
          text: agent
            ? `Cleared ${deletedCount} message(s) for agent: ${agent}`
            : `Cleared all ${deletedCount} message(s) from the system`,
        },
      ],
    };
  }

  private async handleReceiveNext(args: ReceiveNextArgs) {
    const { agent, peek = false } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    const messages = await this.getAgentMessages(agent);
    const unreadTotal = messages.filter((m) => !m.read).length;
    const next = messages.find((m) => !m.read);

    if (!next) {
      return {
        content: [
          {
            type: "text",
            text: `No unread messages for agent: ${agent}`,
          },
        ],
      };
    }

    const messageId = next.id ?? `${next.from}-${new Date(next.timestamp).getTime()}`;

    if (!peek) {
      await this.markRead(agent, messageId, next);
    }

    const remainingUnread = peek ? unreadTotal : unreadTotal - 1;
    const header = peek ? "Next unread message (peek)" : "Received next message";
    const text =
      `${header} for ${agent}:\n` +
      `\n--- Message ---\n` +
      `ID: ${messageId}\n` +
      `From: ${next.from}\n` +
      `To: ${next.to}\n` +
      `Timestamp: ${next.timestamp}` +
      `${next.subject ? `\nSubject: ${next.subject}` : ""}\n` +
      `\nContent:\n${next.content}\n` +
      `\n--- Queue ---\nRemaining unread: ${remainingUnread}`;

    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }

  private async handleUnreadCount(args: UnreadCountArgs) {
    const { agent } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    const count = await this.countUnread(agent);

    return {
      content: [
        {
          type: "text",
          text: `Unread messages for ${agent}: ${count}`,
        },
      ],
    };
  }

  private async handleAck(args: AckArgs) {
    const { message_id } = args;

    if (!message_id) {
      throw new Error("Missing required parameter: message_id");
    }

    await this.deleteById(message_id);

    return {
      content: [
        {
          type: "text",
          text: `Message ${message_id} acknowledged and removed`,
        },
      ],
    };
  }

  async run() {
    await this.ensureStorageDir();
    await this.loadIndex();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Agent Communication MCP Server v2.1.0 running on stdio");
    console.error(`Loaded index with ${Object.keys(this.messageIndex).length} agent(s)`);
  }
}

// Export for testing
export { AgentCommServer, LRUCache, type Message, type MessageMetadata, type MessageIndex };

// Main execution (only run if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new AgentCommServer();
  server.run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
  });
}
