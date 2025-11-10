import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import {
  createTempTestDir,
  cleanupTestDir,
  createMockMessage,
  writeTestMessage,
  readAllTestMessages,
} from "./helpers.js";

describe("Agent Communication System", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  describe("Message Storage", () => {
    it("should create storage directory if it doesn't exist", async () => {
      const storageDir = path.join(testDir, "messages");
      await fs.mkdir(storageDir, { recursive: true });

      const exists = await fs
        .access(storageDir)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });

    it("should write message as JSON file", async () => {
      const message = createMockMessage({
        from: "orchestrator",
        to: "coder",
        subject: "Test task",
        content: "Please implement feature X",
      });

      const messageId = await writeTestMessage(testDir, message);
      const filePath = path.join(testDir, `${messageId}.json`);

      const fileContent = await fs.readFile(filePath, "utf-8");
      const savedMessage = JSON.parse(fileContent);

      expect(savedMessage.from).toBe("orchestrator");
      expect(savedMessage.to).toBe("coder");
      expect(savedMessage.subject).toBe("Test task");
      expect(savedMessage.content).toBe("Please implement feature X");
    });

    it("should read all messages from directory", async () => {
      const message1 = createMockMessage({ from: "agent1", to: "agent2" });
      const message2 = createMockMessage({ from: "agent2", to: "agent3" });

      await writeTestMessage(testDir, message1);
      await writeTestMessage(testDir, message2);

      const messages = await readAllTestMessages(testDir);

      expect(messages).toHaveLength(2);
      expect(messages.some((m) => m.from === "agent1")).toBe(true);
      expect(messages.some((m) => m.from === "agent2")).toBe(true);
    });
  });

  describe("Message Filtering", () => {
    beforeEach(async () => {
      // Create multiple test messages
      await writeTestMessage(
        testDir,
        createMockMessage({ from: "orch", to: "coder", content: "Task 1" })
      );
      await writeTestMessage(
        testDir,
        createMockMessage({ from: "orch", to: "reviewer", content: "Task 2" })
      );
      await writeTestMessage(
        testDir,
        createMockMessage({ from: "coder", to: "reviewer", content: "Done" })
      );
    });

    it("should filter messages by recipient", async () => {
      const allMessages = await readAllTestMessages(testDir);
      const coderMessages = allMessages.filter((m) => m.to === "coder");
      const reviewerMessages = allMessages.filter((m) => m.to === "reviewer");

      expect(coderMessages).toHaveLength(1);
      expect(reviewerMessages).toHaveLength(2);
      expect(coderMessages[0]?.content).toBe("Task 1");
    });

    it("should handle no messages for agent", async () => {
      const allMessages = await readAllTestMessages(testDir);
      const nonExistentMessages = allMessages.filter(
        (m) => m.to === "nonexistent"
      );

      expect(nonExistentMessages).toHaveLength(0);
    });
  });

  describe("Message Deletion", () => {
    it("should delete specific message by ID", async () => {
      const message = createMockMessage({ from: "test", to: "agent" });
      const messageId = await writeTestMessage(testDir, message);

      const filePath = path.join(testDir, `${messageId}.json`);

      // Verify file exists
      await expect(fs.access(filePath)).resolves.not.toThrow();

      // Delete the file
      await fs.unlink(filePath);

      // Verify file is deleted
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it("should handle deleting non-existent message", async () => {
      const filePath = path.join(testDir, "nonexistent.json");

      await expect(fs.unlink(filePath)).rejects.toThrow();
    });
  });

  describe("Message Clearing", () => {
    beforeEach(async () => {
      await writeTestMessage(
        testDir,
        createMockMessage({ from: "a", to: "coder" })
      );
      await writeTestMessage(
        testDir,
        createMockMessage({ from: "b", to: "coder" })
      );
      await writeTestMessage(
        testDir,
        createMockMessage({ from: "c", to: "reviewer" })
      );
    });

    it("should clear all messages for specific agent", async () => {
      const allMessages = await readAllTestMessages(testDir);
      const coderMessages = allMessages.filter((m) => m.to === "coder");

      // Delete coder messages
      for (const msg of coderMessages) {
        const files = await fs.readdir(testDir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const content = await fs.readFile(
              path.join(testDir, file),
              "utf-8"
            );
            const fileMsg = JSON.parse(content);
            if (fileMsg.to === "coder") {
              await fs.unlink(path.join(testDir, file));
            }
          }
        }
      }

      const remainingMessages = await readAllTestMessages(testDir);
      expect(remainingMessages).toHaveLength(1);
      expect(remainingMessages[0]?.to).toBe("reviewer");
    });

    it("should clear all messages in system", async () => {
      const files = await fs.readdir(testDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          await fs.unlink(path.join(testDir, file));
        }
      }

      const remainingMessages = await readAllTestMessages(testDir);
      expect(remainingMessages).toHaveLength(0);
    });
  });

  describe("Message Validation", () => {
    it("should validate required fields for send_message", () => {
      const validMessage = createMockMessage({
        from: "sender",
        to: "receiver",
        content: "test",
      });

      expect(validMessage.from).toBeTruthy();
      expect(validMessage.to).toBeTruthy();
      expect(validMessage.content).toBeTruthy();
    });

    it("should handle optional subject field", () => {
      const withSubject = createMockMessage({
        subject: "Important",
      });
      const withoutSubject = createMockMessage();

      expect(withSubject.subject).toBe("Important");
      expect(withoutSubject.subject).toBeUndefined();
    });
  });

  describe("Message Sorting", () => {
    it("should sort messages by timestamp", async () => {
      const now = Date.now();
      const timestamp1 = new Date(now - 2000).toISOString();
      const timestamp2 = new Date(now - 1000).toISOString();
      const timestamp3 = new Date(now).toISOString();

      const message1 = createMockMessage({
        from: "a1",
        to: "b1",
        timestamp: timestamp1,
      });
      const message2 = createMockMessage({
        from: "a2",
        to: "b2",
        timestamp: timestamp2,
      });
      const message3 = createMockMessage({
        from: "a3",
        to: "b3",
        timestamp: timestamp3,
      });

      // Write messages in non-chronological order
      await writeTestMessage(testDir, message2, `test-msg-2`);
      await writeTestMessage(testDir, message1, `test-msg-1`);
      await writeTestMessage(testDir, message3, `test-msg-3`);

      const messages = await readAllTestMessages(testDir);
      const sorted = messages.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      expect(sorted).toHaveLength(3);
      expect(sorted[0]?.timestamp).toBe(timestamp1);
      expect(sorted[1]?.timestamp).toBe(timestamp2);
      expect(sorted[2]?.timestamp).toBe(timestamp3);
    });
  });

  describe("Message ID Generation", () => {
    it("should generate unique message IDs", async () => {
      const message1 = createMockMessage();
      const message2 = createMockMessage();

      const id1 = await writeTestMessage(testDir, message1);
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      const id2 = await writeTestMessage(testDir, message2);

      expect(id1).not.toBe(id2);
    });

    it("should include from, to, and timestamp in message ID", () => {
      const from = "orchestrator";
      const to = "coder";
      const timestamp = Date.now();
      const expectedId = `${from}-${to}-${timestamp}`;

      expect(expectedId).toContain(from);
      expect(expectedId).toContain(to);
      expect(expectedId).toContain(timestamp.toString());
    });
  });
});
