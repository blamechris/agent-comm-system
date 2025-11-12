import { AgentCommServer } from "../src/index.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("Statistics and Analytics", () => {
  let server: AgentCommServer;
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory for each test
    testDir = path.join(os.tmpdir(), `agent-comm-test-${Date.now()}-${Math.random()}`);
    const storageDir = path.join(testDir, "messages");
    await fs.mkdir(storageDir, { recursive: true });
    server = new AgentCommServer(storageDir);
    await server.run();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Error cleaning up test directory:", error);
    }
  });

  describe("Metrics Initialization", () => {
    it("should initialize metrics on first run", async () => {
      const metricsPath = path.join(testDir, "metrics.json");
      const metricsData = await fs.readFile(metricsPath, "utf-8");
      const metrics = JSON.parse(metricsData);

      expect(metrics).toHaveProperty("total_messages", 0);
      expect(metrics).toHaveProperty("total_storage_bytes", 0);
      expect(metrics).toHaveProperty("cache_hits", 0);
      expect(metrics).toHaveProperty("cache_misses", 0);
      expect(metrics).toHaveProperty("agents");
      expect(metrics).toHaveProperty("daily_activity");
      expect(metrics).toHaveProperty("hourly_activity");
      expect(metrics).toHaveProperty("last_updated");
    });
  });

  describe("Metrics Updates on Send", () => {
    it("should update metrics when sending a message", async () => {
      // @ts-ignore - accessing private method for testing
      const result = await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Hello Bob!",
      });

      expect(result.content[0].text).toContain("Message sent successfully");

      // Read metrics file
      const metricsPath = path.join(testDir, "metrics.json");
      const metricsData = await fs.readFile(metricsPath, "utf-8");
      const metrics = JSON.parse(metricsData);

      expect(metrics.total_messages).toBe(1);
      expect(metrics.agents.alice.sent_count).toBe(1);
      expect(metrics.agents.bob.received_count).toBe(1);
      expect(metrics.agents.alice.most_active_partners.bob).toBe(1);
    });

    it("should track multiple messages and update partner counts", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 2",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "charlie",
        content: "Message 3",
      });

      const metricsPath = path.join(testDir, "metrics.json");
      const metricsData = await fs.readFile(metricsPath, "utf-8");
      const metrics = JSON.parse(metricsData);

      expect(metrics.total_messages).toBe(3);
      expect(metrics.agents.alice.sent_count).toBe(3);
      expect(metrics.agents.alice.most_active_partners.bob).toBe(2);
      expect(metrics.agents.alice.most_active_partners.charlie).toBe(1);
    });

    it("should update daily and hourly activity", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test",
      });

      const metricsPath = path.join(testDir, "metrics.json");
      const metricsData = await fs.readFile(metricsPath, "utf-8");
      const metrics = JSON.parse(metricsData);

      const today = new Date().toISOString().split("T")[0];
      const currentHour = new Date().getHours().toString();

      expect(metrics.daily_activity[today]).toBe(1);
      expect(metrics.hourly_activity[currentHour]).toBe(1);
    });
  });

  describe("get_agent_stats - Specific Agent", () => {
    it("should return stats for a specific agent", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "charlie",
        content: "Message 2",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "bob",
        to: "alice",
        content: "Reply",
      });

      // @ts-ignore
      const result = await server["handleGetAgentStats"]({ agent: "alice" });

      expect(result.content[0].text).toContain("Statistics for agent: alice");
      expect(result.content[0].text).toContain("Messages Sent: 2");
      expect(result.content[0].text).toContain("Messages Received: 1");
      expect(result.content[0].text).toContain("Total Messages: 3");
      expect(result.content[0].text).toContain("bob");
      expect(result.content[0].text).toContain("charlie");
    });

    it("should return error for non-existent agent", async () => {
      // @ts-ignore
      const result = await server["handleGetAgentStats"]({ agent: "nonexistent" });

      expect(result.content[0].text).toContain("No statistics found");
    });

    it("should show most active communication partners", async () => {
      // Create more messages to bob than charlie
      for (let i = 0; i < 3; i++) {
        // @ts-ignore
        await server["handleSendMessage"]({
          from: "alice",
          to: "bob",
          content: `Message ${i}`,
        });
      }
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "charlie",
        content: "One message",
      });

      // @ts-ignore
      const result = await server["handleGetAgentStats"]({ agent: "alice" });

      const text = result.content[0].text;
      expect(text).toContain("bob: 3 messages");
      expect(text).toContain("charlie: 1 messages");
    });
  });

  describe("get_agent_stats - System-Wide", () => {
    it("should return system-wide statistics", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "bob",
        to: "charlie",
        content: "Message 2",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "charlie",
        to: "alice",
        content: "Message 3",
      });

      // @ts-ignore
      const result = await server["handleGetAgentStats"]({});

      expect(result.content[0].text).toContain("System-Wide Statistics");
      expect(result.content[0].text).toContain("Total Messages: 3");
      expect(result.content[0].text).toContain("Total Agents: 3");
      expect(result.content[0].text).toContain("Messages Sent: 3");
      expect(result.content[0].text).toContain("Messages Received: 3");
    });

    it("should show most active agents", async () => {
      // Alice sends 3 messages
      for (let i = 0; i < 3; i++) {
        // @ts-ignore
        await server["handleSendMessage"]({
          from: "alice",
          to: "bob",
          content: `Message ${i}`,
        });
      }
      // Bob sends 1 message
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "bob",
        to: "alice",
        content: "Reply",
      });

      // @ts-ignore
      const result = await server["handleGetAgentStats"]({});

      const text = result.content[0].text;
      // Alice has 4 total (3 sent, 1 received), Bob has 4 total (1 sent, 3 received)
      expect(text).toContain("alice: 4 messages");
      expect(text).toContain("bob: 4 messages");
    });
  });

  describe("get_storage_stats", () => {
    it("should return storage statistics", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test message",
      });

      // @ts-ignore
      const result = await server["handleGetStorageStats"]();

      expect(result.content[0].text).toContain("Storage and Cache Statistics");
      expect(result.content[0].text).toContain("Total Storage Size:");
      expect(result.content[0].text).toContain("Total Messages: 1");
      expect(result.content[0].text).toContain("Index Size:");
      expect(result.content[0].text).toContain("Cache Performance:");
    });

    it("should show per-agent storage breakdown", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message to bob",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "charlie",
        to: "alice",
        content: "Message to alice",
      });

      // @ts-ignore
      const result = await server["handleGetStorageStats"]();

      const text = result.content[0].text;
      expect(text).toContain("Per-Agent Storage");
      expect(text).toContain("bob:");
      expect(text).toContain("alice:");
    });

    it("should calculate cache hit rate", async () => {
      // Send a message
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test",
      });

      // Read messages (should cause cache misses and hits)
      // @ts-ignore
      await server["handleReadMessages"]({ agent: "bob" });
      // @ts-ignore
      await server["handleReadMessages"]({ agent: "bob" }); // Should hit cache

      // @ts-ignore
      const result = await server["handleGetStorageStats"]();

      const text = result.content[0].text;
      expect(text).toContain("Cache Hits:");
      expect(text).toContain("Cache Misses:");
      expect(text).toContain("Hit Rate:");
    });
  });

  describe("get_activity_stats", () => {
    it("should return activity statistics", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 2",
      });

      // @ts-ignore
      const result = await server["handleGetActivityStats"]({});

      expect(result.content[0].text).toContain("Activity Statistics");
      expect(result.content[0].text).toContain("Daily Activity:");
      expect(result.content[0].text).toContain("Peak Day:");
      expect(result.content[0].text).toContain("Hourly Activity");
      expect(result.content[0].text).toContain("Peak Hour:");
    });

    it("should filter by date range", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test",
      });

      const today = new Date().toISOString().split("T")[0];
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      // @ts-ignore
      const result = await server["handleGetActivityStats"]({
        start_date: today,
        end_date: tomorrow,
      });

      expect(result.content[0].text).toContain(`Date Range: ${today} to ${tomorrow}`);
    });

    it("should filter by agent", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "charlie",
        to: "dave",
        content: "Message 2",
      });

      // @ts-ignore
      const result = await server["handleGetActivityStats"]({ agent: "bob" });

      expect(result.content[0].text).toContain("Filtered by Agent: bob");
    });

    it("should show agent activity ranking", async () => {
      // Alice sends 3, Bob sends 1
      for (let i = 0; i < 3; i++) {
        // @ts-ignore
        await server["handleSendMessage"]({
          from: "alice",
          to: "bob",
          content: `Message ${i}`,
        });
      }
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "charlie",
        to: "bob",
        content: "From Charlie",
      });

      // @ts-ignore
      const result = await server["handleGetActivityStats"]({});

      const text = result.content[0].text;
      expect(text).toContain("Agent Activity Ranking:");
      expect(text).toContain("bob: 4 messages"); // Received 4 messages
    });
  });

  describe("get_communication_graph", () => {
    it("should return communication graph", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "bob",
        to: "charlie",
        content: "Message 2",
      });

      // @ts-ignore
      const result = await server["handleGetCommunicationGraph"]();

      expect(result.content[0].text).toContain("Communication Network Graph");
      expect(result.content[0].text).toContain("Nodes");
      expect(result.content[0].text).toContain("alice");
      expect(result.content[0].text).toContain("bob");
      expect(result.content[0].text).toContain("charlie");
    });

    it("should show communication paths with counts", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 2",
      });

      // @ts-ignore
      const result = await server["handleGetCommunicationGraph"]();

      const text = result.content[0].text;
      expect(text).toContain("Top Communication Paths");
      expect(text).toContain("alice → bob: 2 messages");
    });

    it("should show sent and received counts for nodes", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "bob",
        to: "alice",
        content: "Message 2",
      });

      // @ts-ignore
      const result = await server["handleGetCommunicationGraph"]();

      const text = result.content[0].text;
      expect(text).toContain("alice (sent: 1, received: 1)");
      expect(text).toContain("bob (sent: 1, received: 1)");
    });
  });

  describe("Cache Hit/Miss Tracking", () => {
    it("should track cache misses on first read", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test",
      });

      // Clear the cache to simulate a cold read
      // @ts-ignore
      server["messageCache"].clear();

      // First read should cause a cache miss
      // @ts-ignore
      await server["handleReadMessages"]({ agent: "bob" });

      // Wait for async metrics save
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metricsPath = path.join(testDir, "metrics.json");
      const metricsData = await fs.readFile(metricsPath, "utf-8");
      const metrics = JSON.parse(metricsData);

      expect(metrics.cache_misses).toBeGreaterThan(0);
    });

    it("should track cache hits on subsequent reads", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test",
      });

      // First read
      // @ts-ignore
      await server["handleReadMessages"]({ agent: "bob" });

      // Second read should hit cache
      // @ts-ignore
      await server["handleReadMessages"]({ agent: "bob" });

      // Wait for async metrics save
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metricsPath = path.join(testDir, "metrics.json");
      const metricsData = await fs.readFile(metricsPath, "utf-8");
      const metrics = JSON.parse(metricsData);

      expect(metrics.cache_hits).toBeGreaterThan(0);
    });
  });

  describe("Metrics Persistence", () => {
    it("should persist metrics across server restarts", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Test",
      });

      // Create a new server instance with same storage
      const storageDir = path.join(testDir, "messages");
      const newServer = new AgentCommServer(storageDir);
      await newServer.run();

      // @ts-ignore
      const result = await newServer["handleGetAgentStats"]({ agent: "alice" });

      expect(result.content[0].text).toContain("Messages Sent: 1");
    });
  });

  describe("Metrics Rebuilding", () => {
    it("should rebuild metrics from existing messages", async () => {
      // Send some messages
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "bob",
        to: "charlie",
        content: "Message 2",
      });

      // Delete metrics file
      const metricsPath = path.join(testDir, "metrics.json");
      await fs.unlink(metricsPath);

      // Create new server - should rebuild metrics
      const storageDir = path.join(testDir, "messages");
      const newServer = new AgentCommServer(storageDir);
      await newServer.run();

      // @ts-ignore
      const result = await newServer["handleGetAgentStats"]({});

      expect(result.content[0].text).toContain("Total Messages: 2");
      expect(result.content[0].text).toContain("Total Agents: 3");
    });
  });

  describe("Average Messages Per Day", () => {
    it("should calculate average messages per day for an agent", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Message 1",
      });

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "charlie",
        content: "Message 2",
      });

      // @ts-ignore
      const result = await server["handleGetAgentStats"]({ agent: "alice" });

      expect(result.content[0].text).toContain("Average Messages/Day:");
    });
  });

  describe("First and Last Message Timestamps", () => {
    it("should track first and last message timestamps", async () => {
      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "First message",
      });

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      // @ts-ignore
      await server["handleSendMessage"]({
        from: "alice",
        to: "bob",
        content: "Second message",
      });

      // @ts-ignore
      const result = await server["handleGetAgentStats"]({ agent: "alice" });

      const text = result.content[0].text;
      expect(text).toContain("First Message:");
      expect(text).toContain("Last Message:");

      // Extract timestamps
      const firstMatch = text.match(/First Message: (.+)/);
      const lastMatch = text.match(/Last Message: (.+)/);

      expect(firstMatch).toBeTruthy();
      expect(lastMatch).toBeTruthy();

      if (firstMatch && lastMatch) {
        const firstTime = new Date(firstMatch[1]).getTime();
        const lastTime = new Date(lastMatch[1]).getTime();
        expect(lastTime).toBeGreaterThanOrEqual(firstTime);
      }
    });
  });
});
