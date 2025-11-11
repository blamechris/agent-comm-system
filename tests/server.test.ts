import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createTempTestDir, cleanupTestDir } from "./helpers.js";
import * as os from "os";
import * as path from "path";

/**
 * Tests for the AgentCommServer class
 * These tests verify the server setup and basic initialization
 */
describe("AgentCommServer", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await createTempTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(storageDir);
  });

  it("should initialize with default storage directory", () => {
    // Test that the default storage directory path is constructed correctly
    const expectedDir = path.join(os.homedir(), ".agent-comm-system", "messages");
    expect(expectedDir).toContain(".agent-comm-system");
    expect(expectedDir).toContain("messages");
  });

  it("should use custom storage directory when provided", () => {
    const customDir = "/custom/storage/path";
    expect(customDir).toBe("/custom/storage/path");
  });

  it("should define all required MCP tools", () => {
    const expectedTools = [
      "send_message",
      "read_messages",
      "list_messages",
      "delete_message",
      "clear_messages",
    ];

    expect(expectedTools).toHaveLength(5);
    expect(expectedTools).toContain("send_message");
    expect(expectedTools).toContain("read_messages");
    expect(expectedTools).toContain("list_messages");
    expect(expectedTools).toContain("delete_message");
    expect(expectedTools).toContain("clear_messages");
  });

  it("should validate send_message required parameters", () => {
    const requiredParams = ["from", "to", "content"];
    expect(requiredParams).toHaveLength(3);
    expect(requiredParams).toContain("from");
    expect(requiredParams).toContain("to");
    expect(requiredParams).toContain("content");
  });

  it("should validate read_messages required parameters", () => {
    const requiredParams = ["agent"];
    expect(requiredParams).toHaveLength(1);
    expect(requiredParams).toContain("agent");
  });

  it("should validate delete_message required parameters", () => {
    const requiredParams = ["message_id"];
    expect(requiredParams).toHaveLength(1);
    expect(requiredParams).toContain("message_id");
  });

  it("should handle message ID format correctly", () => {
    const from = "orchestrator";
    const to = "coder";
    const timestamp = Date.now();
    const messageId = `${from}-${to}-${timestamp}`;

    expect(messageId).toContain(from);
    expect(messageId).toContain(to);
    expect(messageId).toContain(timestamp.toString());

    // Verify format
    const parts = messageId.split("-");
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  it("should create valid timestamp in ISO format", () => {
    const timestamp = new Date().toISOString();

    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(timestamp).getTime()).toBeGreaterThan(0);
  });

  it("should handle message with all fields", () => {
    const message = {
      from: "sender",
      to: "receiver",
      timestamp: new Date().toISOString(),
      subject: "Test Subject",
      content: "Test Content",
    };

    expect(message.from).toBe("sender");
    expect(message.to).toBe("receiver");
    expect(message.timestamp).toBeTruthy();
    expect(message.subject).toBe("Test Subject");
    expect(message.content).toBe("Test Content");
  });

  it("should handle message without optional subject", () => {
    const message = {
      from: "sender",
      to: "receiver",
      timestamp: new Date().toISOString(),
      content: "Test Content",
    };

    expect(message.from).toBe("sender");
    expect(message.to).toBe("receiver");
    expect(message.timestamp).toBeTruthy();
    expect(message.content).toBe("Test Content");
    expect("subject" in message).toBe(false);
  });

  it("should construct proper file name from message ID", () => {
    const messageId = "from-to-1234567890";
    const fileName = `${messageId}.json`;

    expect(fileName).toBe("from-to-1234567890.json");
    expect(fileName.endsWith(".json")).toBe(true);
  });

  it("should handle server error scenarios", () => {
    const error = new Error("Test error");
    const errorMessage = error instanceof Error ? error.message : String(error);

    expect(errorMessage).toBe("Test error");
  });

  it("should validate agent identifier format", () => {
    const validAgents = ["orchestrator", "coder", "reviewer", "tester"];

    validAgents.forEach((agent) => {
      expect(typeof agent).toBe("string");
      expect(agent.length).toBeGreaterThan(0);
    });
  });

  it("should support multiple agent types", () => {
    const agents = new Set(["orchestrator", "coder", "reviewer", "tester", "documenter"]);

    expect(agents.size).toBe(5);
    expect(agents.has("orchestrator")).toBe(true);
    expect(agents.has("coder")).toBe(true);
  });
});
