import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { AgentCommServer } from "../src/index.js";

describe("Message Acknowledgment System", () => {
  let server: AgentCommServer;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = path.join(os.tmpdir(), `agent-comm-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Initialize server with test directory
    server = new AgentCommServer(path.join(testDir, "messages"));
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Default Status", () => {
    it("should set status to 'unread' when sending a message", async () => {
      const result = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");

      // Read the message to verify status
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: unread");
    });

    it("should create message with unread status in file", async () => {
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
        subject: "Test",
      });

      const messageDir = path.join(testDir, "messages", "agent2");
      const files = await fs.readdir(messageDir);
      const messageFile = files[0];
      const messageContent = await fs.readFile(path.join(messageDir, messageFile), "utf-8");
      const message = JSON.parse(messageContent);

      expect(message.status).toBe("unread");
    });
  });

  describe("mark_message_read", () => {
    it("should mark a message as read", async () => {
      // Send a message
      const sendResult = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = sendResult.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      expect(messageId).toBeDefined();

      // Mark as read
      const markResult = await (server as any).handleMarkMessageRead({
        message_id: messageId,
      });

      expect(markResult.content[0].text).toBe(`Message ${messageId} marked as read`);

      // Verify status changed
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: read");
    });

    it("should update the message file with read status", async () => {
      // Send a message
      const sendResult = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = sendResult.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // Mark as read
      await (server as any).handleMarkMessageRead({
        message_id: messageId,
      });

      // Verify file was updated
      const messageDir = path.join(testDir, "messages", "agent2");
      const messageFile = `${messageId}.json`;
      const messageContent = await fs.readFile(path.join(messageDir, messageFile), "utf-8");
      const message = JSON.parse(messageContent);

      expect(message.status).toBe("read");
    });

    it("should throw error for non-existent message", async () => {
      await expect(
        (server as any).handleMarkMessageRead({
          message_id: "non-existent-123",
        })
      ).rejects.toThrow("Message non-existent-123 not found");
    });

    it("should throw error when message_id is missing", async () => {
      await expect((server as any).handleMarkMessageRead({})).rejects.toThrow(
        "Missing required parameter: message_id"
      );
    });
  });

  describe("mark_message_acknowledged", () => {
    it("should mark a message as acknowledged", async () => {
      // Send a message
      const sendResult = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = sendResult.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      expect(messageId).toBeDefined();

      // Mark as acknowledged
      const markResult = await (server as any).handleMarkMessageAcknowledged({
        message_id: messageId,
      });

      expect(markResult.content[0].text).toBe(`Message ${messageId} marked as acknowledged`);

      // Verify status changed
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: acknowledged");
    });

    it("should update the message file with acknowledged status", async () => {
      // Send a message
      const sendResult = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = sendResult.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // Mark as acknowledged
      await (server as any).handleMarkMessageAcknowledged({
        message_id: messageId,
      });

      // Verify file was updated
      const messageDir = path.join(testDir, "messages", "agent2");
      const messageFile = `${messageId}.json`;
      const messageContent = await fs.readFile(path.join(messageDir, messageFile), "utf-8");
      const message = JSON.parse(messageContent);

      expect(message.status).toBe("acknowledged");
    });

    it("should throw error for non-existent message", async () => {
      await expect(
        (server as any).handleMarkMessageAcknowledged({
          message_id: "non-existent-123",
        })
      ).rejects.toThrow("Message non-existent-123 not found");
    });

    it("should throw error when message_id is missing", async () => {
      await expect((server as any).handleMarkMessageAcknowledged({})).rejects.toThrow(
        "Missing required parameter: message_id"
      );
    });
  });

  describe("get_unread_count", () => {
    it("should return 0 for agent with no messages", async () => {
      const result = await (server as any).handleGetUnreadCount({
        agent: "agent1",
      });

      expect(result.content[0].text).toBe("Agent agent1 has 0 unread messages");
    });

    it("should count unread messages correctly", async () => {
      // Send 3 messages
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 3",
      });

      const result = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(result.content[0].text).toBe("Agent agent2 has 3 unread messages");
    });

    it("should not count read messages", async () => {
      // Send 3 messages
      const msg1 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 3",
      });

      const messageId = msg1.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // Mark one as read
      await (server as any).handleMarkMessageRead({
        message_id: messageId,
      });

      const result = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(result.content[0].text).toBe("Agent agent2 has 2 unread messages");
    });

    it("should not count acknowledged messages", async () => {
      // Send 3 messages
      const msg1 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      const msg2 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 3",
      });

      const messageId1 = msg1.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      const messageId2 = msg2.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // Mark one as read and one as acknowledged
      await (server as any).handleMarkMessageRead({
        message_id: messageId1,
      });
      await (server as any).handleMarkMessageAcknowledged({
        message_id: messageId2,
      });

      const result = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(result.content[0].text).toBe("Agent agent2 has 1 unread message");
    });

    it("should throw error when agent parameter is missing", async () => {
      await expect((server as any).handleGetUnreadCount({})).rejects.toThrow(
        "Missing required parameter: agent"
      );
    });

    it("should handle singular/plural correctly", async () => {
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });

      const result = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(result.content[0].text).toBe("Agent agent2 has 1 unread message");
    });
  });

  describe("read_messages with status filter", () => {
    beforeEach(async () => {
      // Create messages with different statuses
      const msg1 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      const msg2 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });
      const msg3 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 3",
      });

      const messageId1 = msg1.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      const messageId2 = msg2.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      await (server as any).handleMarkMessageRead({ message_id: messageId1 });
      await (server as any).handleMarkMessageAcknowledged({ message_id: messageId2 });
    });

    it("should filter messages by unread status", async () => {
      const result = await (server as any).handleReadMessages({
        agent: "agent2",
        status: "unread",
      });

      expect(result.content[0].text).toContain('1 message(s) for agent2 with status "unread"');
      expect(result.content[0].text).toContain("Content:\nMessage 3");
      expect(result.content[0].text).not.toContain("Content:\nMessage 1");
      expect(result.content[0].text).not.toContain("Content:\nMessage 2");
    });

    it("should filter messages by read status", async () => {
      const result = await (server as any).handleReadMessages({
        agent: "agent2",
        status: "read",
      });

      expect(result.content[0].text).toContain('1 message(s) for agent2 with status "read"');
      expect(result.content[0].text).toContain("Content:\nMessage 1");
      expect(result.content[0].text).not.toContain("Content:\nMessage 2");
      expect(result.content[0].text).not.toContain("Content:\nMessage 3");
    });

    it("should filter messages by acknowledged status", async () => {
      const result = await (server as any).handleReadMessages({
        agent: "agent2",
        status: "acknowledged",
      });

      expect(result.content[0].text).toContain(
        '1 message(s) for agent2 with status "acknowledged"'
      );
      expect(result.content[0].text).toContain("Content:\nMessage 2");
      expect(result.content[0].text).not.toContain("Content:\nMessage 1");
      expect(result.content[0].text).not.toContain("Content:\nMessage 3");
    });

    it("should return all messages when no status filter is provided", async () => {
      const result = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(result.content[0].text).toContain("3 message(s) for agent2");
      expect(result.content[0].text).toContain("Content:\nMessage 1");
      expect(result.content[0].text).toContain("Content:\nMessage 2");
      expect(result.content[0].text).toContain("Content:\nMessage 3");
    });
  });

  describe("read_messages with mark_as_read option", () => {
    it("should mark unread messages as read when mark_as_read is true", async () => {
      // Send messages
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });

      // Read with mark_as_read
      await (server as any).handleReadMessages({
        agent: "agent2",
        mark_as_read: true,
      });

      // Verify all messages are now read
      const unreadCount = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(unreadCount.content[0].text).toBe("Agent agent2 has 0 unread messages");
    });

    it("should not mark messages as read when mark_as_read is false", async () => {
      // Send messages
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });

      // Read without mark_as_read
      await (server as any).handleReadMessages({
        agent: "agent2",
        mark_as_read: false,
      });

      // Verify messages are still unread
      const unreadCount = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(unreadCount.content[0].text).toBe("Agent agent2 has 2 unread messages");
    });

    it("should not mark acknowledged messages as read", async () => {
      // Send message and mark as acknowledged
      const msg = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });

      const messageId = msg.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      await (server as any).handleMarkMessageAcknowledged({ message_id: messageId });

      // Read with mark_as_read
      await (server as any).handleReadMessages({
        agent: "agent2",
        mark_as_read: true,
      });

      // Verify status is still acknowledged
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: acknowledged");
    });

    it("should work with pagination", async () => {
      // Send 3 messages
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 3",
      });

      // Read first 2 with mark_as_read
      await (server as any).handleReadMessages({
        agent: "agent2",
        limit: 2,
        mark_as_read: true,
      });

      // Verify only 1 message is still unread
      const unreadCount = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(unreadCount.content[0].text).toBe("Agent agent2 has 1 unread message");
    });
  });

  describe("Backward Compatibility", () => {
    it("should treat messages without status field as unread", async () => {
      // Manually create a message without status field
      const messageId = "agent1-" + Date.now();
      const messageDir = path.join(testDir, "messages", "agent2");
      await fs.mkdir(messageDir, { recursive: true });

      const message = {
        from: "agent1",
        to: "agent2",
        timestamp: new Date().toISOString(),
        content: "Old message without status",
      };

      await fs.writeFile(
        path.join(messageDir, `${messageId}.json`),
        JSON.stringify(message, null, 2)
      );

      // Update index
      await (server as any).addToIndex("agent2", messageId);

      // Check unread count
      const unreadCount = await (server as any).handleGetUnreadCount({
        agent: "agent2",
      });

      expect(unreadCount.content[0].text).toBe("Agent agent2 has 1 unread message");

      // Read messages should show it as unread
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: unread");
    });

    it("should be able to mark old messages as read", async () => {
      // Manually create a message without status field
      const messageId = "agent1-" + Date.now();
      const messageDir = path.join(testDir, "messages", "agent2");
      await fs.mkdir(messageDir, { recursive: true });

      const message = {
        from: "agent1",
        to: "agent2",
        timestamp: new Date().toISOString(),
        content: "Old message without status",
      };

      await fs.writeFile(
        path.join(messageDir, `${messageId}.json`),
        JSON.stringify(message, null, 2)
      );

      // Update index
      await (server as any).addToIndex("agent2", messageId);

      // Mark as read
      await (server as any).handleMarkMessageRead({ message_id: messageId });

      // Verify it's now marked as read
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: read");
    });
  });

  describe("Cache Invalidation", () => {
    it("should update cache when marking message as read", async () => {
      // Send message
      const msg = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = msg.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // Read message (populates cache)
      await (server as any).handleReadMessages({
        agent: "agent2",
      });

      // Mark as read (should update cache)
      await (server as any).handleMarkMessageRead({
        message_id: messageId,
      });

      // Read again (should use updated cache)
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: read");
    });

    it("should update cache when marking message as acknowledged", async () => {
      // Send message
      const msg = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = msg.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // Read message (populates cache)
      await (server as any).handleReadMessages({
        agent: "agent2",
      });

      // Mark as acknowledged (should update cache)
      await (server as any).handleMarkMessageAcknowledged({
        message_id: messageId,
      });

      // Read again (should use updated cache)
      const messages = await (server as any).handleReadMessages({
        agent: "agent2",
      });

      expect(messages.content[0].text).toContain("Status: acknowledged");
    });
  });

  describe("list_messages with status", () => {
    it("should display status in list output", async () => {
      // Send messages with different statuses
      const msg1 = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 1",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Message 2",
      });

      const messageId1 = msg1.content[0].text.match(/ID: ([^\n]+)/)?.[1];
      await (server as any).handleMarkMessageRead({ message_id: messageId1 });

      // List messages
      const result = await (server as any).handleListMessages({
        agent: "agent2",
      });

      expect(result.content[0].text).toContain("Status: read");
      expect(result.content[0].text).toContain("Status: unread");
    });
  });

  describe("Edge Cases", () => {
    it("should handle status transitions correctly", async () => {
      // Send message
      const msg = await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "Test message",
      });

      const messageId = msg.content[0].text.match(/ID: ([^\n]+)/)?.[1];

      // unread -> read
      await (server as any).handleMarkMessageRead({ message_id: messageId });
      let messages = await (server as any).handleReadMessages({ agent: "agent2" });
      expect(messages.content[0].text).toContain("Status: read");

      // read -> acknowledged
      await (server as any).handleMarkMessageAcknowledged({ message_id: messageId });
      messages = await (server as any).handleReadMessages({ agent: "agent2" });
      expect(messages.content[0].text).toContain("Status: acknowledged");

      // acknowledged -> read (should work)
      await (server as any).handleMarkMessageRead({ message_id: messageId });
      messages = await (server as any).handleReadMessages({ agent: "agent2" });
      expect(messages.content[0].text).toContain("Status: read");
    });

    it("should handle multiple agents correctly", async () => {
      // Send messages to different agents
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent2",
        content: "To agent2",
      });
      await (server as any).handleSendMessage({
        from: "agent1",
        to: "agent3",
        content: "To agent3",
      });

      const count2 = await (server as any).handleGetUnreadCount({ agent: "agent2" });
      const count3 = await (server as any).handleGetUnreadCount({ agent: "agent3" });

      expect(count2.content[0].text).toBe("Agent agent2 has 1 unread message");
      expect(count3.content[0].text).toBe("Agent agent3 has 1 unread message");
    });
  });
});
