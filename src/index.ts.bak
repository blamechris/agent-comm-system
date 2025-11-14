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
const METRICS_FILE = "metrics.json";
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

interface AgentMetrics {
  sent_count: number;
  received_count: number;
  most_active_partners: { [agent: string]: number };
  first_message?: string;
  last_message?: string;
}

interface DailyActivity {
  [date: string]: number;
}

interface HourlyActivity {
  [hour: string]: number;
}

interface Metrics {
  total_messages: number;
  total_storage_bytes: number;
  cache_hits: number;
  cache_misses: number;
  agents: { [agent: string]: AgentMetrics };
  daily_activity: DailyActivity;
  hourly_activity: HourlyActivity;
  last_updated: string;
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

interface GetAgentStatsArgs {
  agent?: string;
}

interface GetActivityStatsArgs {
  start_date?: string;
  end_date?: string;
  agent?: string;
}

/**
 * Simple LRU (Least Recently Used) Cache implementation
 */
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;
  private onHit?: () => void;
  private onMiss?: () => void;

  constructor(maxSize: number = DEFAULT_CACHE_SIZE, onHit?: () => void, onMiss?: () => void) {
    this.cache = new Map();
    this.maxSize = maxSize;
    if (onHit) this.onHit = onHit;
    if (onMiss) this.onMiss = onMiss;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
      this.onHit?.();
    } else {
      this.onMiss?.();
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
  private metrics: Metrics;
  private metricsPath: string;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {
    this.storageDir = storageDir || DEFAULT_STORAGE_DIR;
    this.indexPath = path.join(path.dirname(this.storageDir), INDEX_FILE);
    this.metricsPath = path.join(path.dirname(this.storageDir), METRICS_FILE);
    this.messageIndex = {};
    this.metrics = {
      total_messages: 0,
      total_storage_bytes: 0,
      cache_hits: 0,
      cache_misses: 0,
      agents: {},
      daily_activity: {},
      hourly_activity: {},
      last_updated: new Date().toISOString(),
    };
    this.messageCache = new LRUCache<string, Message>(
      cacheSize,
      () => this.trackCacheHit(),
      () => this.trackCacheMiss()
    );

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
   * Load metrics from disk
   */
  private async loadMetrics(): Promise<void> {
    try {
      const metricsData = await fs.readFile(this.metricsPath, "utf-8");
      this.metrics = JSON.parse(metricsData);
    } catch {
      // Metrics file doesn't exist yet or is corrupted, rebuild it
      await this.rebuildMetrics();
    }
  }

  /**
   * Save metrics to disk
   */
  private async saveMetrics(): Promise<void> {
    try {
      this.metrics.last_updated = new Date().toISOString();
      await fs.writeFile(this.metricsPath, JSON.stringify(this.metrics, null, 2));
    } catch (error) {
      console.error("[Metrics Save Error]", error);
    }
  }

  /**
   * Rebuild metrics by scanning all message files
   */
  private async rebuildMetrics(): Promise<void> {
    this.metrics = {
      total_messages: 0,
      total_storage_bytes: 0,
      cache_hits: 0,
      cache_misses: 0,
      agents: {},
      daily_activity: {},
      hourly_activity: {},
      last_updated: new Date().toISOString(),
    };

    try {
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
                const stats = await fs.stat(filePath);

                // Update total storage
                this.metrics.total_storage_bytes += stats.size;

                // Update total messages
                this.metrics.total_messages++;

                // Update sender metrics
                const fromAgent = message.from;
                const toAgent = message.to;

                if (!this.metrics.agents[fromAgent]) {
                  this.metrics.agents[fromAgent] = {
                    sent_count: 0,
                    received_count: 0,
                    most_active_partners: {},
                  };
                }
                const senderMetrics = this.metrics.agents[fromAgent];
                senderMetrics.sent_count++;
                senderMetrics.most_active_partners[toAgent] =
                  (senderMetrics.most_active_partners[toAgent] || 0) + 1;

                // Update first/last message timestamps for sender
                if (
                  !senderMetrics.first_message ||
                  message.timestamp < senderMetrics.first_message
                ) {
                  senderMetrics.first_message = message.timestamp;
                }
                if (!senderMetrics.last_message || message.timestamp > senderMetrics.last_message) {
                  senderMetrics.last_message = message.timestamp;
                }

                // Update receiver metrics
                if (!this.metrics.agents[toAgent]) {
                  this.metrics.agents[toAgent] = {
                    sent_count: 0,
                    received_count: 0,
                    most_active_partners: {},
                  };
                }
                const receiverMetrics = this.metrics.agents[toAgent];
                receiverMetrics.received_count++;

                // Update first/last message timestamps for receiver
                if (
                  !receiverMetrics.first_message ||
                  message.timestamp < receiverMetrics.first_message
                ) {
                  receiverMetrics.first_message = message.timestamp;
                }
                if (
                  !receiverMetrics.last_message ||
                  message.timestamp > receiverMetrics.last_message
                ) {
                  receiverMetrics.last_message = message.timestamp;
                }

                // Update daily/hourly activity
                const date = new Date(message.timestamp);
                const isoStr = date.toISOString();
                const dateStr = isoStr.split("T")[0];
                const hour = date.getHours().toString();
                if (dateStr) {
                  this.metrics.daily_activity[dateStr] =
                    (this.metrics.daily_activity[dateStr] || 0) + 1;
                }
                this.metrics.hourly_activity[hour] = (this.metrics.hourly_activity[hour] || 0) + 1;
              } catch {
                // Skip corrupted files
              }
            }
          }
        }
      }

      await this.saveMetrics();
    } catch {
      // Storage directory doesn't exist yet
      await this.saveMetrics();
    }
  }

  /**
   * Update metrics when a message is sent
   */
  private updateMetricsOnSend(from: string, to: string): void {
    this.metrics.total_messages++;

    // Update sender metrics
    if (!this.metrics.agents[from]) {
      this.metrics.agents[from] = {
        sent_count: 0,
        received_count: 0,
        most_active_partners: {},
      };
    }
    this.metrics.agents[from].sent_count++;

    // Update partner map
    this.metrics.agents[from].most_active_partners[to] =
      (this.metrics.agents[from].most_active_partners[to] || 0) + 1;

    const now = new Date();

    // Update first/last message timestamps for sender
    if (!this.metrics.agents[from].first_message) {
      this.metrics.agents[from].first_message = now.toISOString();
    }
    this.metrics.agents[from].last_message = now.toISOString();

    // Update receiver metrics
    if (!this.metrics.agents[to]) {
      this.metrics.agents[to] = {
        sent_count: 0,
        received_count: 0,
        most_active_partners: {},
      };
    }
    this.metrics.agents[to].received_count++;

    // Update first/last message timestamps for receiver
    if (!this.metrics.agents[to].first_message) {
      this.metrics.agents[to].first_message = now.toISOString();
    }
    this.metrics.agents[to].last_message = now.toISOString();

    // Update daily/hourly activity
    const isoStr = now.toISOString();
    const dateStr = isoStr.split("T")[0];
    const hour = now.getHours().toString();
    if (dateStr) {
      this.metrics.daily_activity[dateStr] = (this.metrics.daily_activity[dateStr] || 0) + 1;
    }
    this.metrics.hourly_activity[hour] = (this.metrics.hourly_activity[hour] || 0) + 1;

    // Save metrics asynchronously (don't await to avoid blocking)
    this.saveMetrics().catch((error) => console.error("[Metrics Update Error]", error));
  }

  /**
   * Track cache hit
   */
  private trackCacheHit(): void {
    this.metrics.cache_hits++;
    // Save metrics asynchronously
    this.saveMetrics().catch((error) => console.error("[Metrics Save Error]", error));
  }

  /**
   * Track cache miss
   */
  private trackCacheMiss(): void {
    this.metrics.cache_misses++;
    // Save metrics asynchronously
    this.saveMetrics().catch((error) => console.error("[Metrics Save Error]", error));
  }

  /**
   * Calculate storage size efficiently
   */
  private async calculateStorageSize(): Promise<number> {
    let totalBytes = 0;
    try {
      for (const agent in this.messageIndex) {
        const messageIds = this.messageIndex[agent];
        if (!messageIds) continue;

        for (const messageId of messageIds) {
          const agentDir = this.getAgentDir(agent);
          const filePath = path.join(agentDir, `${messageId}.json`);
          try {
            const stats = await fs.stat(filePath);
            totalBytes += stats.size;
          } catch {
            // File doesn't exist, skip it
          }
        }
      }
    } catch {
      // Error calculating storage size
    }
    return totalBytes;
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
          name: "get_agent_stats",
          description:
            "Get statistics for a specific agent or system-wide. Returns message counts, communication patterns, and activity metrics.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description:
                  "Optional: get stats for this specific agent. If not specified, returns system-wide statistics.",
              },
            },
          },
        },
        {
          name: "get_storage_stats",
          description:
            "Get storage and cache performance metrics. Returns total storage size, per-agent breakdown, and cache hit rates.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_activity_stats",
          description:
            "Get temporal activity analysis showing message patterns over time. Returns daily/hourly histograms and peak activity periods.",
          inputSchema: {
            type: "object",
            properties: {
              start_date: {
                type: "string",
                description: "Optional: filter activity from this date (ISO format: YYYY-MM-DD)",
              },
              end_date: {
                type: "string",
                description: "Optional: filter activity until this date (ISO format: YYYY-MM-DD)",
              },
              agent: {
                type: "string",
                description: "Optional: filter activity for specific agent",
              },
            },
          },
        },
        {
          name: "get_communication_graph",
          description:
            "Get agent communication network data showing nodes (agents) and edges (message flows) with counts.",
          inputSchema: {
            type: "object",
            properties: {},
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
          case "get_agent_stats":
            return await this.handleGetAgentStats(args as GetAgentStatsArgs);
          case "get_storage_stats":
            return await this.handleGetStorageStats();
          case "get_activity_stats":
            return await this.handleGetActivityStats(args as GetActivityStatsArgs);
          case "get_communication_graph":
            return await this.handleGetCommunicationGraph();
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

    // Update metrics
    this.updateMetricsOnSend(from, to);

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

  private async handleGetAgentStats(args: GetAgentStatsArgs) {
    const { agent } = args;

    if (agent) {
      // Get stats for specific agent
      const agentMetrics = this.metrics.agents[agent];

      if (!agentMetrics) {
        return {
          content: [
            {
              type: "text",
              text: `No statistics found for agent: ${agent}`,
            },
          ],
        };
      }

      // Calculate average messages per day
      let avgMessagesPerDay = 0;
      if (agentMetrics.first_message && agentMetrics.last_message) {
        const firstDate = new Date(agentMetrics.first_message);
        const lastDate = new Date(agentMetrics.last_message);
        const daysDiff = Math.max(
          1,
          Math.ceil((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24))
        );
        avgMessagesPerDay = (agentMetrics.sent_count + agentMetrics.received_count) / daysDiff;
      }

      // Get top communication partners
      const partners = Object.entries(agentMetrics.most_active_partners)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([partner, count]) => `  ${partner}: ${count} messages`)
        .join("\n");

      const statsText = `Statistics for agent: ${agent}

Messages Sent: ${agentMetrics.sent_count}
Messages Received: ${agentMetrics.received_count}
Total Messages: ${agentMetrics.sent_count + agentMetrics.received_count}
Average Messages/Day: ${avgMessagesPerDay.toFixed(2)}

Most Active Communication Partners:
${partners || "  None"}

First Message: ${agentMetrics.first_message || "N/A"}
Last Message: ${agentMetrics.last_message || "N/A"}`;

      return {
        content: [
          {
            type: "text",
            text: statsText,
          },
        ],
      };
    } else {
      // Get system-wide stats
      const totalAgents = Object.keys(this.metrics.agents).length;
      const totalSent = Object.values(this.metrics.agents).reduce(
        (sum, m) => sum + m.sent_count,
        0
      );
      const totalReceived = Object.values(this.metrics.agents).reduce(
        (sum, m) => sum + m.received_count,
        0
      );

      // Get most active agents by total messages
      const mostActiveAgents = Object.entries(this.metrics.agents)
        .map(([name, metrics]) => ({
          name,
          total: metrics.sent_count + metrics.received_count,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map((agent) => `  ${agent.name}: ${agent.total} messages`)
        .join("\n");

      // Calculate date range for average
      let avgMessagesPerDay = 0;
      const allDates = Object.keys(this.metrics.daily_activity).sort();
      if (allDates.length > 0 && allDates[0]) {
        const firstDate = new Date(allDates[0]);
        const lastDateStr = allDates[allDates.length - 1];
        if (lastDateStr) {
          const lastDate = new Date(lastDateStr);
          const daysDiff = Math.max(
            1,
            Math.ceil((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
          );
          avgMessagesPerDay = this.metrics.total_messages / daysDiff;
        }
      }

      const statsText = `System-Wide Statistics

Total Messages: ${this.metrics.total_messages}
Total Agents: ${totalAgents}
Messages Sent: ${totalSent}
Messages Received: ${totalReceived}
Average Messages/Day: ${avgMessagesPerDay.toFixed(2)}

Most Active Agents (Top 10):
${mostActiveAgents || "  None"}

Last Updated: ${this.metrics.last_updated}`;

      return {
        content: [
          {
            type: "text",
            text: statsText,
          },
        ],
      };
    }
  }

  private async handleGetStorageStats() {
    // Update storage size
    this.metrics.total_storage_bytes = await this.calculateStorageSize();
    await this.saveMetrics();

    // Calculate per-agent storage breakdown
    const agentStorage: { [agent: string]: number } = {};
    for (const agent in this.messageIndex) {
      const messageIds = this.messageIndex[agent];
      if (!messageIds) continue;

      let agentBytes = 0;
      for (const messageId of messageIds) {
        const agentDir = this.getAgentDir(agent);
        const filePath = path.join(agentDir, `${messageId}.json`);
        try {
          const stats = await fs.stat(filePath);
          agentBytes += stats.size;
        } catch {
          // File doesn't exist
        }
      }
      agentStorage[agent] = agentBytes;
    }

    // Get top 10 agents by storage
    const topAgents = Object.entries(agentStorage)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([agent, bytes]) => {
        const messageCount = this.messageIndex[agent]?.length || 0;
        return `  ${agent}: ${(bytes / 1024).toFixed(2)} KB (${messageCount} messages)`;
      })
      .join("\n");

    // Calculate index size
    let indexSize = 0;
    try {
      const indexStats = await fs.stat(this.indexPath);
      indexSize = indexStats.size;
    } catch {
      // Index file doesn't exist
    }

    // Calculate cache hit rate
    const totalCacheAccess = this.metrics.cache_hits + this.metrics.cache_misses;
    const hitRate = totalCacheAccess > 0 ? (this.metrics.cache_hits / totalCacheAccess) * 100 : 0;

    const statsText = `Storage and Cache Statistics

Total Storage Size: ${(this.metrics.total_storage_bytes / 1024).toFixed(2)} KB
Total Messages: ${this.metrics.total_messages}
Index Size: ${(indexSize / 1024).toFixed(2)} KB

Per-Agent Storage (Top 10):
${topAgents || "  None"}

Cache Performance:
  Cache Hits: ${this.metrics.cache_hits}
  Cache Misses: ${this.metrics.cache_misses}
  Hit Rate: ${hitRate.toFixed(2)}%
  Cache Size: ${this.messageCache.size()} / ${DEFAULT_CACHE_SIZE}`;

    return {
      content: [
        {
          type: "text",
          text: statsText,
        },
      ],
    };
  }

  private async handleGetActivityStats(args: GetActivityStatsArgs) {
    const { start_date, end_date, agent } = args;

    let dailyActivity = { ...this.metrics.daily_activity };
    let hourlyActivity = { ...this.metrics.hourly_activity };

    // Filter by date range if specified
    if (start_date || end_date) {
      const filteredDaily: DailyActivity = {};
      for (const [date, count] of Object.entries(dailyActivity)) {
        if (start_date && date < start_date) continue;
        if (end_date && date > end_date) continue;
        filteredDaily[date] = count;
      }
      dailyActivity = filteredDaily;
    }

    // If agent is specified, we need to recalculate from their messages
    if (agent) {
      const messageIds = this.messageIndex[agent] || [];
      const agentDir = this.getAgentDir(agent);
      const agentDaily: DailyActivity = {};
      const agentHourly: HourlyActivity = {};

      for (const messageId of messageIds) {
        let message = this.messageCache.get(messageId);
        if (!message) {
          const filePath = path.join(agentDir, `${messageId}.json`);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            message = JSON.parse(content) as Message;
          } catch {
            continue;
          }
        }

        const date = new Date(message.timestamp);
        const dateStr = date.toISOString().split("T")[0];
        const hour = date.getHours().toString();

        // Apply date range filter
        if (start_date && dateStr && dateStr < start_date) continue;
        if (end_date && dateStr && dateStr > end_date) continue;

        if (dateStr) {
          agentDaily[dateStr] = (agentDaily[dateStr] || 0) + 1;
        }
        agentHourly[hour] = (agentHourly[hour] || 0) + 1;
      }

      dailyActivity = agentDaily;
      hourlyActivity = agentHourly;
    }

    // Find peak day and hour
    const peakDay = Object.entries(dailyActivity).sort(([, a], [, b]) => b - a)[0];
    const peakHour = Object.entries(hourlyActivity).sort(([, a], [, b]) => b - a)[0];

    // Create daily histogram
    const dailyHistogram = Object.entries(dailyActivity)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => {
        const bar = "█".repeat(Math.min(50, Math.ceil(count / 2)));
        return `  ${date}: ${bar} (${count})`;
      })
      .join("\n");

    // Create hourly histogram
    const hourlyHistogram = Array.from({ length: 24 }, (_, i) => i.toString())
      .map((hour) => {
        const count = hourlyActivity[hour] || 0;
        const bar = "█".repeat(Math.min(50, Math.ceil(count / 2)));
        return `  ${hour.padStart(2, "0")}:00: ${bar} (${count})`;
      })
      .join("\n");

    // Calculate agent activity ranking (if not filtering by agent)
    let agentRanking = "";
    if (!agent) {
      const agentCounts: { [agent: string]: number } = {};

      // Count messages in date range
      for (const [agentName, messageIds] of Object.entries(this.messageIndex)) {
        let count = 0;
        const agentDir = this.getAgentDir(agentName);

        for (const messageId of messageIds) {
          let message = this.messageCache.get(messageId);
          if (!message) {
            const filePath = path.join(agentDir, `${messageId}.json`);
            try {
              const content = await fs.readFile(filePath, "utf-8");
              message = JSON.parse(content) as Message;
            } catch {
              continue;
            }
          }

          const dateStr = message.timestamp.split("T")[0];
          if (start_date && dateStr && dateStr < start_date) continue;
          if (end_date && dateStr && dateStr > end_date) continue;
          count++;
        }

        if (count > 0) {
          agentCounts[agentName] = count;
        }
      }

      agentRanking =
        "\n\nAgent Activity Ranking:\n" +
        Object.entries(agentCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([name, count]) => `  ${name}: ${count} messages`)
          .join("\n");
    }

    const dateRange =
      start_date || end_date
        ? `\nDate Range: ${start_date || "beginning"} to ${end_date || "end"}`
        : "";
    const agentFilter = agent ? `\nFiltered by Agent: ${agent}` : "";

    const statsText = `Activity Statistics${dateRange}${agentFilter}

Daily Activity:
${dailyHistogram || "  No activity"}

Peak Day: ${peakDay ? `${peakDay[0]} (${peakDay[1]} messages)` : "N/A"}

Hourly Activity (by hour of day):
${hourlyHistogram}

Peak Hour: ${peakHour ? `${peakHour[0]}:00 (${peakHour[1]} messages)` : "N/A"}${agentRanking}`;

    return {
      content: [
        {
          type: "text",
          text: statsText,
        },
      ],
    };
  }

  private async handleGetCommunicationGraph() {
    // Build nodes and edges
    const nodes = new Set<string>();
    const edges: { [key: string]: number } = {};

    for (const [agent, metrics] of Object.entries(this.metrics.agents)) {
      nodes.add(agent);

      // Add edges for sent messages
      for (const [partner, count] of Object.entries(metrics.most_active_partners)) {
        nodes.add(partner);
        const edgeKey = `${agent}->${partner}`;
        edges[edgeKey] = count;
      }
    }

    // Sort edges by count
    const sortedEdges = Object.entries(edges)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20);

    const nodesText = Array.from(nodes)
      .sort()
      .map((node) => {
        const metrics = this.metrics.agents[node];
        if (metrics) {
          return `  ${node} (sent: ${metrics.sent_count}, received: ${metrics.received_count})`;
        }
        return `  ${node}`;
      })
      .join("\n");

    const edgesText = sortedEdges
      .map(([edge, count]) => {
        const [from, to] = edge.split("->");
        return `  ${from} → ${to}: ${count} messages`;
      })
      .join("\n");

    const graphText = `Communication Network Graph

Nodes (${nodes.size} agents):
${nodesText}

Top Communication Paths (${sortedEdges.length}):
${edgesText}

Total Unique Communication Paths: ${Object.keys(edges).length}`;

    return {
      content: [
        {
          type: "text",
          text: graphText,
        },
      ],
    };
  }

  async run() {
    await this.ensureStorageDir();
    await this.loadIndex();
    await this.loadMetrics();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Agent Communication MCP Server v2.0.0 running on stdio");
    console.error(`Loaded index with ${Object.keys(this.messageIndex).length} agent(s)`);
    console.error(`Loaded metrics: ${this.metrics.total_messages} total messages`);
  }
}

// Export for testing
export {
  AgentCommServer,
  LRUCache,
  type Message,
  type MessageMetadata,
  type MessageIndex,
  type Metrics,
  type AgentMetrics,
  type DailyActivity,
  type HourlyActivity,
};

// Main execution (only run if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new AgentCommServer();
  server.run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
  });
}
