import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { AgentCommServer } from "../src/index.js";
import { createTempTestDir, cleanupTestDir, delay } from "./helpers.js";

// Each test constructs a fresh AgentCommServer, which registers a SIGINT
// listener. Raise the cap so the suite doesn't emit MaxListeners warnings.
process.setMaxListeners(100);

/**
 * v2.1 mailbox-queue feature tests.
 *
 * These exercise the REAL AgentCommServer handlers (called directly, bypassing
 * the MCP stdio transport) so receive_next / unread_count / ack and the
 * emit-on-send hook are tested through the production code path.
 */
describe("Agent Communication System v2.1 — mailbox queue", () => {
  let testDir: string;
  let messagesDir: string;
  let server: AgentCommServer;

  beforeEach(async () => {
    testDir = await createTempTestDir();
    messagesDir = path.join(testDir, "messages");
    await fs.mkdir(messagesDir, { recursive: true });
    server = new AgentCommServer(messagesDir);
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
    delete process.env.AGENT_COMM_EMIT_WEBHOOK;
    delete process.env.AGENT_COMM_EMIT_HEADER;
  });

  // Direct handler access (handlers are private on the class).
  const call = (name: string, args: unknown): Promise<{ content: { text: string }[] }> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any)[name](args);

  const send = async (from: string, to: string, content: string, subject?: string) => {
    const res = await call("handleSendMessage", { from, to, content, subject });
    // Space sends apart so Date.now()-based ids and timestamps stay monotonic.
    await delay(2);
    return res;
  };

  const text = (res: { content: { text: string }[] }) => res.content[0].text;
  const indexFor = (agent: string): string[] =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((server as any).messageIndex[agent] as string[]) || [];

  describe("receive_next (FIFO drain)", () => {
    it("returns the oldest unread first and advances the queue", async () => {
      await send("alice", "bob", "first");
      await send("carol", "bob", "second");

      expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
        "Unread messages for bob: 2"
      );

      const first = text(await call("handleReceiveNext", { agent: "bob" }));
      expect(first).toContain("first");
      expect(first).not.toContain("second");
      expect(first).toContain("Remaining unread: 1");

      const second = text(await call("handleReceiveNext", { agent: "bob" }));
      expect(second).toContain("second");
      expect(second).toContain("Remaining unread: 0");

      const empty = text(await call("handleReceiveNext", { agent: "bob" }));
      expect(empty).toContain("No unread messages for agent: bob");

      expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
        "Unread messages for bob: 0"
      );
    });

    it("persists read=true + readAt to the message file when consumed", async () => {
      await send("alice", "bob", "hello");
      const id = indexFor("bob")[0];

      await call("handleReceiveNext", { agent: "bob" });

      const raw = JSON.parse(
        await fs.readFile(path.join(messagesDir, "bob", `${id}.json`), "utf-8")
      );
      expect(raw.read).toBe(true);
      expect(typeof raw.readAt).toBe("string");
      expect(raw.id).toBe(id);
    });

    it("peek returns the next unread WITHOUT consuming it", async () => {
      await send("alice", "bob", "peek-me");

      const peeked = text(await call("handleReceiveNext", { agent: "bob", peek: true }));
      expect(peeked).toContain("peek-me");
      expect(peeked).toContain("(peek)");
      expect(peeked).toContain("Remaining unread: 1");

      // Still unread after a peek.
      expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
        "Unread messages for bob: 1"
      );

      const consumed = text(await call("handleReceiveNext", { agent: "bob" }));
      expect(consumed).toContain("peek-me");
      expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
        "Unread messages for bob: 0"
      );
    });

    it("supports an agent messaging itself (self-mailbox)", async () => {
      await send("solo", "solo", "remember to do X");
      expect(text(await call("handleUnreadCount", { agent: "solo" }))).toContain(
        "Unread messages for solo: 1"
      );
      const got = text(await call("handleReceiveNext", { agent: "solo" }));
      expect(got).toContain("remember to do X");
      expect(text(await call("handleUnreadCount", { agent: "solo" }))).toContain(
        "Unread messages for solo: 0"
      );
    });
  });

  describe("ack", () => {
    it("removes a processed message and updates unread count + index", async () => {
      await send("alice", "bob", "m1");
      await send("alice", "bob", "m2");
      const [id1] = indexFor("bob");

      // Consume m1, then ack (delete) it.
      await call("handleReceiveNext", { agent: "bob" });
      const ackRes = text(await call("handleAck", { message_id: id1 }));
      expect(ackRes).toContain(`Message ${id1} acknowledged and removed`);

      expect(indexFor("bob")).not.toContain(id1);
      await expect(fs.access(path.join(messagesDir, "bob", `${id1}.json`))).rejects.toBeTruthy();

      // m2 still unread.
      expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
        "Unread messages for bob: 1"
      );
    });

    it("throws for an unknown message id", async () => {
      await expect(call("handleAck", { message_id: "does-not-exist" })).rejects.toThrow(
        /not found/
      );
    });
  });

  describe("backward compatibility with v2.0 files", () => {
    it("treats a legacy message (no id/read) as unread and consumes it", async () => {
      // Write a v2.0-style file directly: no `id`, no `read`.
      const bobDir = path.join(messagesDir, "bob");
      await fs.mkdir(bobDir, { recursive: true });
      const legacyId = "legacy-1700000000000";
      const legacy = {
        from: "legacy",
        to: "bob",
        timestamp: new Date(1700000000000).toISOString(),
        content: "old message",
      };
      await fs.writeFile(path.join(bobDir, `${legacyId}.json`), JSON.stringify(legacy, null, 2));

      // Rebuild the index so the server sees the manually-written file.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (server as any).rebuildIndex();

      expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
        "Unread messages for bob: 1"
      );

      const got = text(await call("handleReceiveNext", { agent: "bob" }));
      expect(got).toContain("old message");
      expect(got).toContain(`ID: ${legacyId}`);

      // Consuming backfills id + read on disk.
      const raw = JSON.parse(await fs.readFile(path.join(bobDir, `${legacyId}.json`), "utf-8"));
      expect(raw.read).toBe(true);
      expect(raw.id).toBe(legacyId);
    });
  });

  describe("emit-on-send hook", () => {
    it("POSTs {to,from,id,unread_count} to AGENT_COMM_EMIT_WEBHOOK on send", async () => {
      process.env.AGENT_COMM_EMIT_WEBHOOK = "https://example.test/mailbox";
      process.env.AGENT_COMM_EMIT_HEADER = "Authorization: Bearer secret123";
      const fetchMock = jest.fn(async () => ({ ok: true }) as unknown as Response);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = fetchMock;

      try {
        await call("handleSendMessage", { from: "alice", to: "bob", content: "ping" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://example.test/mailbox");
        expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret123");
        const body = JSON.parse(opts.body as string);
        expect(body.to).toBe("bob");
        expect(body.from).toBe("alice");
        expect(typeof body.id).toBe("string");
        expect(body.unread_count).toBe(1);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).fetch;
      }
    });

    it("does NOT fire when AGENT_COMM_EMIT_WEBHOOK is unset", async () => {
      const fetchMock = jest.fn(async () => ({ ok: true }) as unknown as Response);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = fetchMock;
      try {
        await call("handleSendMessage", { from: "alice", to: "bob", content: "ping" });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).fetch;
      }
    });

    it("still succeeds when the webhook rejects (delivery never breaks a send)", async () => {
      process.env.AGENT_COMM_EMIT_WEBHOOK = "https://example.test/dead";
      const fetchMock = jest.fn(async () => {
        throw new Error("connection refused");
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = fetchMock;
      try {
        const res = text(
          await call("handleSendMessage", { from: "alice", to: "bob", content: "ping" })
        );
        expect(res).toContain("Message sent successfully");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The message is still stored despite the failed emit.
        expect(text(await call("handleUnreadCount", { agent: "bob" }))).toContain(
          "Unread messages for bob: 1"
        );
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).fetch;
      }
    });
  });
});
