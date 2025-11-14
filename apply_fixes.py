#!/usr/bin/env python3
"""Apply resource limit security fixes to src/index.ts"""

with open('src/index.ts', 'r') as f:
    lines = f.readlines()

# Track line number for insertions
output = []
i = 0

while i < len(lines):
    line = lines[i]

    # 1. Add randomUUID import after os import
    if 'import * as os from "os";' in line and i + 1 < len(lines) and 'randomUUID' not in ''.join(lines[i:i+5]):
        output.append(line)
        output.append('import { randomUUID } from "crypto";\n')
        i += 1
        continue

    # 2. Add storage constants after DEFAULT_PAGE_LIMIT
    if 'const DEFAULT_PAGE_LIMIT = 50;' in line and 'MAX_MESSAGE_SIZE' not in ''.join(lines[i:i+10]):
        output.append(line)
        output.append('\n')
        output.append('// Storage limits (configurable via environment variables)\n')
        output.append('const MAX_MESSAGE_SIZE = parseInt(process.env.MAX_MESSAGE_SIZE || "1048576"); // 1 MB default\n')
        output.append('const MAX_TOTAL_STORAGE = parseInt(process.env.MAX_TOTAL_STORAGE || "1073741824"); // 1 GB default\n')
        output.append('const MAX_SUBJECT_LENGTH = parseInt(process.env.MAX_SUBJECT_LENGTH || "500"); // 500 characters default\n')
        i += 1
        continue

    # 3. Fix message ID generation (single line replacement)
    if '    const messageId = `${from}-${Date.now()}`;' in line:
        output.append('    const timestamp = Date.now();\n')
        output.append('    const uniqueSuffix = randomUUID().split("-")[0]; // First 8 chars of UUID\n')
        output.append('    const messageId = `${from}-${timestamp}-${uniqueSuffix}`;\n')
        i += 1
        continue

    # 4. Add validateMessageLimits method before calculateStorageSize
    if '  /**\n   * Calculate storage size efficiently\n   */' in ''.join(lines[i:i+3]) and 'validateMessageLimits' not in ''.join(output):
        output.append('  /**\n')
        output.append('   * Validate message size and storage limits\n')
        output.append('   */\n')
        output.append('  private async validateMessageLimits(\n')
        output.append('    content: string,\n')
        output.append('    subject?: string\n')
        output.append('  ): Promise<void> {\n')
        output.append('    // Calculate message size (JSON representation)\n')
        output.append('    const messageSize = Buffer.byteLength(content, "utf-8") +\n')
        output.append('                        (subject ? Buffer.byteLength(subject, "utf-8") : 0);\n')
        output.append('\n')
        output.append('    // Check individual message size\n')
        output.append('    if (messageSize > MAX_MESSAGE_SIZE) {\n')
        output.append('      throw new Error(\n')
        output.append('        `Message exceeds maximum size of ${MAX_MESSAGE_SIZE} bytes (${Math.ceil(MAX_MESSAGE_SIZE / 1024)} KB). ` +\n')
        output.append('        `Your message is ${messageSize} bytes (${Math.ceil(messageSize / 1024)} KB).`\n')
        output.append('      );\n')
        output.append('    }\n')
        output.append('\n')
        output.append('    // Check subject length\n')
        output.append('    if (subject && subject.length > MAX_SUBJECT_LENGTH) {\n')
        output.append('      throw new Error(\n')
        output.append('        `Subject exceeds maximum length of ${MAX_SUBJECT_LENGTH} characters. ` +\n')
        output.append('        `Your subject is ${subject.length} characters.`\n')
        output.append('      );\n')
        output.append('    }\n')
        output.append('\n')
        output.append('    // Check total storage limit\n')
        output.append('    if (this.metrics.total_storage_bytes + messageSize > MAX_TOTAL_STORAGE) {\n')
        output.append('      const usedGB = (this.metrics.total_storage_bytes / (1024 * 1024 * 1024)).toFixed(2);\n')
        output.append('      const maxGB = (MAX_TOTAL_STORAGE / (1024 * 1024 * 1024)).toFixed(2);\n')
        output.append('      throw new Error(\n')
        output.append('        `Storage limit exceeded. Maximum ${maxGB} GB allowed. ` +\n')
        output.append('        `Currently using ${usedGB} GB. Please delete old messages to free space.`\n')
        output.append('      );\n')
        output.append('    }\n')
        output.append('  }\n')
        output.append('\n')
        output.append(line)
        i += 1
        continue

    # 5. Add validation and storage tracking in handleSendMessage
    if '    await fs.writeFile(filePath, JSON.stringify(message, null, 2));' in line:
        # Add validation before this line
        output.append('\n')
        output.append('    // Validate message limits\n')
        output.append('    await this.validateMessageLimits(content, subject);\n')
        output.append('\n')
        output.append(line)
        output.append('\n')
        output.append('    // Update storage metrics\n')
        output.append('    const fileStats = await fs.stat(filePath);\n')
        output.append('    this.metrics.total_storage_bytes += fileStats.size;\n')
        i += 1
        continue

    # 6. Update handleDeleteMessage to track storage
    if '    try {\n      await fs.unlink(filePath);' in ''.join(lines[i:i+2]):
        output.append('    try {\n')
        output.append('      // Get file size before deleting\n')
        output.append('      let fileSize = 0;\n')
        output.append('      try {\n')
        output.append('        const stats = await fs.stat(filePath);\n')
        output.append('        fileSize = stats.size;\n')
        output.append('      } catch {\n')
        output.append('        // File doesn\'t exist or can\'t stat\n')
        output.append('      }\n')
        output.append('\n')
        i += 1  # Skip the 'try {' line
        output.append(lines[i])  # Add the unlink line
        output.append('\n')
        output.append('      // Update storage metrics\n')
        output.append('      if (fileSize > 0) {\n')
        output.append('        this.metrics.total_storage_bytes = Math.max(0, this.metrics.total_storage_bytes - fileSize);\n')
        output.append('        this.saveMetrics().catch((error) => console.error("[Metrics Update Error]", error));\n')
        output.append('      }\n')
        i += 1
        continue

    # 7. Update handleClearMessages - add deletedBytes tracking
    if '    let deletedCount = 0;' in line and 'deletedBytes' not in ''.join(lines[max(0,i-5):i+5]):
        output.append(line)
        output.append('    let deletedBytes = 0;\n')
        i += 1
        continue

    # 8. Track bytes in clear loop
    if '        try {\n          await fs.unlink(filePath);' in ''.join(lines[i:i+2]) and 'handleClearMessages' in ''.join(lines[max(0,i-50):i]):
        output.append('        try {\n')
        output.append('          // Get file size before deleting\n')
        output.append('          try {\n')
        output.append('            const stats = await fs.stat(filePath);\n')
        output.append('            deletedBytes += stats.size;\n')
        output.append('          } catch {\n')
        output.append('            // Can\'t stat file\n')
        output.append('          }\n')
        output.append('\n')
        i += 1  # Skip 'try {'
        output.append(lines[i])  # Add unlink line
        i += 1
        continue

    # 9. Update storage metrics after clearing agent messages
    if '      await this.clearAgentFromIndex(agent);' in line and 'deletedBytes' in ''.join(output[-20:]):
        output.append(line)
        output.append('\n')
        output.append('      // Update storage metrics\n')
        output.append('      if (deletedBytes > 0) {\n')
        output.append('        this.metrics.total_storage_bytes = Math.max(0, this.metrics.total_storage_bytes - deletedBytes);\n')
        output.append('        await this.saveMetrics();\n')
        output.append('      }\n')
        i += 1
        continue

    # 10. Update storage metrics after clearing all messages
    if '      this.messageCache.clear();' in line and 'handleClearMessages' in ''.join(lines[max(0,i-100):i]):
        output.append(line)
        output.append('\n')
        output.append('      // Update storage metrics\n')
        output.append('      if (deletedBytes > 0) {\n')
        output.append('        this.metrics.total_storage_bytes = Math.max(0, this.metrics.total_storage_bytes - deletedBytes);\n')
        output.append('        await this.saveMetrics();\n')
        output.append('      }\n')
        i += 1
        continue

    # Default: copy line as-is
    output.append(line)
    i += 1

# Write output
with open('src/index.ts', 'w') as f:
    f.writelines(output)

print("✓ Applied all resource limit security fixes!")
