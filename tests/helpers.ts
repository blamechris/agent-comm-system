import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

/**
 * Creates a temporary directory for testing
 * @returns Path to the temporary directory
 */
export async function createTempTestDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-comm-test-"));
  return tmpDir;
}

/**
 * Removes a directory and all its contents
 * @param dirPath Path to the directory to remove
 */
export async function cleanupTestDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (_error) {
    // Ignore errors during cleanup
  }
}

/**
 * Creates a mock message object
 */
export function createMockMessage(overrides?: {
  from?: string;
  to?: string;
  subject?: string;
  content?: string;
  timestamp?: string;
}) {
  return {
    from: overrides?.from || "test-sender",
    to: overrides?.to || "test-receiver",
    subject: overrides?.subject,
    content: overrides?.content || "Test message content",
    timestamp: overrides?.timestamp || new Date().toISOString(),
  };
}

/**
 * Writes a message file to the specified directory
 */
export async function writeTestMessage(
  storageDir: string,
  message: ReturnType<typeof createMockMessage>,
  messageId?: string
): Promise<string> {
  // Add a small random component to prevent ID collisions when writing multiple messages
  const randomSuffix = Math.floor(Math.random() * 1000);
  const id = messageId || `${message.from}-${message.to}-${Date.now()}-${randomSuffix}`;
  const fileName = `${id}.json`;
  const filePath = path.join(storageDir, fileName);
  await fs.writeFile(filePath, JSON.stringify(message, null, 2));
  return id;
}

/**
 * Small delay helper for tests
 */
export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads all message files from a directory
 */
export async function readAllTestMessages(storageDir: string): Promise<any[]> {
  const files = await fs.readdir(storageDir);
  const messages = [];

  for (const file of files) {
    if (file.endsWith(".json")) {
      const content = await fs.readFile(path.join(storageDir, file), "utf-8");
      messages.push(JSON.parse(content));
    }
  }

  return messages;
}
