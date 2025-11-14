#!/usr/bin/env python3

# Read the file
with open('src/index.ts', 'r') as f:
    content = f.read()

# Fix #4: Update handleClearMessages with comprehensive metrics updates
old_clear = '''  private async handleClearMessages(args: ClearMessagesArgs) {
    const { agent } = args;
    let deletedCount = 0;

    if (agent) {
      // Clear messages for specific agent
      const messageIds = this.messageIndex[agent] || [];
      const agentDir = this.getAgentDir(agent);

      for (const messageId of messageIds) {
        const filePath = path.join(agentDir, `${messageId}.json`);
        try {
          await fs.unlink(filePath);
          this.messageCache.delete(messageId);
          deletedCount++;
        } catch {
          // File already deleted or doesn't exist
        }
      }

      await this.clearAgentFromIndex(agent);

      // Try to remove the agent directory if it's empty
      try {
        await fs.rmdir(agentDir);
      } catch {
        // Directory not empty or doesn't exist, that's okay
      }
    } else {
      // Clear all messages for all agents
      for (const [agentName, messageIds] of Object.entries(this.messageIndex)) {
        const agentDir = this.getAgentDir(agentName);

        for (const messageId of messageIds) {
          const filePath = path.join(agentDir, `${messageId}.json`);
          try {
            await fs.unlink(filePath);
            this.messageCache.delete(messageId);
            deletedCount++;
          } catch {
            // File already deleted
          }
        }

        // Try to remove the agent directory
        try {
          await fs.rmdir(agentDir);
        } catch {
          // Directory not empty or doesn't exist
        }
      }

      // Clear the entire index
      this.messageIndex = {};
      await this.saveIndex();
      this.messageCache.clear();
    }

    return {
      content: [
        {
          type: "text",
          text: agent
            ? `Cleared ${deletedCount} message(s) for agent: ${agent}`
            : `Cleared all ${deletedCount} message(s) from the system`,
        },
      ],
    };
  }'''

new_clear = '''  private async handleClearMessages(args: ClearMessagesArgs) {
    const { agent } = args;
    let deletedCount = 0;

    if (agent) {
      // Clear messages for specific agent
      const messageIds = this.messageIndex[agent] || [];
      const agentDir = this.getAgentDir(agent);

      for (const messageId of messageIds) {
        const filePath = path.join(agentDir, `${messageId}.json`);
        try {
          // Read message before deleting to update metrics
          const messageContent = await fs.readFile(filePath, "utf-8");
          const deletedMessage = JSON.parse(messageContent) as Message;
          const stats = await fs.stat(filePath);
          const fileSize = stats.size;

          await fs.unlink(filePath);
          this.messageCache.delete(messageId);
          deletedCount++;

          // Update metrics
          this.metrics.total_messages--;
          this.metrics.total_storage_bytes -= fileSize;

          // Update agent-specific metrics
          if (this.metrics.agents[deletedMessage.from]) {
            this.metrics.agents[deletedMessage.from].sent_count--;
            const partners = this.metrics.agents[deletedMessage.from].most_active_partners;
            if (partners[deletedMessage.to]) {
              partners[deletedMessage.to]--;
              if (partners[deletedMessage.to] === 0) {
                delete partners[deletedMessage.to];
              }
            }
          }

          if (this.metrics.agents[deletedMessage.to]) {
            this.metrics.agents[deletedMessage.to].received_count--;
          }

          // Update temporal metrics
          const date = new Date(deletedMessage.timestamp);
          const dateStr = date.toISOString().split("T")[0];
          const hour = date.getHours().toString();

          if (dateStr && this.metrics.daily_activity[dateStr]) {
            this.metrics.daily_activity[dateStr]--;
            if (this.metrics.daily_activity[dateStr] === 0) {
              delete this.metrics.daily_activity[dateStr];
            }
          }

          if (this.metrics.hourly_activity[hour]) {
            this.metrics.hourly_activity[hour]--;
            if (this.metrics.hourly_activity[hour] === 0) {
              delete this.metrics.hourly_activity[hour];
            }
          }
        } catch {
          // File already deleted or doesn't exist
        }
      }

      await this.clearAgentFromIndex(agent);
      await this.saveMetrics();

      // Try to remove the agent directory if it's empty
      try {
        await fs.rmdir(agentDir);
      } catch {
        // Directory not empty or doesn't exist, that's okay
      }
    } else {
      // Clear all messages for all agents
      for (const [agentName, messageIds] of Object.entries(this.messageIndex)) {
        const agentDir = this.getAgentDir(agentName);

        for (const messageId of messageIds) {
          const filePath = path.join(agentDir, `${messageId}.json`);
          try {
            // Read message before deleting to update metrics
            const messageContent = await fs.readFile(filePath, "utf-8");
            const deletedMessage = JSON.parse(messageContent) as Message;
            const stats = await fs.stat(filePath);
            const fileSize = stats.size;

            await fs.unlink(filePath);
            this.messageCache.delete(messageId);
            deletedCount++;

            // Update metrics
            this.metrics.total_messages--;
            this.metrics.total_storage_bytes -= fileSize;

            // Update agent-specific metrics
            if (this.metrics.agents[deletedMessage.from]) {
              this.metrics.agents[deletedMessage.from].sent_count--;
              const partners = this.metrics.agents[deletedMessage.from].most_active_partners;
              if (partners[deletedMessage.to]) {
                partners[deletedMessage.to]--;
                if (partners[deletedMessage.to] === 0) {
                  delete partners[deletedMessage.to];
                }
              }
            }

            if (this.metrics.agents[deletedMessage.to]) {
              this.metrics.agents[deletedMessage.to].received_count--;
            }

            // Update temporal metrics
            const date = new Date(deletedMessage.timestamp);
            const dateStr = date.toISOString().split("T")[0];
            const hour = date.getHours().toString();

            if (dateStr && this.metrics.daily_activity[dateStr]) {
              this.metrics.daily_activity[dateStr]--;
              if (this.metrics.daily_activity[dateStr] === 0) {
                delete this.metrics.daily_activity[dateStr];
              }
            }

            if (this.metrics.hourly_activity[hour]) {
              this.metrics.hourly_activity[hour]--;
              if (this.metrics.hourly_activity[hour] === 0) {
                delete this.metrics.hourly_activity[hour];
              }
            }
          } catch {
            // File already deleted
          }
        }

        // Try to remove the agent directory
        try {
          await fs.rmdir(agentDir);
        } catch {
          // Directory not empty or doesn't exist
        }
      }

      // Clear the entire index
      this.messageIndex = {};
      await this.saveIndex();
      this.messageCache.clear();

      // Reset all metrics since everything is cleared
      this.metrics = {
        total_messages: 0,
        total_storage_bytes: 0,
        cache_hits: this.metrics.cache_hits, // Preserve cache stats
        cache_misses: this.metrics.cache_misses,
        agents: {},
        daily_activity: {},
        hourly_activity: {},
        last_updated: new Date().toISOString(),
      };
      await this.saveMetrics();
    }

    return {
      content: [
        {
          type: "text",
          text: agent
            ? `Cleared ${deletedCount} message(s) for agent: ${agent}`
            : `Cleared all ${deletedCount} message(s) from the system`,
        },
      ],
    };
  }'''

content = content.replace(old_clear, new_clear)

# Write back
with open('src/index.ts', 'w') as f:
    f.write(content)

print("handleClearMessages updated successfully!")
