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
const LIMITS_FILE = "limits.json";
const DEFAULT_CACHE_SIZE = 100;
const DEFAULT_PAGE_LIMIT = 50;

// Rate limiting defaults
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_RATE_LIMIT_PER_HOUR = 100;
const DEFAULT_MESSAGE_QUOTA = 10000;
const DEFAULT_BURST_ALLOWANCE = 5;

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

interface SetAgentQuotaArgs {
  agent?: string;
  limit?: number;
}

interface SetRateLimitArgs {
  agent?: string;
  per_minute?: number;
  per_hour?: number;
}

interface GetQuotaStatusArgs {
  agent?: string;
}

interface GetRateLimitStatusArgs {
  agent?: string;
}

interface ResetAgentLimitsArgs {
  agent?: string;
}

interface RateLimitWindow {
  timestamps: number[];
}

interface AgentRateLimit {
  perMinute: number;
  perHour: number;
  minuteWindow: RateLimitWindow;
  hourWindow: RateLimitWindow;
  burstAllowance: number;
}

interface AgentQuota {
  limit: number;
  used: number;
  resetDate?: string;
}

interface LimitsData {
  rateLimits: {
    [agent: string]: AgentRateLimit;
  };
  quotas: {
    [agent: string]: AgentQuota;
  };
  defaultRateLimit: {
    perMinute: number;
    perHour: number;
  };
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
  private limitsPath: string;
  private limitsData: LimitsData;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {
    this.storageDir = storageDir || DEFAULT_STORAGE_DIR;
    this.indexPath = path.join(path.dirname(this.storageDir), INDEX_FILE);
    this.limitsPath = path.join(path.dirname(this.storageDir), LIMITS_FILE);
    this.messageCache = new LRUCache<string, Message>(cacheSize);
    this.messageIndex = {};
    this.limitsData = {
      rateLimits: {},
      quotas: {},
      defaultRateLimit: {
        perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
        perHour: DEFAULT_RATE_LIMIT_PER_HOUR,
      },
    };

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
      await this.saveLimits();
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
   * Load the limits data from disk
   */
  private async loadLimits(): Promise<void> {
    try {
      const limitsContent = await fs.readFile(this.limitsPath, "utf-8");
      this.limitsData = JSON.parse(limitsContent);
    } catch {
      // Limits file doesn't exist yet, use defaults
      this.limitsData = {
        rateLimits: {},
        quotas: {},
        defaultRateLimit: {
          perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
          perHour: DEFAULT_RATE_LIMIT_PER_HOUR,
        },
      };
    }
  }

  /**
   * Save the limits data to disk (async, fire-and-forget for performance)
   */
  private async saveLimits(): Promise<void> {
    try {
      await fs.writeFile(this.limitsPath, JSON.stringify(this.limitsData, null, 2));
    } catch (error) {
      console.error("[Limits Save Error]", error);
    }
  }

  /**
   * Get or initialize rate limit for an agent
   */
  private getAgentRateLimit(agent: string): AgentRateLimit {
    if (!this.limitsData.rateLimits[agent]) {
      this.limitsData.rateLimits[agent] = {
        perMinute: this.limitsData.defaultRateLimit.perMinute,
        perHour: this.limitsData.defaultRateLimit.perHour,
        minuteWindow: { timestamps: [] },
        hourWindow: { timestamps: [] },
        burstAllowance: DEFAULT_BURST_ALLOWANCE,
      };
    }
    return this.limitsData.rateLimits[agent];
  }

  /**
   * Get or initialize quota for an agent
   */
  private getAgentQuota(agent: string): AgentQuota {
    if (!this.limitsData.quotas[agent]) {
      this.limitsData.quotas[agent] = {
        limit: DEFAULT_MESSAGE_QUOTA,
        used: 0,
        
      };
    }
    return this.limitsData.quotas[agent];
  }

  /**
   * Clean old timestamps from a window (sliding window implementation)
   */
  private cleanWindow(window: RateLimitWindow, windowMs: number): void {
    const now = Date.now();
    const cutoff = now - windowMs;
    window.timestamps = window.timestamps.filter((ts) => ts > cutoff);
  }

  /**
   * Check if agent is within rate limits (sliding window)
   */
  private checkRateLimit(agent: string): { allowed: boolean; retryAfter?: number; reason?: string } {
    const rateLimit = this.getAgentRateLimit(agent);

    // Clean old timestamps
    this.cleanWindow(rateLimit.minuteWindow, 60 * 1000); // 1 minute
    this.cleanWindow(rateLimit.hourWindow, 60 * 60 * 1000); // 1 hour

    // Check minute limit (with burst allowance)
    const minuteCount = rateLimit.minuteWindow.timestamps.length;
    if (minuteCount >= rateLimit.perMinute + rateLimit.burstAllowance) {
      const oldestMinute = rateLimit.minuteWindow.timestamps[0] || Date.now();
      const retryAfter = oldestMinute + 60 * 1000;
      return {
        allowed: false,
        retryAfter,
        reason: `Rate limit exceeded: ${rateLimit.perMinute} messages per minute (burst: +${rateLimit.burstAllowance})`,
      };
    }

    // Check hour limit
    const hourCount = rateLimit.hourWindow.timestamps.length;
    if (hourCount >= rateLimit.perHour) {
      const oldestHour = rateLimit.hourWindow.timestamps[0] || Date.now();
      const retryAfter = oldestHour + 60 * 60 * 1000;
      return {
        allowed: false,
        retryAfter,
        reason: `Rate limit exceeded: ${rateLimit.perHour} messages per hour`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if agent is within quota
   */
  private checkQuota(agent: string): { allowed: boolean; reason?: string } {
    const quota = this.getAgentQuota(agent);

    if (quota.used >= quota.limit) {
      return {
        allowed: false,
        reason: `Message quota exceeded: ${quota.used}/${quota.limit} messages used`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a message send for rate limiting and quota tracking
   */
  private async recordMessageSend(agent: string): Promise<void> {
    const now = Date.now();
    const rateLimit = this.getAgentRateLimit(agent);
    const quota = this.getAgentQuota(agent);

    // Add timestamp to both windows
    rateLimit.minuteWindow.timestamps.push(now);
    rateLimit.hourWindow.timestamps.push(now);

    // Increment quota usage
    quota.used++;

    // Save limits asynchronously (fire-and-forget)
    this.saveLimits().catch((error) => {
      console.error("[Async Limits Save Error]", error);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      const tools: Tool[] = [
        {
          name: "send_message",
          description:
            "Send a message from one agent to another. Messages are stored as files and can be retrieved by the recipient agent. Subject to rate limits and quotas.",
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
          name: "get_quota_status",
          description:
            "Get the message quota status for an agent, showing used, remaining, limit, and reset date.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent to check quota for",
              },
            },
            required: ["agent"],
          },
        },
        {
          name: "set_agent_quota",
          description: "Set a custom message quota for a specific agent (admin operation).",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent",
              },
              limit: {
                type: "number",
                description: "The maximum number of messages the agent can send",
              },
            },
            required: ["agent", "limit"],
          },
        },
        {
          name: "set_rate_limit",
          description:
            "Set custom rate limits for an agent or update default rate limits (admin operation).",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "Optional: agent identifier. If not specified, sets default limits for all agents.",
              },
              per_minute: {
                type: "number",
                description: "Maximum messages per minute",
              },
              per_hour: {
                type: "number",
                description: "Maximum messages per hour",
              },
            },
          },
        },
        {
          name: "get_rate_limit_status",
          description:
            "Get the current rate limit status for an agent, showing current usage vs limits and when limits reset.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent to check rate limits for",
              },
            },
            required: ["agent"],
          },
        },
        {
          name: "reset_agent_limits",
          description:
            "Reset rate limits and optionally quota for an agent (admin operation).",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent to reset limits for",
              },
            },
            required: ["agent"],
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
          case "get_quota_status":
            return await this.handleGetQuotaStatus(args as GetQuotaStatusArgs);
          case "set_agent_quota":
            return await this.handleSetAgentQuota(args as SetAgentQuotaArgs);
          case "set_rate_limit":
            return await this.handleSetRateLimit(args as SetRateLimitArgs);
          case "get_rate_limit_status":
            return await this.handleGetRateLimitStatus(args as GetRateLimitStatusArgs);
          case "reset_agent_limits":
            return await this.handleResetAgentLimits(args as ResetAgentLimitsArgs);
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

    // Check rate limits
    const rateLimitCheck = this.checkRateLimit(from);
    if (!rateLimitCheck.allowed) {
      const retryAfterDate = new Date(rateLimitCheck.retryAfter!).toISOString();
      throw new Error(
        `${rateLimitCheck.reason}\nRetry after: ${retryAfterDate} (${new Date(rateLimitCheck.retryAfter!).toLocaleString()})`
      );
    }

    // Check quota
    const quotaCheck = this.checkQuota(from);
    if (!quotaCheck.allowed) {
      throw new Error(quotaCheck.reason);
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

    // Record the message send for rate limiting and quota
    await this.recordMessageSend(from);

    // Get updated quota for response
    const quota = this.getAgentQuota(from);

    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully!\nID: ${messageId}\nFrom: ${from}\nTo: ${to}\n${subject ? `Subject: ${subject}\n` : ""}Timestamp: ${timestamp}\n\nQuota: ${quota.used}/${quota.limit} messages used`,
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

  private async handleGetQuotaStatus(args: GetQuotaStatusArgs) {
    const { agent } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    const quota = this.getAgentQuota(agent);
    const remaining = quota.limit - quota.used;
    const percentUsed = ((quota.used / quota.limit) * 100).toFixed(1);

    return {
      content: [
        {
          type: "text",
          text: `Quota Status for '${agent}':\n\nUsed: ${quota.used} messages\nRemaining: ${remaining} messages\nLimit: ${quota.limit} messages\nPercentage Used: ${percentUsed}%${quota.resetDate ? `\nReset Date: ${quota.resetDate}` : "\nReset Date: Not set"}`,
        },
      ],
    };
  }

  private async handleSetAgentQuota(args: SetAgentQuotaArgs) {
    const { agent, limit } = args;

    if (!agent || limit === undefined) {
      throw new Error("Missing required parameters: agent and limit are required");
    }

    if (limit < 0) {
      throw new Error("Limit must be a positive number");
    }

    const quota = this.getAgentQuota(agent);
    quota.limit = limit;

    await this.saveLimits();

    return {
      content: [
        {
          type: "text",
          text: `Quota updated for '${agent}':\nNew limit: ${limit} messages\nCurrent usage: ${quota.used} messages\nRemaining: ${limit - quota.used} messages`,
        },
      ],
    };
  }

  private async handleSetRateLimit(args: SetRateLimitArgs) {
    const { agent, per_minute, per_hour } = args;

    if (per_minute === undefined && per_hour === undefined) {
      throw new Error("At least one of per_minute or per_hour must be specified");
    }

    if (per_minute !== undefined && per_minute < 0) {
      throw new Error("per_minute must be a positive number");
    }

    if (per_hour !== undefined && per_hour < 0) {
      throw new Error("per_hour must be a positive number");
    }

    if (agent) {
      // Set rate limit for specific agent
      const rateLimit = this.getAgentRateLimit(agent);

      if (per_minute !== undefined) {
        rateLimit.perMinute = per_minute;
      }
      if (per_hour !== undefined) {
        rateLimit.perHour = per_hour;
      }

      await this.saveLimits();

      return {
        content: [
          {
            type: "text",
            text: `Rate limits updated for '${agent}':\nPer minute: ${rateLimit.perMinute} messages\nPer hour: ${rateLimit.perHour} messages\nBurst allowance: +${rateLimit.burstAllowance} messages`,
          },
        ],
      };
    } else {
      // Set default rate limits for all agents
      if (per_minute !== undefined) {
        this.limitsData.defaultRateLimit.perMinute = per_minute;
      }
      if (per_hour !== undefined) {
        this.limitsData.defaultRateLimit.perHour = per_hour;
      }

      await this.saveLimits();

      return {
        content: [
          {
            type: "text",
            text: `Default rate limits updated:\nPer minute: ${this.limitsData.defaultRateLimit.perMinute} messages\nPer hour: ${this.limitsData.defaultRateLimit.perHour} messages\n\nNote: This affects new agents and agents without custom limits.`,
          },
        ],
      };
    }
  }

  private async handleGetRateLimitStatus(args: GetRateLimitStatusArgs) {
    const { agent } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    const rateLimit = this.getAgentRateLimit(agent);

    // Clean windows
    this.cleanWindow(rateLimit.minuteWindow, 60 * 1000);
    this.cleanWindow(rateLimit.hourWindow, 60 * 60 * 1000);

    const minuteCount = rateLimit.minuteWindow.timestamps.length;
    const hourCount = rateLimit.hourWindow.timestamps.length;

    const minuteRemaining = rateLimit.perMinute + rateLimit.burstAllowance - minuteCount;
    const hourRemaining = rateLimit.perHour - hourCount;

    // Calculate when limits reset
    const now = Date.now();
    let minuteResetIn = "N/A";
    let hourResetIn = "N/A";

    if (rateLimit.minuteWindow.timestamps.length > 0) {
      const oldestMinute = rateLimit.minuteWindow.timestamps[0] || Date.now();
      const resetTime = oldestMinute + 60 * 1000;
      const secondsUntilReset = Math.ceil((resetTime - now) / 1000);
      minuteResetIn = secondsUntilReset > 0 ? `${secondsUntilReset} seconds` : "Now";
    }

    if (rateLimit.hourWindow.timestamps.length > 0) {
      const oldestHour = rateLimit.hourWindow.timestamps[0] || Date.now();
      const resetTime = oldestHour + 60 * 60 * 1000;
      const minutesUntilReset = Math.ceil((resetTime - now) / 60000);
      hourResetIn = minutesUntilReset > 0 ? `${minutesUntilReset} minutes` : "Now";
    }

    return {
      content: [
        {
          type: "text",
          text: `Rate Limit Status for '${agent}':\n\n--- Per Minute ---\nUsed: ${minuteCount}/${rateLimit.perMinute} (burst: +${rateLimit.burstAllowance})\nRemaining: ${minuteRemaining}\nResets in: ${minuteResetIn}\n\n--- Per Hour ---\nUsed: ${hourCount}/${rateLimit.perHour}\nRemaining: ${hourRemaining}\nResets in: ${hourResetIn}`,
        },
      ],
    };
  }

  private async handleResetAgentLimits(args: ResetAgentLimitsArgs) {
    const { agent } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    // Reset rate limits
    if (this.limitsData.rateLimits[agent]) {
      this.limitsData.rateLimits[agent].minuteWindow.timestamps = [];
      this.limitsData.rateLimits[agent].hourWindow.timestamps = [];
    }

    // Reset quota usage (but keep the limit)
    if (this.limitsData.quotas[agent]) {
      this.limitsData.quotas[agent].used = 0;
      this.limitsData.quotas[agent].resetDate = new Date().toISOString();
    }

    await this.saveLimits();

    return {
      content: [
        {
          type: "text",
          text: `Limits reset for '${agent}':\n\nRate limits: Cleared all usage windows\nQuota: Reset to 0 used messages\nReset date: ${new Date().toISOString()}`,
        },
      ],
    };
  }

  async run() {
    await this.ensureStorageDir();
    await this.loadIndex();
    await this.loadLimits();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Agent Communication MCP Server v2.0.0 running on stdio");
    console.error(`Loaded index with ${Object.keys(this.messageIndex).length} agent(s)`);
    console.error(
      `Rate limiting: ${this.limitsData.defaultRateLimit.perMinute}/min, ${this.limitsData.defaultRateLimit.perHour}/hour`
    );
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
