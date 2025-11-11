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

interface MessageMetadata {
  from: string;
  to: string;
  timestamp: string;
  subject?: string;
}

interface Message extends MessageMetadata {
  content: string;
}

class AgentCommServer {
  private server: Server;
  private storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir || DEFAULT_STORAGE_DIR;
    this.server = new Server(
      {
        name: "agent-comm-system",
        version: "1.0.0",
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

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
            "Read all messages addressed to a specific agent. Returns all unread messages.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "The identifier of the agent to read messages for",
              },
            },
            required: ["agent"],
          },
        },
        {
          name: "list_messages",
          description:
            "List metadata for all messages in the system, optionally filtered by agent.",
          inputSchema: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                description: "Optional: filter messages by recipient agent",
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
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        await this.ensureStorageDir();

        switch (request.params.name) {
          case "send_message":
            return await this.handleSendMessage(request.params.arguments);
          case "read_messages":
            return await this.handleReadMessages(request.params.arguments);
          case "list_messages":
            return await this.handleListMessages(request.params.arguments);
          case "delete_message":
            return await this.handleDeleteMessage(request.params.arguments);
          case "clear_messages":
            return await this.handleClearMessages(request.params.arguments);
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

  private async handleSendMessage(args: any) {
    const { from, to, subject, content } = args;

    if (!from || !to || !content) {
      throw new Error("Missing required parameters: from, to, and content are required");
    }

    const timestamp = new Date().toISOString();
    const messageId = `${from}-${to}-${Date.now()}`;
    const fileName = `${messageId}.json`;
    const filePath = path.join(this.storageDir, fileName);

    const message: Message = {
      from,
      to,
      timestamp,
      ...(subject && { subject }),
      content,
    };

    await fs.writeFile(filePath, JSON.stringify(message, null, 2));

    return {
      content: [
        {
          type: "text",
          text: `Message sent successfully!\nID: ${messageId}\nFrom: ${from}\nTo: ${to}\n${subject ? `Subject: ${subject}\n` : ""}Timestamp: ${timestamp}`,
        },
      ],
    };
  }

  private async handleReadMessages(args: any) {
    const { agent } = args;

    if (!agent) {
      throw new Error("Missing required parameter: agent");
    }

    const files = await fs.readdir(this.storageDir);
    const messages: Message[] = [];

    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(this.storageDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const message: Message = JSON.parse(content);

        if (message.to === agent) {
          messages.push(message);
        }
      }
    }

    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No messages found for agent: ${agent}`,
          },
        ],
      };
    }

    // Sort by timestamp
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const messageText = messages
      .map((msg, idx) => {
        return `\n--- Message ${idx + 1} ---\nFrom: ${msg.from}\nTo: ${msg.to}\nTimestamp: ${msg.timestamp}${msg.subject ? `\nSubject: ${msg.subject}` : ""}\n\nContent:\n${msg.content}\n`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${messages.length} message(s) for ${agent}:${messageText}`,
        },
      ],
    };
  }

  private async handleListMessages(args: any) {
    const { agent } = args;

    const files = await fs.readdir(this.storageDir);
    const messageList: Array<MessageMetadata & { id: string }> = [];

    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(this.storageDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const message: Message = JSON.parse(content);

        if (!agent || message.to === agent) {
          const id = file.replace(".json", "");
          messageList.push({
            id,
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

    const listText = messageList
      .map((msg) => {
        return `ID: ${msg.id}\n  From: ${msg.from} → To: ${msg.to}\n  Timestamp: ${msg.timestamp}${msg.subject ? `\n  Subject: ${msg.subject}` : ""}`;
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${messageList.length} message(s)${agent ? ` for ${agent}` : ""}:\n\n${listText}`,
        },
      ],
    };
  }

  private async handleDeleteMessage(args: any) {
    const { message_id } = args;

    if (!message_id) {
      throw new Error("Missing required parameter: message_id");
    }

    const fileName = `${message_id}.json`;
    const filePath = path.join(this.storageDir, fileName);

    try {
      await fs.unlink(filePath);
      return {
        content: [
          {
            type: "text",
            text: `Message ${message_id} deleted successfully`,
          },
        ],
      };
    } catch (_error) {
      throw new Error(`Failed to delete message: ${message_id} not found`);
    }
  }

  private async handleClearMessages(args: any) {
    const { agent } = args;

    const files = await fs.readdir(this.storageDir);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(this.storageDir, file);

        if (agent) {
          // Only delete messages for specific agent
          const content = await fs.readFile(filePath, "utf-8");
          const message: Message = JSON.parse(content);

          if (message.to === agent) {
            await fs.unlink(filePath);
            deletedCount++;
          }
        } else {
          // Delete all messages
          await fs.unlink(filePath);
          deletedCount++;
        }
      }
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

  async run() {
    await this.ensureStorageDir();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Agent Communication MCP Server running on stdio");
  }
}

// Main execution
const server = new AgentCommServer();
server.run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
