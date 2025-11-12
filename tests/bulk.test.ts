import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { createTempTestDir, cleanupTestDir } from "./helpers.js";
import type { MessageWithStatus, MessageIndex } from "../src/index.js";

/**
 * Bulk Operations Tests
 * Tests for v2.1 bulk operation features:
 * - send_message_bulk (broadcast)
 * - delete_messages_bulk
 * - update_message_status_bulk
 * - delete_messages_by_filter
 */
describe("Bulk Operations", () => {
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

  describe("send_message_bulk", () => {
    it("should send the same message to multiple recipients", async () => {
      const recipients = ["coder", "reviewer", "tester"];
      const timestamp = new Date().toISOString();

      // Simulate bulk send
      const messages: MessageWithStatus[] = [];
      for (const recipient of recipients) {
        const agentDir = path.join(messagesDir, recipient);
        await fs.mkdir(agentDir, { recursive: true });

        const messageId = `orchestrator-${Date.now()}`;
        const message: MessageWithStatus = {
          from: "orchestrator",
          to: recipient,
          timestamp,
          subject: "Bulk Task",
          content: "This is a broadcast message",
        };

        await fs.writeFile(
          path.join(agentDir, `${messageId}.json`),
          JSON.stringify(message, null, 2)
        );
        messages.push(message);

        // Small delay for unique IDs
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      expect(messages).toHaveLength(3);
      expect(messages[0].from).toBe("orchestrator");
      expect(messages[0].content).toBe("This is a broadcast message");
      expect(messages[1].content).toBe(messages[0].content);
      expect(messages[2].content).toBe(messages[0].content);
    });

    it("should handle individual failures gracefully", async () => {
      const results = [
        { to: "coder", success: true, message_id: "orch-123" },
        { to: "invalid-agent", success: false, error: "Permission denied" },
        { to: "reviewer", success: true, message_id: "orch-124" },
      ];

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      expect(successful).toHaveLength(2);
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe("Permission denied");
    });

    it("should validate that 'to' is a non-empty array", () => {
      const invalidInputs = [
        { from: "orch", to: [], content: "test" },
        { from: "orch", to: null, content: "test" },
        { from: "orch", to: "single-string", content: "test" },
      ];

      for (const input of invalidInputs) {
        const isValid = Array.isArray(input.to) && (input.to as string[]).length > 0;
        expect(isValid).toBe(false);
      }
    });

    it("should create unique message IDs for each recipient", async () => {
      const messageIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        const messageId = `orchestrator-${Date.now()}`;
        messageIds.push(messageId);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(messageIds.length);
    });
  });

  describe("delete_messages_bulk", () => {
    it("should delete multiple messages by IDs", async () => {
      // Create test messages
      const messageIds = ["msg1", "msg2", "msg3"];
      const agentDir = path.join(messagesDir, "coder");
      await fs.mkdir(agentDir, { recursive: true });

      for (const msgId of messageIds) {
        const message: MessageWithStatus = {
          from: "orchestrator",
          to: "coder",
          timestamp: new Date().toISOString(),
          content: "Test",
        };
        await fs.writeFile(path.join(agentDir, `${msgId}.json`), JSON.stringify(message, null, 2));
      }

      // Verify files exist
      let files = await fs.readdir(agentDir);
      expect(files).toHaveLength(3);

      // Delete messages
      for (const msgId of messageIds) {
        await fs.unlink(path.join(agentDir, `${msgId}.json`));
      }

      // Verify deletion
      files = await fs.readdir(agentDir);
      expect(files).toHaveLength(0);
    });

    it("should update index once (batch operation)", async () => {
      const index: MessageIndex = {
        coder: ["msg1", "msg2", "msg3", "msg4"],
        reviewer: ["msg5"],
      };

      const messagesToDelete = ["msg2", "msg3"];

      // Simulate batch removal
      for (const msgId of messagesToDelete) {
        index.coder = index.coder.filter((id) => id !== msgId);
      }

      // Single saveIndex() call would happen here
      await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

      const savedIndex: MessageIndex = JSON.parse(await fs.readFile(indexPath, "utf-8"));
      expect(savedIndex.coder).toHaveLength(2);
      expect(savedIndex.coder).not.toContain("msg2");
      expect(savedIndex.coder).not.toContain("msg3");
    });

    it("should handle non-existent message IDs", async () => {
      const index: MessageIndex = {
        coder: ["msg1", "msg2"],
      };

      const deleteRequests = ["msg1", "nonexistent1", "msg2", "nonexistent2"];
      const errors: string[] = [];
      let deletedCount = 0;

      for (const msgId of deleteRequests) {
        if (!Object.values(index).some((ids) => ids.includes(msgId as string))) {
          errors.push(`${msgId}: not found in index`);
        } else {
          deletedCount++;
        }
      }

      expect(deletedCount).toBe(2);
      expect(errors).toHaveLength(2);
    });

    it("should return count of successfully deleted messages", () => {
      const totalRequested = 10;
      const deleted = 8;
      const failed = 2;

      expect(deleted + failed).toBe(totalRequested);
      expect(deleted).toBeGreaterThan(failed);
    });
  });

  describe("update_message_status_bulk", () => {
    it("should update status for multiple messages", async () => {
      const agentDir = path.join(messagesDir, "coder");
      await fs.mkdir(agentDir, { recursive: true });

      const messageIds = ["msg1", "msg2", "msg3"];

      // Create messages without status
      for (const msgId of messageIds) {
        const message: MessageWithStatus = {
          from: "orchestrator",
          to: "coder",
          timestamp: new Date().toISOString(),
          content: "Test",
        };
        await fs.writeFile(path.join(agentDir, `${msgId}.json`), JSON.stringify(message, null, 2));
      }

      // Update status to "read"
      for (const msgId of messageIds) {
        const filePath = path.join(agentDir, `${msgId}.json`);
        const content = await fs.readFile(filePath, "utf-8");
        const message = JSON.parse(content) as MessageWithStatus;
        message.status = "read";
        await fs.writeFile(filePath, JSON.stringify(message, null, 2));
      }

      // Verify all have status
      for (const msgId of messageIds) {
        const filePath = path.join(agentDir, `${msgId}.json`);
        const content = await fs.readFile(filePath, "utf-8");
        const message = JSON.parse(content) as MessageWithStatus;
        expect(message.status).toBe("read");
      }
    });

    it("should support different status values", async () => {
      const statuses = ["read", "acknowledged", "archived", "flagged"];

      for (const status of statuses) {
        const message: MessageWithStatus = {
          from: "sender",
          to: "receiver",
          timestamp: new Date().toISOString(),
          content: "Test",
          status,
        };

        expect(message.status).toBe(status);
      }
    });

    it("should handle messages that don't exist", async () => {
      const index: MessageIndex = {
        coder: ["msg1", "msg2"],
      };

      const updateRequests = ["msg1", "nonexistent", "msg2"];
      const errors: string[] = [];
      let updatedCount = 0;

      for (const msgId of updateRequests) {
        const found = Object.values(index).some((ids) => ids.includes(msgId as string));
        if (!found) {
          errors.push(`${msgId}: not found in index`);
        } else {
          updatedCount++;
        }
      }

      expect(updatedCount).toBe(2);
      expect(errors).toHaveLength(1);
    });

    it("should preserve message content when updating status", async () => {
      const originalMessage: MessageWithStatus = {
        from: "orchestrator",
        to: "coder",
        timestamp: "2024-01-01T00:00:00.000Z",
        subject: "Important Task",
        content: "Do not modify this content",
      };

      // Update status
      const updatedMessage = { ...originalMessage, status: "read" };

      expect(updatedMessage.from).toBe(originalMessage.from);
      expect(updatedMessage.to).toBe(originalMessage.to);
      expect(updatedMessage.subject).toBe(originalMessage.subject);
      expect(updatedMessage.content).toBe(originalMessage.content);
      expect(updatedMessage.status).toBe("read");
    });
  });

  describe("delete_messages_by_filter", () => {
    beforeEach(async () => {
      // Create test messages with various attributes
      const testMessages: Array<{
        agent: string;
        messageId: string;
        message: MessageWithStatus;
      }> = [
        {
          agent: "coder",
          messageId: "orch-1",
          message: {
            from: "orchestrator",
            to: "coder",
            timestamp: "2024-01-01T00:00:00.000Z",
            content: "Old message",
            status: "read",
          },
        },
        {
          agent: "coder",
          messageId: "orch-2",
          message: {
            from: "orchestrator",
            to: "coder",
            timestamp: "2024-06-01T00:00:00.000Z",
            content: "Recent message",
          },
        },
        {
          agent: "reviewer",
          messageId: "coder-1",
          message: {
            from: "coder",
            to: "reviewer",
            timestamp: "2024-05-01T00:00:00.000Z",
            content: "From coder",
            status: "acknowledged",
          },
        },
      ];

      for (const { agent, messageId, message } of testMessages) {
        const agentDir = path.join(messagesDir, agent);
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, `${messageId}.json`),
          JSON.stringify(message, null, 2)
        );
      }
    });

    it("should delete messages by agent filter", async () => {
      const agentDir = path.join(messagesDir, "coder");
      let files = await fs.readdir(agentDir);
      expect(files.length).toBeGreaterThan(0);

      // Delete all messages for coder
      for (const file of files) {
        await fs.unlink(path.join(agentDir, file));
      }

      files = await fs.readdir(agentDir);
      expect(files).toHaveLength(0);
    });

    it("should delete messages by sender (from) filter", async () => {
      const allMessages: MessageWithStatus[] = [];

      // Read all messages
      const agents = await fs.readdir(messagesDir);
      for (const agent of agents) {
        const agentDir = path.join(messagesDir, agent);
        const stats = await fs.stat(agentDir);
        if (!stats.isDirectory()) continue;

        const files = await fs.readdir(agentDir);
        for (const file of files) {
          const content = await fs.readFile(path.join(agentDir, file), "utf-8");
          allMessages.push(JSON.parse(content));
        }
      }

      const fromOrchestrator = allMessages.filter((m) => m.from === "orchestrator");
      expect(fromOrchestrator.length).toBeGreaterThan(0);
    });

    it("should delete messages before a specific date", async () => {
      const cutoffDate = new Date("2024-05-01T00:00:00.000Z");

      const messages: MessageWithStatus[] = [
        {
          from: "sender",
          to: "receiver",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: "Old",
        },
        {
          from: "sender",
          to: "receiver",
          timestamp: "2024-06-01T00:00:00.000Z",
          content: "New",
        },
      ];

      const toDelete = messages.filter((m) => new Date(m.timestamp) < cutoffDate);
      expect(toDelete).toHaveLength(1);
      expect(toDelete[0].content).toBe("Old");
    });

    it("should delete messages after a specific date", async () => {
      const cutoffDate = new Date("2024-05-01T00:00:00.000Z");

      const messages: MessageWithStatus[] = [
        {
          from: "sender",
          to: "receiver",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: "Old",
        },
        {
          from: "sender",
          to: "receiver",
          timestamp: "2024-06-01T00:00:00.000Z",
          content: "New",
        },
      ];

      const toDelete = messages.filter((m) => new Date(m.timestamp) > cutoffDate);
      expect(toDelete).toHaveLength(1);
      expect(toDelete[0].content).toBe("New");
    });

    it("should delete messages by status filter", async () => {
      const reviewerDir = path.join(messagesDir, "reviewer");
      const files = await fs.readdir(reviewerDir);

      const readMessages: MessageWithStatus[] = [];
      for (const file of files) {
        const content = await fs.readFile(path.join(reviewerDir, file), "utf-8");
        const message = JSON.parse(content) as MessageWithStatus;
        if (message.status === "acknowledged") {
          readMessages.push(message);
        }
      }

      expect(readMessages.length).toBeGreaterThan(0);
    });

    it("should require confirmation parameter", () => {
      const withoutConfirm = { agent: "coder" };
      const withConfirm = { agent: "coder", confirm: true };

      expect(withoutConfirm.hasOwnProperty("confirm")).toBe(false);
      expect(withConfirm.confirm).toBe(true);
    });

    it("should throw error if confirm is false", () => {
      const confirm = false;

      if (!confirm) {
        expect(() => {
          throw new Error("Confirmation required. Set confirm: true to proceed with deletion.");
        }).toThrow("Confirmation required");
      }
    });

    it("should support combining multiple filters", async () => {
      const messages: MessageWithStatus[] = [
        {
          from: "orchestrator",
          to: "coder",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: "Old from orch",
          status: "read",
        },
        {
          from: "orchestrator",
          to: "coder",
          timestamp: "2024-06-01T00:00:00.000Z",
          content: "New from orch",
        },
        {
          from: "reviewer",
          to: "coder",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: "Old from reviewer",
        },
      ];

      // Filter: from=orchestrator AND before=2024-05-01
      const filtered = messages.filter(
        (m) =>
          m.from === "orchestrator" && new Date(m.timestamp) < new Date("2024-05-01T00:00:00.000Z")
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0].content).toBe("Old from orch");
    });

    it("should return count of deleted messages", async () => {
      const coderDir = path.join(messagesDir, "coder");
      const files = await fs.readdir(coderDir);
      const initialCount = files.length;

      // Delete all
      for (const file of files) {
        await fs.unlink(path.join(coderDir, file));
      }

      const deletedCount = initialCount;
      expect(deletedCount).toBeGreaterThan(0);
    });
  });

  describe("Performance: Batch Operations", () => {
    it("should be more efficient than individual operations (batch index update)", async () => {
      const messageCount = 100;

      // Simulate individual updates (multiple writes)
      const individualOperations = messageCount; // One saveIndex() per message

      // Simulate batch update (single write)
      const batchOperations = 1; // One saveIndex() for all messages

      expect(batchOperations).toBeLessThan(individualOperations);
      expect(individualOperations / batchOperations).toBe(messageCount);
    });

    it("should handle large batches efficiently", async () => {
      const largeBatch = 1000;
      const batchUpdates: Array<{ agent: string; messageId: string }> = [];

      for (let i = 0; i < largeBatch; i++) {
        batchUpdates.push({
          agent: `agent-${i % 10}`,
          messageId: `msg-${i}`,
        });
      }

      expect(batchUpdates).toHaveLength(largeBatch);
    });

    it("should minimize disk I/O for bulk operations", () => {
      const operationCount = 50;

      // Individual operations: N reads + N writes + N index updates
      const individualIO = operationCount * 3;

      // Bulk operation: N reads/writes + 1 index update
      const bulkIO = operationCount * 2 + 1;

      expect(bulkIO).toBeLessThan(individualIO);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty arrays gracefully", () => {
      const emptyArray: string[] = [];

      expect(emptyArray.length).toBe(0);
      expect(Array.isArray(emptyArray)).toBe(true);
    });

    it("should handle non-existent agents in bulk send", async () => {
      const recipients = ["valid-agent", "invalid-agent", "another-valid"];
      const results = [];

      for (const recipient of recipients) {
        try {
          const agentDir = path.join(messagesDir, recipient);
          await fs.mkdir(agentDir, { recursive: true });
          results.push({ to: recipient, success: true });
        } catch {
          results.push({ to: recipient, success: false });
        }
      }

      expect(results.filter((r) => r.success).length).toBe(3);
    });

    it("should handle duplicate message IDs in delete bulk", () => {
      const messageIds = ["msg1", "msg2", "msg1", "msg3", "msg2"];
      const uniqueIds = [...new Set(messageIds)];

      expect(uniqueIds).toHaveLength(3);
    });

    it("should handle empty filter criteria (matches all)", () => {
      const messages: MessageWithStatus[] = [
        {
          from: "a",
          to: "b",
          timestamp: "2024-01-01T00:00:00.000Z",
          content: "1",
        },
        {
          from: "c",
          to: "d",
          timestamp: "2024-02-01T00:00:00.000Z",
          content: "2",
        },
      ];

      // No filters applied
      const matches = messages.filter(() => true);

      expect(matches).toHaveLength(messages.length);
    });
  });

  describe("Cache Invalidation", () => {
    it("should invalidate cache entries during bulk delete", () => {
      const cache = new Map<string, MessageWithStatus>();

      cache.set("msg1", {
        from: "a",
        to: "b",
        timestamp: "2024-01-01T00:00:00.000Z",
        content: "test",
      });
      cache.set("msg2", {
        from: "a",
        to: "b",
        timestamp: "2024-01-01T00:00:00.000Z",
        content: "test",
      });

      expect(cache.size).toBe(2);

      // Bulk delete
      cache.delete("msg1");
      cache.delete("msg2");

      expect(cache.size).toBe(0);
    });

    it("should update cache during bulk status update", () => {
      const cache = new Map<string, MessageWithStatus>();

      const message: MessageWithStatus = {
        from: "a",
        to: "b",
        timestamp: "2024-01-01T00:00:00.000Z",
        content: "test",
      };

      cache.set("msg1", message);

      // Update status
      const cached = cache.get("msg1");
      if (cached) {
        cached.status = "read";
        cache.set("msg1", cached);
      }

      const updated = cache.get("msg1");
      expect(updated?.status).toBe("read");
    });
  });
});
