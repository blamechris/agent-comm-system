import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { AgentCommServer, runCli } from "../src/index.js";
import { createTempTestDir, cleanupTestDir, delay } from "./helpers.js";

process.setMaxListeners(100);

/**
 * v2.2 one-shot CLI tests.
 *
 * The CLI is the non-MCP surface hooks/scripts use to query or drain a mailbox.
 * `runCli` is tested through AGENT_COMM_STORAGE (a temp dir) so it never touches
 * the real ~/.agent-comm-system.
 */
describe("Agent Communication System v2.2 — one-shot CLI", () => {
  let testDir: string;
  let messagesDir: string;

  beforeEach(async () => {
    testDir = await createTempTestDir();
    messagesDir = path.join(testDir, "messages");
    await fs.mkdir(messagesDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
    delete process.env.AGENT_COMM_STORAGE;
  });

  // Seed messages on disk via a sender server (writes files + index).
  const seed = async (pairs: Array<[string, string, string]>) => {
    const sender = new AgentCommServer(messagesDir);
    for (const [from, to, content] of pairs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sender as any).handleSendMessage({ from, to, content });
      await delay(2);
    }
  };

  describe("public CLI methods (fresh process reads from disk)", () => {
    it("cliUnreadCount loads the on-disk index and counts unread", async () => {
      await seed([
        ["alice", "bob", "one"],
        ["carol", "bob", "two"],
      ]);
      const cli = new AgentCommServer(messagesDir);
      expect(await cli.cliUnreadCount("bob")).toBe(2);
      expect(await cli.cliUnreadCount("nobody")).toBe(0);
    });

    it("cliPeekUnread returns unread oldest-first without consuming", async () => {
      await seed([
        ["alice", "bob", "one"],
        ["carol", "bob", "two"],
      ]);
      const cli = new AgentCommServer(messagesDir);
      const unread = await cli.cliPeekUnread("bob");
      expect(unread.map((m) => m.content)).toEqual(["one", "two"]);
      // Non-destructive.
      expect(await cli.cliUnreadCount("bob")).toBe(2);
    });

    it("cliReceiveNext consumes oldest-first; peek does not consume", async () => {
      await seed([
        ["alice", "bob", "one"],
        ["carol", "bob", "two"],
      ]);
      const cli = new AgentCommServer(messagesDir);

      const peeked = await cli.cliReceiveNext("bob", true);
      expect(peeked?.content).toBe("one");
      expect(await cli.cliUnreadCount("bob")).toBe(2);

      const first = await cli.cliReceiveNext("bob");
      expect(first?.content).toBe("one");
      expect(first?.read).toBe(true);
      expect(await cli.cliUnreadCount("bob")).toBe(1);

      const second = await cli.cliReceiveNext("bob");
      expect(second?.content).toBe("two");
      expect(await cli.cliReceiveNext("bob")).toBeNull();
    });
  });

  describe("runCli (argv dispatch via AGENT_COMM_STORAGE)", () => {
    let outSpy: ReturnType<typeof jest.spyOn>;
    let errSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      process.env.AGENT_COMM_STORAGE = messagesDir;
      // CLI data output goes to process.stdout.write (idiomatic for a CLI).
      outSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
      errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    });

    // Output is written with a trailing newline — trim it for comparison.
    const lastLog = () => String(outSpy.mock.calls.at(-1)?.[0] ?? "").trimEnd();

    it("`unread <agent>` prints the count", async () => {
      await seed([
        ["alice", "bob", "one"],
        ["carol", "bob", "two"],
      ]);
      const code = await runCli(["unread", "bob"]);
      expect(code).toBe(0);
      expect(lastLog()).toBe("2");
    });

    it("`peek <agent>` prints a JSON array and does not consume", async () => {
      await seed([["alice", "bob", "one"]]);
      const code = await runCli(["peek", "bob"]);
      expect(code).toBe(0);
      const arr = JSON.parse(lastLog());
      expect(Array.isArray(arr)).toBe(true);
      expect(arr[0].content).toBe("one");
      // still unread
      const after = await runCli(["unread", "bob"]);
      expect(after).toBe(0);
      expect(lastLog()).toBe("1");
    });

    it("`next <agent>` prints the oldest message JSON and consumes it", async () => {
      await seed([
        ["alice", "bob", "one"],
        ["carol", "bob", "two"],
      ]);
      await runCli(["next", "bob"]);
      const msg = JSON.parse(lastLog());
      expect(msg.content).toBe("one");
      expect(msg.read).toBe(true);

      await runCli(["unread", "bob"]);
      expect(lastLog()).toBe("1");
    });

    it("`next <agent> --peek` does not consume", async () => {
      await seed([["alice", "bob", "one"]]);
      await runCli(["next", "bob", "--peek"]);
      const msg = JSON.parse(lastLog());
      expect(msg.content).toBe("one");
      await runCli(["unread", "bob"]);
      expect(lastLog()).toBe("1");
    });

    it("`next <agent>` prints null for an empty mailbox", async () => {
      const code = await runCli(["next", "ghost"]);
      expect(code).toBe(0);
      expect(lastLog()).toBe("null");
    });

    it("returns code 2 for a missing agent and for unknown commands", async () => {
      expect(await runCli(["unread"])).toBe(2);
      expect(await runCli(["bogus", "bob"])).toBe(2);
      expect(await runCli([])).toBe(2);
    });
  });
});
