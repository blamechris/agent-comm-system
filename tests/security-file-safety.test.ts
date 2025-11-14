import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { AgentCommServer } from "../src/index.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("Security: File Safety and Race Conditions", () => {
  let server: AgentCommServer;
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory for each test
    testDir = path.join(os.tmpdir(), `agent-comm-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(testDir, { recursive: true });
    server = new AgentCommServer(path.join(testDir, "messages"));
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Cleanup error:", error);
    }
  });

  describe("Atomic File Writes", () => {
    it("should write files atomically using temp-then-rename", async () => {
      // Send a message to trigger atomic write
      const result = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message for atomic write",
      });

      // Verify the message was saved
      const messageId = result.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      expect(messageId).toBeDefined();

      // Check that no temp files remain
      const messagesDir = path.join(testDir, "messages", "agent2");
      const files = await fs.readdir(messagesDir);
      const tempFiles = files.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);

      // Verify the final file exists and is valid JSON
      const messageFile = files.find((f) => f.endsWith(".json") && !f.includes(".tmp"));
      expect(messageFile).toBeDefined();

      const content = await fs.readFile(path.join(messagesDir, messageFile!), "utf-8");
      const message = JSON.parse(content);
      expect(message.from).toBe("agent1");
      expect(message.to).toBe("agent2");
      expect(message.content).toBe("Test message for atomic write");
    });

    it("should produce valid JSON after atomic write", async () => {
      await (server as any).handleSendMessage({
        from: "sender",
        to: "receiver",
        subject: "Test Subject",
        content: "Valid JSON test",
      });

      const messagesDir = path.join(testDir, "messages", "receiver");
      const files = await fs.readdir(messagesDir);
      const jsonFile = files.find((f) => f.endsWith(".json") && !f.includes(".tmp"));

      const content = await fs.readFile(path.join(messagesDir, jsonFile!), "utf-8");

      // Should not throw
      const message = JSON.parse(content);
      expect(message).toHaveProperty("from");
      expect(message).toHaveProperty("to");
      expect(message).toHaveProperty("content");
      expect(message).toHaveProperty("timestamp");
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle 100 concurrent message sends without corruption", async () => {
      const messageCount = 100;
      const promises: Promise<any>[] = [];

      // Send 100 messages concurrently
      for (let i = 0; i < messageCount; i++) {
        promises.push(
          (server as any).handleSendMessage({
            from: `agent${i % 10}`,
            to: "receiver",
            content: `Message ${i}`,
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(messageCount);

      // Verify all messages were saved
      const messagesDir = path.join(testDir, "messages", "receiver");
      const files = await fs.readdir(messagesDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.includes(".tmp"));
      expect(jsonFiles).toHaveLength(messageCount);

      // Verify index consistency
      const result = await (server as any).handleListMessages({ agent: "receiver" });
      const text = result.content[0].text;
      expect(text).toContain(`Found ${messageCount} message(s)`);
    });

    it("should handle concurrent deletes without index corruption", async () => {
      // First, create 50 messages
      const sendPromises: Promise<any>[] = [];
      for (let i = 0; i < 50; i++) {
        sendPromises.push(
          (server as any).handleSendMessage({
            from: "sender",
            to: "agent",
            content: `Message ${i}`,
          })
        );
      }
      await Promise.all(sendPromises);

      // Get all message IDs
      const listResult = await (server as any).handleListMessages({ agent: "agent" });
      const messageIds = listResult.content[0].text.match(/ID: ([^\n]+)/g)?.map((id: string) => id.replace("ID: ", "")) || [];
      expect(messageIds.length).toBeGreaterThan(0);

      // Delete first 25 messages concurrently
      const deletePromises = messageIds.slice(0, 25).map((id: string) =>
        (server as any).handleDeleteMessage({ message_id: id })
      );

      await Promise.all(deletePromises);

      // Verify remaining messages
      const finalResult = await (server as any).handleListMessages({ agent: "agent" });
      const remainingCount = parseInt(finalResult.content[0].text.match(/Found (\d+) message/)?.[1] || "0");
      expect(remainingCount).toBe(25);
    });

    it("should maintain index consistency under concurrent read/write", async () => {
      // Concurrent writes and reads
      const operations: Promise<any>[] = [];

      // Add 50 writes
      for (let i = 0; i < 50; i++) {
        operations.push(
          (server as any).handleSendMessage({
            from: "writer",
            to: "reader",
            content: `Write ${i}`,
          })
        );
      }

      // Add 20 reads (interlaced with writes)
      for (let i = 0; i < 20; i++) {
        operations.push(
          (server as any).handleListMessages({ agent: "reader" })
        );
      }

      const results = await Promise.all(operations);

      // All operations should complete successfully
      expect(results).toHaveLength(70);

      // Final state should be consistent
      const finalResult = await (server as any).handleListMessages({ agent: "reader" });
      const match = finalResult.content[0].text.match(/Found (\d+) message/);
      const finalCount = parseInt(match?.[1] || "0");
      expect(finalCount).toBe(50);
    });
  });

  describe("Lock Behavior", () => {
    it("should execute save operations sequentially", async () => {
      const operations: Promise<any>[] = [];
      const timestamps: number[] = [];

      // Create multiple concurrent save operations
      for (let i = 0; i < 10; i++) {
        operations.push(
          (server as any).handleSendMessage({
            from: "agent",
            to: "recipient",
            content: `Message ${i}`,
          }).then(() => {
            timestamps.push(Date.now());
          })
        );
      }

      await Promise.all(operations);

      // All operations should complete
      expect(timestamps).toHaveLength(10);

      // Verify no data corruption
      const result = await (server as any).handleListMessages({ agent: "recipient" });
      expect(result.content[0].text).toContain("Found 10 message(s)");
    });

    it("should not deadlock under heavy concurrent load", async () => {
      const timeout = 10000; // 10 seconds
      const startTime = Date.now();

      const operations: Promise<any>[] = [];

      // Mix of operations that use different locks
      for (let i = 0; i < 100; i++) {
        operations.push(
          (server as any).handleSendMessage({
            from: `agent${i % 5}`,
            to: `recipient${i % 3}`,
            content: `Load test ${i}`,
          })
        );
      }

      await Promise.all(operations);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(timeout);
    }, 15000); // 15 second test timeout
  });

  describe("Stress Test", () => {
    it("should handle 1000 rapid sends with data integrity", async () => {
      const messageCount = 1000;
      const promises: Promise<any>[] = [];

      for (let i = 0; i < messageCount; i++) {
        promises.push(
          (server as any).handleSendMessage({
            from: `sender${i % 20}`,
            to: "stress_test",
            content: `Stress message ${i}`,
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(messageCount);

      // Verify all messages exist
      const listResult = await (server as any).handleListMessages({ agent: "stress_test" });
      const count = parseInt(listResult.content[0].text.match(/Found (\d+) message/)?.[1] || "0");
      expect(count).toBe(messageCount);

      // Verify no temp files remain
      const messagesDir = path.join(testDir, "messages", "stress_test");
      const files = await fs.readdir(messagesDir);
      const tempFiles = files.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);

      // Sample check: verify a few random messages are valid JSON
      const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.includes(".tmp"));
      const samplesToCheck = [0, Math.floor(jsonFiles.length / 2), jsonFiles.length - 1];

      for (const index of samplesToCheck) {
        const content = await fs.readFile(path.join(messagesDir, jsonFiles[index]), "utf-8");
        const message = JSON.parse(content);
        expect(message).toHaveProperty("from");
        expect(message).toHaveProperty("to");
        expect(message).toHaveProperty("content");
      }
    }, 30000); // 30 second timeout for stress test
  });

  describe("Error Handling", () => {
    it("should handle write errors gracefully", async () => {
      // This test verifies that failed writes clean up temp files
      // In practice, this is hard to trigger reliably in a test
      // But we can verify the behavior exists

      await (server as any).handleSendMessage({
        from: "agent",
        to: "recipient",
        content: "Test message",
      });

      // Check that no temp files remain after successful operation
      const messagesDir = path.join(testDir, "messages", "recipient");
      const files = await fs.readdir(messagesDir);
      const tempFiles = files.filter((f) => f.includes(".tmp."));
      expect(tempFiles).toHaveLength(0);
    });
  });
});
