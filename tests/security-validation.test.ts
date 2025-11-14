/**
 * Security Validation Tests
 * Tests for path traversal prevention and input validation
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { AgentCommServer } from "../src/index.js";

describe("Security - Agent Name Validation", () => {
  let testDir: string;
  let server: AgentCommServer;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `agent-comm-test-security-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Initialize server with test directory
    server = new AgentCommServer(testDir);
  });

  afterEach(async () => {
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Valid Agent Names", () => {
    test("should accept simple lowercase name", async () => {
      const result = await (server as any).handleSendMessage({
        from: "coder",
        to: "reviewer",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should accept uppercase name", async () => {
      const result = await (server as any).handleSendMessage({
        from: "AGENT",
        to: "REVIEWER",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should accept mixed case name", async () => {
      const result = await (server as any).handleSendMessage({
        from: "AgentOne",
        to: "ReviewerTwo",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should accept name with numbers", async () => {
      const result = await (server as any).handleSendMessage({
        from: "agent123",
        to: "reviewer456",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should accept name with hyphens", async () => {
      const result = await (server as any).handleSendMessage({
        from: "agent-one",
        to: "reviewer-two",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should accept name with underscores", async () => {
      const result = await (server as any).handleSendMessage({
        from: "agent_one",
        to: "reviewer_two",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should accept complex valid name", async () => {
      const result = await (server as any).handleSendMessage({
        from: "Agent_123-Test",
        to: "Reviewer-456_Prod",
        content: "Test message",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });
  });

  describe("Path Traversal Prevention", () => {
    test("should reject agent name with parent directory reference", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "../etc/passwd",
          to: "reviewer",
          content: "Malicious content",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with multiple parent directory references", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "../../etc/passwd",
          to: "reviewer",
          content: "Malicious content",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with current directory reference", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "./hidden",
          to: "reviewer",
          content: "Malicious content",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with path separator (forward slash)", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "etc/passwd",
          to: "reviewer",
          content: "Malicious content",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with path separator (backslash)", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "etc\\passwd",
          to: "reviewer",
          content: "Malicious content",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject recipient name with path traversal", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "sender",
          to: "../../../etc/passwd",
          content: "Malicious content",
        });
      }).rejects.toThrow("Invalid agent name");
    });
  });

  describe("Invalid Characters", () => {
    test("should reject agent name with space", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with tab", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent\tname",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with newline", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent\nname",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with colon", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent:name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with semicolon", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent;name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with pipe", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent|name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with ampersand", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent&name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with dollar sign", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent$name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with asterisk", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent*name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject agent name with question mark", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent?name",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Invalid agent name");
    });
  });

  describe("Edge Cases", () => {
    test("should reject empty agent name", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name must be a non-empty string");
    });

    test("should reject agent name with only whitespace", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "   ",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name cannot start or end with whitespace");
    });

    test("should reject agent name with leading whitespace", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: " agent",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name cannot start or end with whitespace");
    });

    test("should reject agent name with trailing whitespace", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: "agent ",
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name cannot start or end with whitespace");
    });

    test("should reject very long agent name (over 255 characters)", async () => {
      const longName = "a".repeat(256);
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: longName,
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name too long");
    });

    test("should accept agent name with exactly 255 characters", async () => {
      const maxName = "a".repeat(255);
      const result = await (server as any).handleSendMessage({
        from: maxName,
        to: "reviewer",
        content: "Test",
      });

      expect(result.content[0].text).toContain("Message sent successfully");
    });

    test("should reject null agent name", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: null as any,
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name must be a non-empty string");
    });

    test("should reject undefined agent name", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: undefined as any,
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Missing required parameters");
    });

    test("should reject numeric agent name", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: 123 as any,
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name must be a non-empty string");
    });

    test("should reject object as agent name", async () => {
      await expect(async () => {
        await (server as any).handleSendMessage({
          from: {} as any,
          to: "reviewer",
          content: "Test",
        });
      }).rejects.toThrow("Agent name must be a non-empty string");
    });
  });

  describe("Validation in read_messages", () => {
    test("should reject path traversal in read_messages", async () => {
      await expect(async () => {
        await (server as any).handleReadMessages({
          agent: "../../../etc/passwd",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should reject invalid characters in read_messages", async () => {
      await expect(async () => {
        await (server as any).handleReadMessages({
          agent: "agent/name",
        });
      }).rejects.toThrow("Invalid agent name");
    });
  });

  describe("Validation in list_messages", () => {
    test("should reject path traversal in list_messages", async () => {
      await expect(async () => {
        await (server as any).handleListMessages({
          agent: "../../../etc/passwd",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should accept list_messages without agent parameter", async () => {
      const result = await (server as any).handleListMessages({});
      expect(result.content[0].text).toContain("No messages found in the system");
    });
  });

  describe("Validation in clear_messages", () => {
    test("should reject path traversal in clear_messages", async () => {
      await expect(async () => {
        await (server as any).handleClearMessages({
          agent: "../../../etc/passwd",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should accept clear_messages without agent parameter", async () => {
      const result = await (server as any).handleClearMessages({});
      expect(result.content[0].text).toContain("Cleared all 0 message(s) from the system");
    });
  });

  describe("Validation in get_agent_stats", () => {
    test("should reject path traversal in get_agent_stats", async () => {
      await expect(async () => {
        await (server as any).handleGetAgentStats({
          agent: "../../../etc/passwd",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should accept get_agent_stats without agent parameter", async () => {
      const result = await (server as any).handleGetAgentStats({});
      expect(result.content[0].text).toContain("System-Wide Statistics");
    });
  });

  describe("Validation in get_activity_stats", () => {
    test("should reject path traversal in get_activity_stats", async () => {
      await expect(async () => {
        await (server as any).handleGetActivityStats({
          agent: "../../../etc/passwd",
        });
      }).rejects.toThrow("Invalid agent name");
    });

    test("should accept get_activity_stats without agent parameter", async () => {
      const result = await (server as any).handleGetActivityStats({});
      expect(result.content[0].text).toContain("Activity Statistics");
    });
  });

  describe("Directory Validation in Rebuild", () => {
    test("should skip invalid directory during index rebuild", async () => {
      // Create a malicious directory
      const maliciousDir = path.join(testDir, "../../../malicious");
      await fs.mkdir(maliciousDir, { recursive: true }).catch(() => {});

      // Create a valid directory
      const validDir = path.join(testDir, "validagent");
      await fs.mkdir(validDir, { recursive: true });

      // Create a test message file
      const messageFile = path.join(validDir, "test-123.json");
      await fs.writeFile(
        messageFile,
        JSON.stringify({
          from: "sender",
          to: "validagent",
          timestamp: new Date().toISOString(),
          content: "test",
        })
      );

      // Rebuild index - should skip malicious directory
      await (server as any).rebuildIndex();

      // Verify valid directory was processed
      const messageIndex = (server as any).messageIndex;
      expect(messageIndex.validagent).toBeDefined();
    });

    test("should skip directory with invalid characters during metrics rebuild", async () => {
      // Create directory with invalid name
      const invalidDir = path.join(testDir, "invalid:name");
      try {
        await fs.mkdir(invalidDir, { recursive: true });
      } catch {
        // Skip this test if the filesystem doesn't allow the directory name
        return;
      }

      // Rebuild metrics - should skip invalid directory
      await (server as any).rebuildMetrics();

      // Metrics should not crash
      const metrics = (server as any).metrics;
      expect(metrics).toBeDefined();
      expect(metrics.total_messages).toBe(0);
    });
  });

  describe("Defense in Depth - delete_message", () => {
    test("should validate agent even when found in index", async () => {
      // Manually corrupt the index to contain an invalid agent name
      (server as any).messageIndex["../../../etc"] = ["passwd-123"];

      await expect(async () => {
        await (server as any).handleDeleteMessage({
          message_id: "passwd-123",
        });
      }).rejects.toThrow("Invalid agent name");
    });
  });
});
