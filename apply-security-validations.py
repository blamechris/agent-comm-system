#!/usr/bin/env python3
"""
Apply security validations to all handler methods in src/index.ts
"""

with open('src/index.ts', 'r') as f:
    lines = f.readlines()

# Insert validateAgentName method after ensureStorageDir
new_lines = []
i = 0
while i < len(lines):
    new_lines.append(lines[i])

    # 1. Add validateAgentName method after ensureStorageDir
    if i > 0 and '  private async ensureStorageDir(): Promise<void> {' in lines[i]:
        # Find the closing brace
        brace_count = 1
        j = i + 1
        while j < len(lines) and brace_count > 0:
            new_lines.append(lines[j])
            if '{' in lines[j]:
                brace_count += 1
            if '}' in lines[j]:
                brace_count -= 1
            j += 1

        # Add the validateAgentName method
        new_lines.append('\n')
        new_lines.append('  /**\n')
        new_lines.append('   * Validate agent name to prevent path traversal attacks\n')
        new_lines.append('   */\n')
        new_lines.append("  private validateAgentName(agent: string): void {\n")
        new_lines.append("    if (!agent || typeof agent !== 'string') {\n")
        new_lines.append("      throw new Error('Agent name must be a non-empty string');\n")
        new_lines.append("    }\n")
        new_lines.append("\n")
        new_lines.append("    if (!/^[a-zA-Z0-9_-]+$/.test(agent)) {\n")
        new_lines.append("      throw new Error('Invalid agent name. Must contain only letters, numbers, underscores, and hyphens.');\n")
        new_lines.append("    }\n")
        new_lines.append("\n")
        new_lines.append("    if (agent.length > 255) {\n")
        new_lines.append("      throw new Error('Agent name too long. Maximum 255 characters.');\n")
        new_lines.append("    }\n")
        new_lines.append("\n")
        new_lines.append("    if (agent.trim() !== agent) {\n")
        new_lines.append("      throw new Error('Agent name cannot start or end with whitespace.');\n")
        new_lines.append("    }\n")
        new_lines.append("  }\n")

        i = j - 1

    # 2. Add validation in rebuildIndex
    elif '          const agent = dirent.name;' in lines[i] and i > 5 and 'rebuildIndex' in ''.join(lines[max(0,i-50):i]):
        new_lines.append('\n')
        new_lines.append('          // Validate directory name - skip invalid directories\n')
        new_lines.append('          try {\n')
        new_lines.append('            this.validateAgentName(agent);\n')
        new_lines.append('          } catch (error) {\n')
        new_lines.append('            console.error(`[Index Rebuild] Skipping invalid directory: ${agent}`, error instanceof Error ? error.message : error);\n')
        new_lines.append('            continue;\n')
        new_lines.append('          }\n')

    # 3. Add validation in rebuildMetrics
    elif '          const agent = dirent.name;' in lines[i] and i > 5 and 'rebuildMetrics' in ''.join(lines[max(0,i-50):i]):
        new_lines.append('\n')
        new_lines.append('          // Validate directory name - skip invalid directories\n')
        new_lines.append('          try {\n')
        new_lines.append('            this.validateAgentName(agent);\n')
        new_lines.append('          } catch (error) {\n')
        new_lines.append('            console.error(`[Metrics Rebuild] Skipping invalid directory: ${agent}`, error instanceof Error ? error.message : error);\n')
        new_lines.append('            continue;\n')
        new_lines.append('          }\n')

    # 4. Add validation in handleSendMessage
    elif '    const timestamp = new Date().toISOString();' in lines[i] and i > 5 and 'handleSendMessage' in ''.join(lines[max(0,i-15):i]):
        new_lines.append('    // Validate agent names to prevent path traversal\n')
        new_lines.append('    this.validateAgentName(from);\n')
        new_lines.append('    this.validateAgentName(to);\n')
        new_lines.append('\n')

    # 5. Add validation in handleReadMessages
    elif '    // Use index to get message IDs for this agent' in lines[i] and 'handleReadMessages' in ''.join(lines[max(0,i-10):i]):
        new_lines.append('    // Validate agent name to prevent path traversal\n')
        new_lines.append('    this.validateAgentName(agent);\n')
        new_lines.append('\n')

    # 6. Add validation in handleListMessages
    elif '    const messageList: Array<MessageMetadata & { id: string }> = [];' in lines[i] and 'handleListMessages' in ''.join(lines[max(0,i-5):i]):
        new_lines.append('    // Validate agent name if provided\n')
        new_lines.append('    if (agent) {\n')
        new_lines.append('      this.validateAgentName(agent);\n')
        new_lines.append('    }\n')
        new_lines.append('\n')

    # 7. Add validation in handleDeleteMessage
    elif '    const fileName = `${message_id}.json`;' in lines[i] and i > 1 and 'foundAgent' in lines[i-2]:
        new_lines.append('    // Validate the agent name (defense in depth - in case index was tampered with)\n')
        new_lines.append('    this.validateAgentName(foundAgent);\n')
        new_lines.append('\n')

    # 8. Add validation in handleClearMessages
    elif '    let deletedCount = 0;' in lines[i] and i > 2 and 'handleClearMessages' in ''.join(lines[max(0,i-5):i]):
        new_lines.append('\n')
        new_lines.append('    // Validate agent name if provided\n')
        new_lines.append('    if (agent) {\n')
        new_lines.append('      this.validateAgentName(agent);\n')
        new_lines.append('    }\n')

    # 9. Add validation in handleGetAgentStats
    elif 'if (agent) {' in lines[i] and i > 1 and 'handleGetAgentStats' in ''.join(lines[max(0,i-5):i]) and '// Get stats for specific agent' in ''.join(lines[i:min(len(lines),i+2)]):
        new_lines.append('    // Validate agent name if provided\n')
        new_lines.append('    if (agent) {\n')
        new_lines.append('      this.validateAgentName(agent);\n')
        new_lines.append('    }\n')
        new_lines.append('\n')

    # 10. Add validation in handleGetActivityStats
    elif '    let dailyActivity = { ...this.metrics.daily_activity };' in lines[i] and 'handleGetActivityStats' in ''.join(lines[max(0,i-10):i]):
        new_lines.append('    // Validate agent name if provided\n')
        new_lines.append('    if (agent) {\n')
        new_lines.append('      this.validateAgentName(agent);\n')
        new_lines.append('    }\n')
        new_lines.append('\n')

    i += 1

# Write the modified content
with open('src/index.ts', 'w') as f:
    f.writelines(new_lines)

print("Security validations applied successfully!")
print(f"Original lines: {len(lines)}")
print(f"New lines: {len(new_lines)}")
