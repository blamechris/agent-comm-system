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
import { randomUUID } from "crypto";

// Default storage directory
const DEFAULT_STORAGE_DIR = path.join(os.homedir(), ".agent-comm-system", "messages");
const INDEX_FILE = "index.json";
const THREAD_INDEX_FILE = "thread_index.json";
const DEFAULT_CACHE_SIZE = 100;
const DEFAULT_PAGE_LIMIT = 50;

interface MessageMetadata {
  from: string;
  to: string;
  timestamp: string;
  subject?: string;
  thread_id?: string;
  reply_to?: string;
}

interface Message extends MessageMetadata {
  content: string;
}

interface MessageIndex {
  [agent: string]: string[]; // agent -> array of message IDs
}

interface ThreadMetadata {
  thread_id: string;
  first_message_subject?: string;
  message_count: number;
  participants: string[]; // list of agents in conversation
  last_activity: string; // ISO timestamp
  status: "active" | "closed";
  message_ids: string[]; // all messages in thread
}

interface ThreadIndex {
  [thread_id: string]: ThreadMetadata;
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
  reply_to?: string;
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

interface GetThreadArgs {
  thread_id?: string;
}

interface GetConversationTreeArgs {
  thread_id?: string;
}

interface ListThreadsArgs {
  agent?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

interface CloseThreadArgs {
  thread_id?: string;
}

// ConversationTreeNode interface (for future JSON response format)
interface _ConversationTreeNode {
  message_id: string;
  from: string;
  to: string;
  subject?: string;
  timestamp: string;
  replies: _ConversationTreeNode[];
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
  private threadIndex: ThreadIndex;
  private indexPath: string;
  private threadIndexPath: string;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {
    this.storageDir = storageDir || DEFAULT_STORAGE_DIR;
    this.indexPath = path.join(path.dirname(this.storageDir), INDEX_FILE);
    this.threadIndexPath = path.join(path.dirname(this.storageDir), THREAD_INDEX_FILE);
    this.messageCache = new LRUCache<string, Message>(cacheSize);
    this.messageIndex = {};
    this.threadIndex = {};

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
      await this.saveThreadIndex();
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

    // Also load thread index
    await this.loadThreadIndex();
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

    // Also rebuild thread index
    await this.rebuildThreadIndex();
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
   * Load the thread index from disk
   */
  private async loadThreadIndex(): Promise<void> {
    try {
      const threadData = await fs.readFile(this.threadIndexPath, "utf-8");
      this.threadIndex = JSON.parse(threadData);
    } catch {
      // Thread index doesn't exist yet or is corrupted, rebuild it
      await this.rebuildThreadIndex();
    }
  }

  /**
   * Save the thread index to disk
   */
  private async saveThreadIndex(): Promise<void> {
    try {
      await fs.writeFile(this.threadIndexPath, JSON.stringify(this.threadIndex, null, 2));
    } catch (error) {
      console.error("[Thread Index Save Error]", error);
    }
  }

  /**
   * Rebuild the thread index by scanning all message files
   */
  private async rebuildThreadIndex(): Promise<void> {
    this.threadIndex = {};

    try {
      // Check if storage directory exists
      await fs.access(this.storageDir);
      const agentDirs = await fs.readdir(this.storageDir, { withFileTypes: true });

      for (const dirent of agentDirs) {
        if (dirent.isDirectory()) {
          const agent = dirent.name;
          const agentDir = this.getAgentDir(agent);
          const files = await fs.readdir(agentDir);

          for (const file of files) {
            if (file.endsWith(".json")) {
              const filePath = path.join(agentDir, file);
              try {
                const content = await fs.readFile(filePath, "utf-8");
                const message = JSON.parse(content) as Message;
                const messageId = file.replace(".json", "");

                if (message.thread_id) {
                  await this.updateThreadIndex(message, messageId);
                }
              } catch {
                // Skip invalid message files
                continue;
              }
            }
          }
        }
      }

      await this.saveThreadIndex();
    } catch {
      // Storage directory doesn't exist yet, that's okay
    }
  }

  /**
   * Update the thread index with a new or modified message
   */
  private async updateThreadIndex(message: Message, messageId: string): Promise<void> {
    if (!message.thread_id) {
      return;
    }

    const threadId = message.thread_id;

    if (!this.threadIndex[threadId]) {
      // Create new thread metadata
      this.threadIndex[threadId] = {
        thread_id: threadId,
        ...(message.subject && { first_message_subject: message.subject }),
        message_count: 0,
        participants: [],
        last_activity: message.timestamp,
        status: "active",
        message_ids: [],
      };
    }

    const thread = this.threadIndex[threadId];
    if (!thread) {
      return; // Should never happen, but satisfy TypeScript
    }

    // Add message ID if not already present
    if (!thread.message_ids.includes(messageId)) {
      thread.message_ids.push(messageId);
      thread.message_count = thread.message_ids.length;
    }

    // Update participants
    for (const participant of [message.from, message.to]) {
      if (!thread.participants.includes(participant)) {
        thread.participants.push(participant);
      }
    }

    // Update last activity if this message is newer
    if (new Date(message.timestamp) > new Date(thread.last_activity)) {
      thread.last_activity = message.timestamp;
    }

    await this.saveThreadIndex();
  }

  /**
   * Get a message by its ID from any agent directory
   */
  private async getMessageById(messageId: string): Promise<Message | null> {
    // Check cache first
    const cachedMessage = this.messageCache.get(messageId);
    if (cachedMessage) {
      return cachedMessage;
    }

    // Search through all agent directories
    for (const agent of Object.keys(this.messageIndex)) {
      const agentMessageIds = this.messageIndex[agent];
      if (agentMessageIds && agentMessageIds.includes(messageId)) {
        const agentDir = this.getAgentDir(agent);
        const filePath = path.join(agentDir, `${messageId}.json`);

        try {
          const content = await fs.readFile(filePath, "utf-8");
          const message = JSON.parse(content) as Message;
          this.messageCache.set(messageId, message);
          return message;
        } catch {
          continue;
        }
      }
    }

    return null;
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
              reply_to: {
                type: "string",
                description:
                  "Optional: ID of the message to reply to. If provided, this message will be part of the same thread.",
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
          name: "get_thread",
          description:
            "Retrieve all messages in a conversation thread, sorted chronologically. Shows the complete conversation flow.",
          inputSchema: {
            type: "object",
            properties: {
              thread_id: {
                type: "string",
                description: "The unique identifier of the thread to retrieve",
              },
            },
            required: ["thread_id"],
          },
        },
        {
          name: "get_conversation_tree",
          description:
            "Display the hierarchical reply structure of a conversation thread. Shows parent-child relationships between messages.",
          inputSchema: {
            type: "object",
            properties: {
              thread_id: {
                type: "string",
                description: "The unique identifier of the thread to visualize",
              },
            },
            required: ["thread_id"],
          },
        },
        {
          name: "list_threads",
          description:
            "List all conversation threads with metadata. Supports filtering by agent or status, and pagination.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "Optional: filter threads by participant agent",
              },
              status: {
                type: "string",
                description: 'Optional: filter by status ("active" or "closed")',
              },
              limit: {
                type: "number",
                description: `Optional: Maximum number of threads to return (default: ${DEFAULT_PAGE_LIMIT})`,
              },
              offset: {
                type: "number",
                description: "Optional: Number of threads to skip (default: 0)",
              },
            },
          },
        },
        {
          name: "close_thread",
          description:
            "Mark a conversation thread as complete/closed. Closed threads can still be viewed but are marked as inactive.",
          inputSchema: {
            type: "object",
            properties: {
              thread_id: {
                type: "string",
                description: "The unique identifier of the thread to close",
              },
            },
            required: ["thread_id"],
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
          case "get_thread":
            return await this.handleGetThread(args as GetThreadArgs);
          case "get_conversation_tree":
            return await this.handleGetConversationTree(args as GetConversationTreeArgs);
          case "list_threads":
            return this.handleListThreads(args as ListThreadsArgs);
          case "close_thread":
            return await this.handleCloseThread(args as CloseThreadArgs);
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
    const { from, to, subject, content, reply_to } = args;

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

    // Handle threading logic
    let thread_id: string | undefined;
    let reply_to_id: string | undefined;

    if (reply_to) {
      // This is a reply - inherit thread_id from parent
      const parentMessage = await this.getMessageById(reply_to);
      if (!parentMessage) {
        throw new Error(`Parent message ${reply_to} not found`);
      }
      thread_id = parentMessage.thread_id;
      reply_to_id = reply_to;
    } else {
      // This is a new conversation - generate new thread_id
      thread_id = randomUUID();
    }

    const message: Message = {
      from,
      to,
      timestamp,
      ...(subject && { subject }),
      content,
      ...(thread_id && { thread_id }),
      ...(reply_to_id && { reply_to: reply_to_id }),
    };

    await fs.writeFile(filePath, JSON.stringify(message, null, 2));

    // Update indexes and cache
    await this.addToIndex(to, messageId);
    this.messageCache.set(messageId, message);

    // Update thread index
    if (thread_id) {
      await this.updateThreadIndex(message, messageId);
    }

    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully!\nID: ${messageId}\nFrom: ${from}\nTo: ${to}\n${subject ? `Subject: ${subject}\n` : ""}${thread_id ? `Thread ID: ${thread_id}\n` : ""}${reply_to_id ? `Reply to: ${reply_to_id}\n` : ""}Timestamp: ${timestamp}`,
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

  private async handleGetThread(args: GetThreadArgs) {
    const { thread_id } = args;

    if (!thread_id) {
      throw new Error("Missing required parameter: thread_id");
    }

    const thread = this.threadIndex[thread_id];
    if (!thread) {
      throw new Error(`Thread ${thread_id} not found`);
    }

    // Load all messages in the thread
    const messages: Array<Message & { id: string }> = [];
    for (const messageId of thread.message_ids) {
      const message = await this.getMessageById(messageId);
      if (message) {
        messages.push({ ...message, id: messageId });
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Thread ${thread_id} exists but has no messages`,
          },
        ],
      };
    }

    const messageText = messages
      .map((msg, idx) => {
        return `\n--- Message ${idx + 1} ---\nID: ${msg.id}\nFrom: ${msg.from} → To: ${msg.to}\nTimestamp: ${msg.timestamp}${msg.subject ? `\nSubject: ${msg.subject}` : ""}${msg.reply_to ? `\nReply to: ${msg.reply_to}` : ""}\n\nContent:\n${msg.content}\n`;
      })
      .join("\n");

    const threadInfo = `Thread: ${thread_id}\nStatus: ${thread.status}\nParticipants: ${thread.participants.join(", ")}\nMessages: ${thread.message_count}\nLast activity: ${thread.last_activity}`;

    return {
      content: [
        {
          type: "text",
          text: `${threadInfo}\n\n${messageText}`,
        },
      ],
    };
  }

  private async handleGetConversationTree(args: GetConversationTreeArgs) {
    const { thread_id } = args;

    if (!thread_id) {
      throw new Error("Missing required parameter: thread_id");
    }

    const thread = this.threadIndex[thread_id];
    if (!thread) {
      throw new Error(`Thread ${thread_id} not found`);
    }

    // Load all messages in the thread
    const messages: Array<Message & { id: string }> = [];
    for (const messageId of thread.message_ids) {
      const message = await this.getMessageById(messageId);
      if (message) {
        messages.push({ ...message, id: messageId });
      }
    }

    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Thread ${thread_id} exists but has no messages`,
          },
        ],
      };
    }

    // Build a map of message ID to message
    const messageMap = new Map<string, Message & { id: string }>();
    for (const msg of messages) {
      messageMap.set(msg.id, msg);
    }

    // Build the tree structure
    const buildTree = (messageId: string, depth: number = 0): string => {
      const msg = messageMap.get(messageId);
      if (!msg) return "";

      const indent = "  ".repeat(depth);
      const prefix = depth > 0 ? "└─ " : "";
      let result = `${indent}${prefix}[${msg.id}] ${msg.from} → ${msg.to}${msg.subject ? `: ${msg.subject}` : ""}\n`;
      result += `${indent}   ${msg.timestamp}\n`;

      // Find replies to this message
      const replies = messages.filter((m) => m.reply_to === messageId);
      for (const reply of replies) {
        result += buildTree(reply.id, depth + 1);
      }

      return result;
    };

    // Find root messages (messages with no reply_to field)
    const rootMessages = messages.filter((m) => !m.reply_to);

    let treeText = "";
    for (const root of rootMessages) {
      treeText += buildTree(root.id, 0);
    }

    const threadInfo = `Thread: ${thread_id}\nStatus: ${thread.status}\nParticipants: ${thread.participants.join(", ")}\nMessages: ${thread.message_count}\nLast activity: ${thread.last_activity}\n\nConversation Tree:\n`;

    return {
      content: [
        {
          type: "text",
          text: `${threadInfo}${treeText}`,
        },
      ],
    };
  }

  private handleListThreads(args: ListThreadsArgs) {
    const { agent, status, limit = DEFAULT_PAGE_LIMIT, offset = 0 } = args;

    // Filter threads
    let threads = Object.values(this.threadIndex);

    if (agent) {
      threads = threads.filter((t) => t.participants.includes(agent));
    }

    if (status) {
      threads = threads.filter((t) => t.status === status);
    }

    if (threads.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: agent ? `No threads found for agent: ${agent}` : "No threads found in the system",
          },
        ],
      };
    }

    // Sort by last activity (most recent first)
    threads.sort(
      (a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
    );

    // Apply pagination
    const total = threads.length;
    const paginatedThreads = threads.slice(offset, offset + limit);
    const pagination: PaginationMetadata = {
      total,
      offset,
      limit,
      returned: paginatedThreads.length,
      hasMore: offset + limit < total,
    };

    if (paginatedThreads.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No threads in the requested range (offset: ${offset}, limit: ${limit}). Total threads: ${total}`,
          },
        ],
      };
    }

    const listText = paginatedThreads
      .map((thread) => {
        return `Thread ID: ${thread.thread_id}\n  Status: ${thread.status}\n  Subject: ${thread.first_message_subject || "N/A"}\n  Participants: ${thread.participants.join(", ")}\n  Messages: ${thread.message_count}\n  Last activity: ${thread.last_activity}`;
      })
      .join("\n\n");

    const paginationInfo = `\n\n--- Pagination ---\nShowing: ${offset + 1}-${offset + paginatedThreads.length} of ${total}\nHas more: ${pagination.hasMore ? "Yes" : "No"}`;

    return {
      content: [
        {
          type: "text",
          text: `Found ${total} thread(s)${agent ? ` for ${agent}` : ""}:\n\n${listText}${paginationInfo}`,
        },
      ],
    };
  }

  private async handleCloseThread(args: CloseThreadArgs) {
    const { thread_id } = args;

    if (!thread_id) {
      throw new Error("Missing required parameter: thread_id");
    }

    const thread = this.threadIndex[thread_id];
    if (!thread) {
      throw new Error(`Thread ${thread_id} not found`);
    }

    thread.status = "closed";
    await this.saveThreadIndex();

    return {
      content: [
        {
          type: "text",
          text: `Thread ${thread_id} marked as closed`,
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
    console.error(`Loaded ${Object.keys(this.threadIndex).length} thread(s)`);
  }
}

// Export for testing
export {
  AgentCommServer,
  LRUCache,
  type Message,
  type MessageMetadata,
  type MessageIndex,
  type ThreadMetadata,
  type ThreadIndex,
};

// Main execution (only run if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new AgentCommServer();
  server.run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
  });
}
