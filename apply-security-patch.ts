import * as fs from "fs/promises";
import * as path from "path";

async function applySecurityPatch() {
  const filePath = path.join(process.cwd(), "src", "index.ts");
  let content = await fs.readFile(filePath, "utf8");

  // Step 1: Add AsyncLock import if not present
  if (!content.includes("import AsyncLock")) {
    content = content.replace(
      'import * as os from "os";',
      'import * as os from "os";\nimport AsyncLock from "async-lock";'
    );
    console.log("✓ Added AsyncLock import");
  }

  // Step 2: Add lock instances to class
  if (!content.includes("private indexLock")) {
    content = content.replace(
      "private metricsPath: string;",
      `private metricsPath: string;
  private indexLock = new AsyncLock();
  private metricsLock = new AsyncLock();`
    );
    console.log("✓ Added lock instances");
  }

  // Step 3: Add atomicWriteJSON method
  if (!content.includes("atomicWriteJSON")) {
    const atomicMethod = `
  /**
   * Atomically write JSON data to a file using temp-then-rename pattern
   * This prevents corruption if the process crashes during write
   */
  private async atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
    const tmpPath = \`\${filePath}.tmp.\${Date.now()}.\${Math.random().toString(36).substring(7)}\`;

    try {
      // Write to temporary file first
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");

      // Atomic rename (overwrites destination on success)
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }
`;

    // Insert after getAgentDir method
    content = content.replace(
      /(  private getAgentDir\(agent: string\): string \{\s+return path\.join\(this\.storageDir, agent\);\s+\})/,
      `$1${atomicMethod}`
    );
    console.log("✓ Added atomicWriteJSON method");
  }

  // Step 4: Update saveIndex to use locking and atomic writes
  if (!content.includes("this.indexLock.acquire")) {
    content = content.replace(
      /  \/\*\*\s+\* Save the message index to disk\s+\*\/\s+private async saveIndex\(\): Promise<void> \{\s+try \{\s+await fs\.writeFile\(this\.indexPath, JSON\.stringify\(this\.messageIndex, null, 2\)\);\s+\} catch \(error\) \{\s+console\.error\("\[Index Save Error\]", error\);\s+\}\s+\}/,
      `  /**
   * Save the message index to disk with file locking and atomic writes
   */
  private async saveIndex(): Promise<void> {
    await this.indexLock.acquire("index", async () => {
      try {
        await this.atomicWriteJSON(this.indexPath, this.messageIndex);
      } catch (error) {
        console.error("[Index Save Error]", error);
      }
    });
  }`
    );
    console.log("✓ Updated saveIndex with locking");
  }

  // Step 5: Update saveMetrics to use locking and atomic writes
  if (!content.includes("this.metricsLock.acquire")) {
    content = content.replace(
      /  \/\*\*\s+\* Save metrics to disk\s+\*\/\s+private async saveMetrics\(\): Promise<void> \{\s+try \{\s+this\.metrics\.last_updated = new Date\(\)\.toISOString\(\);\s+await fs\.writeFile\(this\.metricsPath, JSON\.stringify\(this\.metrics, null, 2\)\);\s+\} catch \(error\) \{\s+console\.error\("\[Metrics Save Error\]", error\);\s+\}\s+\}/,
      `  /**
   * Save metrics to disk with file locking and atomic writes
   */
  private async saveMetrics(): Promise<void> {
    await this.metricsLock.acquire("metrics", async () => {
      try {
        this.metrics.last_updated = new Date().toISOString();
        await this.atomicWriteJSON(this.metricsPath, this.metrics);
      } catch (error) {
        console.error("[Metrics Save Error]", error);
      }
    });
  }`
    );
    console.log("✓ Updated saveMetrics with locking");
  }

  // Step 6: Replace fs.writeFile in handleSendMessage with atomic write
  if (content.includes("await fs.writeFile(filePath, JSON.stringify(message, null, 2));")) {
    content = content.replace(
      "await fs.writeFile(filePath, JSON.stringify(message, null, 2));",
      "await this.atomicWriteJSON(filePath, message);"
    );
    console.log("✓ Updated handleSendMessage with atomic write");
  }

  // Write the patched content
  await fs.writeFile(filePath, content, "utf8");
  console.log("\n✅ All security patches applied successfully!");
}

applySecurityPatch().catch(console.error);
