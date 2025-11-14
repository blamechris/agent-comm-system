#!/bin/bash
set -e

cd /home/user/agent-comm-system

# Backup
cp src/index.ts src/index.ts.bak

# 1. Add randomUUID import
sed -i '/import \* as os from "os";/a import { randomUUID } from "crypto";' src/index.ts

# 2. Add storage limit constants
sed -i '/const DEFAULT_PAGE_LIMIT = 50;/a\\n// Storage limits (configurable via environment variables)\nconst MAX_MESSAGE_SIZE = parseInt(process.env.MAX_MESSAGE_SIZE || "1048576"); // 1 MB default\nconst MAX_TOTAL_STORAGE = parseInt(process.env.MAX_TOTAL_STORAGE || "1073741824"); // 1 GB default\nconst MAX_SUBJECT_LENGTH = parseInt(process.env.MAX_SUBJECT_LENGTH || "500"); // 500 characters default' src/index.ts

# 3. Fix message ID generation - replace single line
sed -i 's/const messageId = `\${from}-\${Date\.now()}`/const timestampNum = Date.now();\n    const uniqueSuffix = randomUUID().split("-")[0];\n    const messageId = `\${from}-\${timestampNum}-\${uniqueSuffix}`/' src/index.ts

# 4. Add validateMessageLimits method - insert before calculateStorageSize
LINE=$(grep -n "Calculate storage size efficiently" src/index.ts | head -1 | cut -d: -f1)
sed -i "${LINE}i\\  /**\\n   * Validate message size and storage limits\\n   */\\n  private async validateMessageLimits(\\n    content: string,\\n    subject?: string\\n  ): Promise<void> {\\n    const messageSize = Buffer.byteLength(content, \"utf-8\") +\\n                        (subject ? Buffer.byteLength(subject, \"utf-8\") : 0);\\n\\n    if (messageSize > MAX_MESSAGE_SIZE) {\\n      throw new Error(\\n        \`Message exceeds maximum size of \${MAX_MESSAGE_SIZE} bytes (\${Math.ceil(MAX_MESSAGE_SIZE / 1024)} KB). \` +\\n        \`Your message is \${messageSize} bytes (\${Math.ceil(messageSize / 1024)} KB).\`\\n      );\\n    }\\n\\n    if (subject && subject.length > MAX_SUBJECT_LENGTH) {\\n      throw new Error(\\n        \`Subject exceeds maximum length of \${MAX_SUBJECT_LENGTH} characters. \` +\\n        \`Your subject is \${subject.length} characters.\`\\n      );\\n    }\\n\\n    if (this.metrics.total_storage_bytes + messageSize > MAX_TOTAL_STORAGE) {\\n      const usedGB = (this.metrics.total_storage_bytes / (1024 * 1024 * 1024)).toFixed(2);\\n      const maxGB = (MAX_TOTAL_STORAGE / (1024 * 1024 * 1024)).toFixed(2);\\n      throw new Error(\\n        \`Storage limit exceeded. Maximum \${maxGB} GB allowed. \` +\\n        \`Currently using \${usedGB} GB. Please delete old messages to free space.\`\\n      );\\n    }\\n  }\\n\\n" src/index.ts

# 5. Add validation call and storage tracking in handleSendMessage
# Insert validation before writeFile
sed -i '/await fs.writeFile(filePath, JSON.stringify(message, null, 2));/i\\    \/\/ Validate message limits\n    await this.validateMessageLimits(content, subject);\n' src/index.ts

# Insert storage tracking after writeFile
sed -i '/await fs.writeFile(filePath, JSON.stringify(message, null, 2));/a\\    \/\/ Update storage metrics\n    const fileStats = await fs.stat(filePath);\n    this.metrics.total_storage_bytes += fileStats.size;' src/index.ts

echo "✓ Applied all resource limit security fixes successfully!"
npm run build
