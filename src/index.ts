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

interface SendMessageBulkArgs {
  from?: string;
  to?: string[];
  subject?: string;
  content?: string;
}

interface DeleteMessagesBulkArgs {
  message_ids?: string[];
}

interface UpdateMessageStatusBulkArgs {
  message_ids?: string[];
  status?: string;
}

interface DeleteMessagesByFilterArgs {
  agent?: string;
  from?: string;
  before?: string;
  after?: string;
  status?: string;
  confirm?: boolean;
}

interface MessageWithStatus extends Message {
  status?: string;
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
        version: "2.0.0",
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
   * Add multiple messages to the index in batch
   * More efficient than multiple addToIndex calls
   */
  private batchAddToIndex(updates: Array<{ agent: string; messageId: string }>): void {
    for (const { agent, messageId } of updates) {
      if (!this.messageIndex[agent]) {
        this.messageIndex[agent] = [];
      }
      this.messageIndex[agent].push(messageId);
    }
    // Note: Caller should call saveIndex() after this
  }

  /**
   * Remove multiple messages from the index in batch
   * More efficient than multiple removeFromIndex calls
   */
  private batchRemoveFromIndex(removals: Array<{ agent: string; messageId: string }>): void {
    for (const { agent, messageId } of removals) {
      if (this.messageIndex[agent]) {
        this.messageIndex[agent] = this.messageIndex[agent].filter((id) => id !== messageId);
        if (this.messageIndex[agent].length === 0) {
          delete this.messageIndex[agent];
        }
      }
    }
    // Note: Caller should call saveIndex() after this
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
          name: "send_message_bulk",
          description:
            "Send the same message to multiple recipients at once (broadcast). More efficient than sending individual messages.",
          inputSchema: {
            type: "object",
            properties: {
              from: {
                type: "string",
                description: "The identifier of the sending agent",
              },
              to: {
                type: "array",
                items: {
                  type: "string",
                },
                description: "Array of recipient agent identifiers",
              },
              subject: {
                type: "string",
                description: "Optional subject line for the message",
              },
              content: {
                type: "string",
                description: "The message content to send to all recipients",
              },
            },
            required: ["from", "to", "content"],
          },
        },
        {
          name: "delete_messages_bulk",
          description:
            "Delete multiple messages by their IDs in a single operation. More efficient than deleting messages individually.",
          inputSchema: {
            type: "object",
            properties: {
              message_ids: {
                type: "array",
                items: {
                  type: "string",
                },
                description: "Array of message IDs to delete",
              },
            },
            required: ["message_ids"],
          },
        },
        {
          name: "update_message_status_bulk",
          description:
            "Update the status for multiple messages at once. Useful for marking messages as read or acknowledged.",
          inputSchema: {
            type: "object",
            properties: {
              message_ids: {
                type: "array",
                items: {
                  type: "string",
                },
                description: "Array of message IDs to update",
              },
              status: {
                type: "string",
                description: 'Status to set (e.g., "read", "acknowledged")',
              },
            },
            required: ["message_ids", "status"],
          },
        },
        {
          name: "delete_messages_by_filter",
          description:
            "Delete messages matching specific criteria. CAUTION: This can delete multiple messages at once. Requires confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "Optional: filter by recipient agent",
              },
              from: {
                type: "string",
                description: "Optional: filter by sender",
              },
              before: {
                type: "string",
                description: "Optional: ISO timestamp, delete messages before this date",
              },
              after: {
                type: "string",
                description: "Optional: ISO timestamp, delete messages after this date",
              },
              status: {
                type: "string",
                description: "Optional: filter by status",
              },
              confirm: {
                type: "boolean",
                description: "Must be set to true to confirm deletion",
              },
            },
            required: ["confirm"],
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
          case "send_message_bulk":
            return await this.handleSendMessageBulk(args as SendMessageBulkArgs);
          case "delete_messages_bulk":
            return await this.handleDeleteMessagesBulk(args as DeleteMessagesBulkArgs);
          case "update_message_status_bulk":
            return await this.handleUpdateMessageStatusBulk(args as UpdateMessageStatusBulkArgs);
          case "delete_messages_by_filter":
            return await this.handleDeleteMessagesByFilter(args as DeleteMessagesByFilterArgs);
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
      ...(subject && { subject }),
      content,
    };

    await fs.writeFile(filePath, JSON.stringify(message, null, 2));

    // Update index and cache
    await this.addToIndex(to, messageId);
    this.messageCache.set(messageId, message);

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

  private async handleSendMessageBulk(args: SendMessageBulkArgs) {
    const { from, to, subject, content } = args;

    if (!from || !to || !content) {
      throw new Error("Missing required parameters: from, to, and content are required");
    }

    if (!Array.isArray(to) || to.length === 0) {
      throw new Error("Parameter 'to' must be a non-empty array of recipient agents");
    }

    const timestamp = new Date().toISOString();
    const results: Array<{
      to: string;
      success: boolean;
      message_id?: string;
      error?: string;
    }> = [];
    const indexUpdates: Array<{ agent: string; messageId: string }> = [];

    for (const recipient of to) {
      try {
        const messageId = `${from}-${Date.now()}`;
        const fileName = `${messageId}.json`;

        // Ensure agent directory exists
        const agentDir = this.getAgentDir(recipient);
        await fs.mkdir(agentDir, { recursive: true });

        const filePath = path.join(agentDir, fileName);

        const message: Message = {
          from,
          to: recipient,
          timestamp,
          ...(subject && { subject }),
          content,
        };

        await fs.writeFile(filePath, JSON.stringify(message, null, 2));

        // Collect index updates (batch later)
        indexUpdates.push({ agent: recipient, messageId });

        // Update cache
        this.messageCache.set(messageId, message);

        results.push({
          to: recipient,
          success: true,
          message_id: messageId,
        });

        // Small delay to ensure unique timestamps
        await new Promise((resolve) => setTimeout(resolve, 1));
      } catch (error) {
        results.push({
          to: recipient,
          success: false,
          error: error instanceof Error ? error.message : "Failed to send message",
        });
      }
    }

    // Batch update index (single write operation)
    if (indexUpdates.length > 0) {
      this.batchAddToIndex(indexUpdates);
      await this.saveIndex();
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    const summaryText = `Bulk send completed!\nTotal: ${results.length}\nSuccessful: ${successCount}\nFailed: ${failCount}\n\nResults:\n${results
      .map(
        (r) =>
          `- ${r.to}: ${r.success ? `✓ Success (ID: ${r.message_id})` : `✗ Failed (${r.error})`}`
      )
      .join("\n")}`;

    return {
      content: [
        {
          type: "text",
          text: summaryText,
        },
      ],
    };
  }

  private async handleDeleteMessagesBulk(args: DeleteMessagesBulkArgs) {
    const { message_ids } = args;

    if (!message_ids || !Array.isArray(message_ids) || message_ids.length === 0) {
      throw new Error("Parameter 'message_ids' must be a non-empty array");
    }

    let deletedCount = 0;
    const errors: string[] = [];
    const indexRemovals: Array<{ agent: string; messageId: string }> = [];

    for (const messageId of message_ids) {
      try {
        // Find which agent this message belongs to
        let foundAgent: string | null = null;
        for (const [agent, ids] of Object.entries(this.messageIndex)) {
          if (ids.includes(messageId)) {
            foundAgent = agent;
            break;
          }
        }

        if (!foundAgent) {
          errors.push(`${messageId}: not found in index`);
          continue;
        }

        const fileName = `${messageId}.json`;
        const agentDir = this.getAgentDir(foundAgent);
        const filePath = path.join(agentDir, fileName);

        await fs.unlink(filePath);

        // Collect index removals (batch later)
        indexRemovals.push({ agent: foundAgent, messageId });

        // Remove from cache
        this.messageCache.delete(messageId);

        deletedCount++;
      } catch (error) {
        errors.push(`${messageId}: ${error instanceof Error ? error.message : "deletion failed"}`);
      }
    }

    // Batch update index (single write operation)
    if (indexRemovals.length > 0) {
      this.batchRemoveFromIndex(indexRemovals);
      await this.saveIndex();
    }

    const resultText = `Bulk delete completed!\nRequested: ${message_ids.length}\nDeleted: ${deletedCount}\nFailed: ${errors.length}${
      errors.length > 0 ? `\n\nErrors:\n${errors.join("\n")}` : ""
    }`;

    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
  }

  private async handleUpdateMessageStatusBulk(args: UpdateMessageStatusBulkArgs) {
    const { message_ids, status } = args;

    if (!message_ids || !Array.isArray(message_ids) || message_ids.length === 0) {
      throw new Error("Parameter 'message_ids' must be a non-empty array");
    }

    if (!status) {
      throw new Error("Missing required parameter: status");
    }

    let updatedCount = 0;
    const errors: string[] = [];

    for (const messageId of message_ids) {
      try {
        // Find which agent this message belongs to
        let foundAgent: string | null = null;
        for (const [agent, ids] of Object.entries(this.messageIndex)) {
          if (ids.includes(messageId)) {
            foundAgent = agent;
            break;
          }
        }

        if (!foundAgent) {
          errors.push(`${messageId}: not found in index`);
          continue;
        }

        const fileName = `${messageId}.json`;
        const agentDir = this.getAgentDir(foundAgent);
        const filePath = path.join(agentDir, fileName);

        // Read the message
        const content = await fs.readFile(filePath, "utf-8");
        const message = JSON.parse(content) as MessageWithStatus;

        // Update status
        message.status = status;

        // Write back
        await fs.writeFile(filePath, JSON.stringify(message, null, 2));

        // Update cache
        this.messageCache.set(messageId, message);

        updatedCount++;
      } catch (error) {
        errors.push(`${messageId}: ${error instanceof Error ? error.message : "update failed"}`);
      }
    }

    const resultText = `Bulk status update completed!\nRequested: ${message_ids.length}\nUpdated: ${updatedCount}\nFailed: ${errors.length}\nStatus: ${status}${
      errors.length > 0 ? `\n\nErrors:\n${errors.join("\n")}` : ""
    }`;

    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
  }

  private async handleDeleteMessagesByFilter(args: DeleteMessagesByFilterArgs) {
    const { agent, from, before, after, status, confirm } = args;

    if (!confirm) {
      throw new Error("Confirmation required. Set confirm: true to proceed with deletion.");
    }

    // Collect all messages that match the filter
    const messagesToDelete: Array<{ agent: string; messageId: string }> = [];

    // Determine which agents to check
    const agentsToCheck = agent ? [agent] : Object.keys(this.messageIndex);

    for (const agentName of agentsToCheck) {
      const messageIds = this.messageIndex[agentName] || [];
      const agentDir = this.getAgentDir(agentName);

      for (const messageId of messageIds) {
        try {
          // Load message (check cache first)
          let message = this.messageCache.get(messageId) as MessageWithStatus | undefined;

          if (!message) {
            const filePath = path.join(agentDir, `${messageId}.json`);
            const content = await fs.readFile(filePath, "utf-8");
            message = JSON.parse(content) as MessageWithStatus;
          }

          // Apply filters
          let matches = true;

          if (from && message.from !== from) {
            matches = false;
          }

          if (before && new Date(message.timestamp) >= new Date(before)) {
            matches = false;
          }

          if (after && new Date(message.timestamp) <= new Date(after)) {
            matches = false;
          }

          if (status && message.status !== status) {
            matches = false;
          }

          if (matches) {
            messagesToDelete.push({ agent: agentName, messageId });
          }
        } catch {
          // Skip messages that can't be read
          continue;
        }
      }
    }

    // Delete the matching messages
    let deletedCount = 0;
    for (const { agent: agentName, messageId } of messagesToDelete) {
      try {
        const agentDir = this.getAgentDir(agentName);
        const filePath = path.join(agentDir, `${messageId}.json`);
        await fs.unlink(filePath);
        this.messageCache.delete(messageId);
        deletedCount++;
      } catch {
        // Skip if delete fails
      }
    }

    // Batch update index
    if (messagesToDelete.length > 0) {
      this.batchRemoveFromIndex(messagesToDelete);
      await this.saveIndex();
    }

    const filterDescription = [];
    if (agent) filterDescription.push(`agent: ${agent}`);
    if (from) filterDescription.push(`from: ${from}`);
    if (before) filterDescription.push(`before: ${before}`);
    if (after) filterDescription.push(`after: ${after}`);
    if (status) filterDescription.push(`status: ${status}`);

    const resultText = `Bulk delete by filter completed!\nFilters: ${filterDescription.join(", ") || "none (all messages)"}\nMatched: ${messagesToDelete.length}\nDeleted: ${deletedCount}`;

    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
  }

  async run() {
    await this.ensureStorageDir();
    await this.loadIndex();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Agent Communication MCP Server v2.0.0 running on stdio");
    console.error(`Loaded index with ${Object.keys(this.messageIndex).length} agent(s)`);
  }
}

// Export for testing
export {
  AgentCommServer,
  LRUCache,
  type Message,
  type MessageMetadata,
  type MessageIndex,
  type MessageWithStatus,
};

// Main execution (only run if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new AgentCommServer();
  server.run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
  });
}
