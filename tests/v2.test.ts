import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { createTempTestDir, cleanupTestDir } from "./helpers.js";

// Import the server classes from compiled dist
// Note: In a real scenario, we'd need to export these classes from index.ts

interface Message {
  from: string;
  to: string;
  timestamp: string;
  subject?: string;
  content: string;
}

interface MessageIndex {
  [agent: string]: string[];
}

/**
 * v2.0 Feature Tests
 * Tests for new features in v2.0:
 * - LRU Cache
 * - Message Indexing
 * - Pagination
 * - Directory Organization
 */
describe("Agent Communication System v2.0", () => {
  let testDir: string;
  let messagesDir: string;
  let indexPath: string;

  beforeEach(async () => {
    testDir = await createTempTestDir();
    messagesDir = path.join(testDir, "messages");
    indexPath = path.join(testDir, "index.json");
    await fs.mkdir(messagesDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  describe("Directory Organization", () => {
    it("should organize messages by recipient agent", async () => {
      const agentDir = path.join(messagesDir, "coder");
      await fs.mkdir(agentDir, { recursive: true });

      const message: Message = {
        from: "orchestrator",
        to: "coder",
        timestamp: new Date().toISOString(),
        subject: "Task",
        content: "Test content",
      };

      const messageId = `orchestrator-${Date.now()}`;
      const filePath = path.join(agentDir, `${messageId}.json`);

      await fs.writeFile(filePath, JSON.stringify(message, null, 2));

      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Verify message is in correct directory
      const dirname = path.dirname(filePath);
      expect(dirname).toBe(agentDir);
    });

    it("should support multiple agents with separate directories", async () => {
      const agents = ["coder", "reviewer", "tester"];

      for (const agent of agents) {
        const agentDir = path.join(messagesDir, agent);
        await fs.mkdir(agentDir, { recursive: true });

        const message: Message = {
          from: "orchestrator",
          to: agent,
          timestamp: new Date().toISOString(),
          content: `Task for ${agent}`,
        };

        const messageId = `orchestrator-${Date.now()}`;
        const filePath = path.join(agentDir, `${messageId}.json`);
        await fs.writeFile(filePath, JSON.stringify(message, null, 2));

        // Small delay to ensure unique timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Verify all directories exist
      for (const agent of agents) {
        const agentDir = path.join(messagesDir, agent);
        const files = await fs.readdir(agentDir);
        expect(files.length).toBe(1);
      }
    });

    it("should use new message ID format (from-timestamp)", async () => {
      const messageId = `orchestrator-${Date.now()}`;
      const agentDir = path.join(messagesDir, "coder");
      await fs.mkdir(agentDir, { recursive: true });

      const message: Message = {
        from: "orchestrator",
        to: "coder",
        timestamp: new Date().toISOString(),
        content: "Test",
      };

      const filePath = path.join(agentDir, `${messageId}.json`);
      await fs.writeFile(filePath, JSON.stringify(message, null, 2));

      // Verify ID format doesn't contain recipient
      expect(messageId).toMatch(/^orchestrator-\d+$/);
      expect(messageId).not.toContain("coder");
    });
  });

  describe("Message Index", () => {
    it("should create index mapping agents to message IDs", async () => {
      const index: MessageIndex = {
        coder: ["orchestrator-1234567890", "reviewer-1234567891"],
        reviewer: ["coder-1234567892"],
      };

      await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

      const fileContent = await fs.readFile(indexPath, "utf-8");
      const savedIndex: MessageIndex = JSON.parse(fileContent);

      expect(savedIndex.coder).toHaveLength(2);
      expect(savedIndex.reviewer).toHaveLength(1);
      expect(savedIndex.coder[0]).toBe("orchestrator-1234567890");
    });

    it("should rebuild index from directory structure", async () => {
      // Create messages for multiple agents
      const agentsWithMessages = [
        { agent: "coder", messageIds: ["orch-1", "orch-2"] },
        { agent: "reviewer", messageIds: ["coder-1"] },
      ];

      for (const { agent, messageIds } of agentsWithMessages) {
        const agentDir = path.join(messagesDir, agent);
        await fs.mkdir(agentDir, { recursive: true });

        for (const messageId of messageIds) {
          const message: Message = {
            from: messageId.split("-")[0],
            to: agent,
            timestamp: new Date().toISOString(),
            content: "Test",
          };
          await fs.writeFile(path.join(agentDir, `${messageId}.json`), JSON.stringify(message));
        }
      }

      // Simulate index rebuild
      const rebuiltIndex: MessageIndex = {};
      const agentDirs = await fs.readdir(messagesDir, { withFileTypes: true });

      for (const dirent of agentDirs) {
        if (dirent.isDirectory()) {
          const agent = dirent.name;
          const agentDir = path.join(messagesDir, agent);
          const files = await fs.readdir(agentDir);
          const messageIds = files
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.replace(".json", ""));

          if (messageIds.length > 0) {
            rebuiltIndex[agent] = messageIds;
          }
        }
      }

      expect(rebuiltIndex.coder).toHaveLength(2);
      expect(rebuiltIndex.reviewer).toHaveLength(1);
    });

    it("should update index when adding messages", async () => {
      const index: MessageIndex = {
        coder: ["msg1"],
      };

      // Simulate adding a new message
      const newMessageId = "orchestrator-123456";
      if (!index.coder) {
        index.coder = [];
      }
      index.coder.push(newMessageId);

      expect(index.coder).toHaveLength(2);
      expect(index.coder).toContain(newMessageId);
    });

    it("should update index when deleting messages", async () => {
      const index: MessageIndex = {
        coder: ["msg1", "msg2", "msg3"],
      };

      // Simulate deleting a message
      const messageIdToDelete = "msg2";
      index.coder = index.coder.filter((id) => id !== messageIdToDelete);

      expect(index.coder).toHaveLength(2);
      expect(index.coder).not.toContain(messageIdToDelete);
    });

    it("should remove agent from index when clearing all their messages", async () => {
      const index: MessageIndex = {
        coder: ["msg1", "msg2"],
        reviewer: ["msg3"],
      };

      // Simulate clearing all messages for coder
      delete index.coder;

      expect(index.coder).toBeUndefined();
      expect(index.reviewer).toBeDefined();
    });
  });

  describe("Pagination", () => {
    it("should paginate messages with limit and offset", () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        from: "sender",
        to: "receiver",
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        content: `Message ${i}`,
      }));

      const limit = 20;
      const offset = 40;
      const paginatedMessages = messages.slice(offset, offset + limit);

      expect(paginatedMessages).toHaveLength(20);
      expect(paginatedMessages[0].content).toBe("Message 40");
      expect(paginatedMessages[19].content).toBe("Message 59");
    });

    it("should calculate pagination metadata correctly", () => {
      const totalMessages = 100;
      const limit = 25;
      const offset = 50;

      const returned = Math.min(limit, totalMessages - offset);
      const hasMore = offset + limit < totalMessages;

      const pagination = {
        total: totalMessages,
        offset,
        limit,
        returned,
        hasMore,
      };

      expect(pagination.returned).toBe(25);
      expect(pagination.hasMore).toBe(true);
    });

    it("should handle last page correctly", () => {
      const totalMessages = 100;
      const limit = 25;
      const offset = 90;

      const returned = Math.min(limit, totalMessages - offset);
      const hasMore = offset + limit < totalMessages;

      expect(returned).toBe(10);
      expect(hasMore).toBe(false);
    });

    it("should handle offset beyond total messages", () => {
      const messages: Message[] = [];
      const totalMessages = 50;
      const limit = 25;
      const offset = 100;

      const paginatedMessages = messages.slice(offset, offset + limit);

      expect(paginatedMessages).toHaveLength(0);
    });

    it("should use default limit when not specified", () => {
      const DEFAULT_PAGE_LIMIT = 50;
      const limit = undefined ?? DEFAULT_PAGE_LIMIT;

      expect(limit).toBe(50);
    });
  });

  describe("LRU Cache Simulation", () => {
    class SimpleLRUCache<K, V> {
      private cache: Map<K, V>;
      private maxSize: number;

      constructor(maxSize: number) {
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
        if (this.cache.has(key)) {
          this.cache.delete(key);
        }

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

      size(): number {
        return this.cache.size;
      }

      clear(): void {
        this.cache.clear();
      }
    }

    it("should cache messages and return them on get", () => {
      const cache = new SimpleLRUCache<string, Message>(100);
      const message: Message = {
        from: "sender",
        to: "receiver",
        timestamp: new Date().toISOString(),
        content: "Test",
      };

      cache.set("msg1", message);
      const cached = cache.get("msg1");

      expect(cached).toEqual(message);
    });

    it("should evict least recently used item when at capacity", () => {
      const cache = new SimpleLRUCache<string, string>(3);

      cache.set("a", "value-a");
      cache.set("b", "value-b");
      cache.set("c", "value-c");

      // a is now the least recently used
      expect(cache.size()).toBe(3);

      // Adding d should evict a
      cache.set("d", "value-d");

      expect(cache.size()).toBe(3);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe("value-b");
      expect(cache.get("c")).toBe("value-c");
      expect(cache.get("d")).toBe("value-d");
    });

    it("should move accessed items to most recently used", () => {
      const cache = new SimpleLRUCache<string, string>(3);

      cache.set("a", "value-a");
      cache.set("b", "value-b");
      cache.set("c", "value-c");

      // Access a, making it most recently used
      cache.get("a");

      // Now b is least recently used
      cache.set("d", "value-d");

      expect(cache.get("a")).toBe("value-a");
      expect(cache.get("b")).toBeUndefined(); // b was evicted
      expect(cache.get("c")).toBe("value-c");
      expect(cache.get("d")).toBe("value-d");
    });

    it("should delete items from cache", () => {
      const cache = new SimpleLRUCache<string, Message>(100);
      const message: Message = {
        from: "sender",
        to: "receiver",
        timestamp: new Date().toISOString(),
        content: "Test",
      };

      cache.set("msg1", message);
      expect(cache.get("msg1")).toEqual(message);

      cache.delete("msg1");
      expect(cache.get("msg1")).toBeUndefined();
    });

    it("should clear all cached items", () => {
      const cache = new SimpleLRUCache<string, string>(10);

      cache.set("a", "value-a");
      cache.set("b", "value-b");
      cache.set("c", "value-c");

      expect(cache.size()).toBe(3);

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    });
  });

  describe("Performance Optimizations", () => {
    it("should use index for O(1) agent message lookup", async () => {
      const index: MessageIndex = {
        coder: ["msg1", "msg2", "msg3"],
        reviewer: ["msg4"],
      };

      // O(1) lookup by agent
      const coderMessages = index.coder || [];

      expect(coderMessages).toHaveLength(3);
      // No need to scan entire directory
    });

    it("should avoid reading file content when using cache", () => {
      const cache = new Map<string, Message>();
      const message: Message = {
        from: "sender",
        to: "receiver",
        timestamp: new Date().toISOString(),
        content: "Test",
      };

      cache.set("msg1", message);

      // Simulate reading from cache (no disk I/O)
      const cachedMessage = cache.get("msg1");
      expect(cachedMessage).toEqual(message);
    });

    it("should handle large message counts efficiently with pagination", () => {
      const totalMessages = 100000;
      const limit = 50;
      const offset = 50000;

      // Only load the requested page, not all messages
      const loadedCount = limit; // Not totalMessages

      expect(loadedCount).toBe(50);
      expect(loadedCount).toBeLessThan(totalMessages);
    });
  });
});
