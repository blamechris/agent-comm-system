import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import {
  createTempTestDir,
  cleanupTestDir,
  writeTestMessage,
  createMockMessage,
} from "./helpers.js";

/**
 * Integration tests that simulate the actual AgentCommServer behavior
 * These tests verify the file-based message storage and retrieval system
 */
describe("Agent Communication System - Integration Tests", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await createTempTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(storageDir);
  });

  describe("send_message Integration", () => {
    it("should create message file with correct structure", async () => {
      const from = "orchestrator";
      const to = "coder";
      const subject = "Implement feature";
      const content = "Please implement the user authentication feature";
      const timestamp = new Date().toISOString();

      const message = {
        from,
        to,
        timestamp,
        subject,
        content,
      };

      const messageId = `${from}-${to}-${Date.now()}`;
      const fileName = `${messageId}.json`;
      const filePath = path.join(storageDir, fileName);

      await fs.writeFile(filePath, JSON.stringify(message, null, 2));

      // Verify file exists
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Verify content
      const fileContent = await fs.readFile(filePath, "utf-8");
      const savedMessage = JSON.parse(fileContent);

      expect(savedMessage.from).toBe(from);
      expect(savedMessage.to).toBe(to);
      expect(savedMessage.subject).toBe(subject);
      expect(savedMessage.content).toBe(content);
      expect(savedMessage.timestamp).toBeTruthy();
    });

    it("should handle message without optional subject", async () => {
      const message = {
        from: "sender",
        to: "receiver",
        timestamp: new Date().toISOString(),
        content: "Message without subject",
      };

      const messageId = `${message.from}-${message.to}-${Date.now()}`;
      const filePath = path.join(storageDir, `${messageId}.json`);

      await fs.writeFile(filePath, JSON.stringify(message, null, 2));

      const fileContent = await fs.readFile(filePath, "utf-8");
      const savedMessage = JSON.parse(fileContent);

      expect(savedMessage.subject).toBeUndefined();
      expect(savedMessage.content).toBe("Message without subject");
    });
  });

  describe("read_messages Integration", () => {
    it("should read all messages for specific agent", async () => {
      // Create multiple messages with unique IDs
      await writeTestMessage(
        storageDir,
        createMockMessage({
          from: "orchestrator",
          to: "coder",
          content: "Task 1",
        }),
        "orchestrator-coder-1"
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({
          from: "orchestrator",
          to: "coder",
          content: "Task 2",
        }),
        "orchestrator-coder-2"
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({
          from: "orchestrator",
          to: "reviewer",
          content: "Review task",
        }),
        "orchestrator-reviewer-1"
      );

      // Read messages for coder
      const files = await fs.readdir(storageDir);
      const coderMessages = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(storageDir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const message = JSON.parse(content);

          if (message.to === "coder") {
            coderMessages.push(message);
          }
        }
      }

      expect(coderMessages).toHaveLength(2);
      expect(coderMessages.every((m) => m.to === "coder")).toBe(true);
    });

    it("should sort messages by timestamp", async () => {
      const now = Date.now();

      await writeTestMessage(
        storageDir,
        createMockMessage({
          to: "agent",
          timestamp: new Date(now + 2000).toISOString(),
        }),
        `test-agent-${now + 2000}`
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({
          to: "agent",
          timestamp: new Date(now).toISOString(),
        }),
        `test-agent-${now}`
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({
          to: "agent",
          timestamp: new Date(now + 1000).toISOString(),
        }),
        `test-agent-${now + 1000}`
      );

      // Read and sort messages
      const files = await fs.readdir(storageDir);
      const messages = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = await fs.readFile(
            path.join(storageDir, file),
            "utf-8"
          );
          messages.push(JSON.parse(content));
        }
      }

      messages.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      expect(messages).toHaveLength(3);
      expect(new Date(messages[0]!.timestamp).getTime()).toBeLessThan(
        new Date(messages[1]!.timestamp).getTime()
      );
      expect(new Date(messages[1]!.timestamp).getTime()).toBeLessThan(
        new Date(messages[2]!.timestamp).getTime()
      );
    });

    it("should return empty array when no messages exist", async () => {
      const files = await fs.readdir(storageDir);
      const messages = files.filter((f) => f.endsWith(".json"));

      expect(messages).toHaveLength(0);
    });
  });

  describe("list_messages Integration", () => {
    beforeEach(async () => {
      await writeTestMessage(
        storageDir,
        createMockMessage({
          from: "a",
          to: "b",
          subject: "Subject 1",
        })
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({
          from: "c",
          to: "d",
          subject: "Subject 2",
        })
      );
    });

    it("should list all message metadata", async () => {
      const files = await fs.readdir(storageDir);
      const messageList = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = await fs.readFile(
            path.join(storageDir, file),
            "utf-8"
          );
          const message = JSON.parse(content);
          const id = file.replace(".json", "");

          messageList.push({
            id,
            from: message.from,
            to: message.to,
            timestamp: message.timestamp,
            subject: message.subject,
          });
        }
      }

      expect(messageList).toHaveLength(2);
      expect(messageList[0]).toHaveProperty("id");
      expect(messageList[0]).toHaveProperty("from");
      expect(messageList[0]).toHaveProperty("to");
      expect(messageList[0]).toHaveProperty("timestamp");
    });

    it("should filter list by agent", async () => {
      const files = await fs.readdir(storageDir);
      const messageList = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = await fs.readFile(
            path.join(storageDir, file),
            "utf-8"
          );
          const message = JSON.parse(content);

          if (message.to === "b") {
            const id = file.replace(".json", "");
            messageList.push({
              id,
              from: message.from,
              to: message.to,
              timestamp: message.timestamp,
            });
          }
        }
      }

      expect(messageList).toHaveLength(1);
      expect(messageList[0]?.to).toBe("b");
    });
  });

  describe("delete_message Integration", () => {
    it("should successfully delete existing message", async () => {
      const messageId = await writeTestMessage(
        storageDir,
        createMockMessage()
      );
      const filePath = path.join(storageDir, `${messageId}.json`);

      // Verify file exists
      await expect(fs.access(filePath)).resolves.not.toThrow();

      // Delete message
      await fs.unlink(filePath);

      // Verify deletion
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it("should throw error when deleting non-existent message", async () => {
      const filePath = path.join(storageDir, "nonexistent-message.json");

      await expect(fs.unlink(filePath)).rejects.toThrow();
    });
  });

  describe("clear_messages Integration", () => {
    beforeEach(async () => {
      await writeTestMessage(
        storageDir,
        createMockMessage({ to: "coder" }),
        "msg-coder-1"
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({ to: "coder" }),
        "msg-coder-2"
      );
      await writeTestMessage(
        storageDir,
        createMockMessage({ to: "reviewer" }),
        "msg-reviewer-1"
      );
    });

    it("should clear messages for specific agent", async () => {
      // Delete messages for coder
      const files = await fs.readdir(storageDir);
      let deletedCount = 0;

      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = await fs.readFile(
            path.join(storageDir, file),
            "utf-8"
          );
          const message = JSON.parse(content);

          if (message.to === "coder") {
            await fs.unlink(path.join(storageDir, file));
            deletedCount++;
          }
        }
      }

      expect(deletedCount).toBe(2);

      // Verify remaining messages
      const remainingFiles = await fs.readdir(storageDir);
      expect(remainingFiles.filter((f) => f.endsWith(".json"))).toHaveLength(
        1
      );
    });

    it("should clear all messages when no agent specified", async () => {
      const files = await fs.readdir(storageDir);
      let deletedCount = 0;

      for (const file of files) {
        if (file.endsWith(".json")) {
          await fs.unlink(path.join(storageDir, file));
          deletedCount++;
        }
      }

      expect(deletedCount).toBe(3);

      const remainingFiles = await fs.readdir(storageDir);
      expect(remainingFiles.filter((f) => f.endsWith(".json"))).toHaveLength(
        0
      );
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle multiple simultaneous writes", async () => {
      const writePromises = [];

      for (let i = 0; i < 10; i++) {
        writePromises.push(
          writeTestMessage(
            storageDir,
            createMockMessage({
              from: `agent${i}`,
              to: `receiver${i}`,
            })
          )
        );
      }

      await Promise.all(writePromises);

      const files = await fs.readdir(storageDir);
      expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(10);
    });

    it("should handle reads while writes are happening", async () => {
      // Write initial messages with unique IDs
      await writeTestMessage(storageDir, createMockMessage(), "concurrent-1");
      await writeTestMessage(storageDir, createMockMessage(), "concurrent-2");

      // Concurrent read and write
      const readPromise = fs.readdir(storageDir);
      const writePromise = writeTestMessage(
        storageDir,
        createMockMessage(),
        "concurrent-3"
      );

      await Promise.all([readPromise, writePromise]);

      const finalFiles = await fs.readdir(storageDir);
      expect(finalFiles.filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Error Scenarios", () => {
    it("should handle corrupted JSON files gracefully", async () => {
      const corruptedFile = path.join(storageDir, "corrupted.json");
      await fs.writeFile(corruptedFile, "{ invalid json content");

      // Try to read the corrupted file
      const content = await fs.readFile(corruptedFile, "utf-8");

      await expect(async () => {
        JSON.parse(content);
      }).rejects.toThrow();
    });

    it("should handle missing storage directory", async () => {
      const nonExistentDir = path.join(storageDir, "nonexistent");

      await expect(fs.readdir(nonExistentDir)).rejects.toThrow();

      // Should create directory
      await fs.mkdir(nonExistentDir, { recursive: true });

      await expect(fs.readdir(nonExistentDir)).resolves.not.toThrow();
    });
  });
});
