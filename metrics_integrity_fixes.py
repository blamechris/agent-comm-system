#!/usr/bin/env python3
"""Apply all metrics integrity fixes"""

with open('src/index.ts', 'r') as f:
    content = f.read()

print("Applying all metrics integrity fixes...")

# Fix 1-3: Add debouncing properties, SIGINT handler, and scheduleMetricsSave method
changes = [
    # Add debouncing properties
    ('  private metrics: Metrics;\n  private metricsPath: string;\n\n  constructor',
     '  private metrics: Metrics;\n  private metricsPath: string;\n  private metricsSaveTimer: NodeJS.Timeout | null = null;\n  private readonly METRICS_SAVE_DEBOUNCE_MS = 5000;\n  private metricsNeedsSave = false;\n\n  constructor'),

    # Update SIGINT handler
    ('    process.on("SIGINT", async () => {\n      await this.saveIndex();\n      await this.server.close();\n      process.exit(0);\n    });',
     '    process.on("SIGINT", async () => {\n      console.log("\\nGracefully shutting down...");\n      if (this.metricsSaveTimer) {\n        clearTimeout(this.metricsSaveTimer);\n        this.metricsSaveTimer = null;\n      }\n      await this.saveIndex();\n      await this.saveMetrics();\n      await this.server.close();\n      process.exit(0);\n    });'),

    # Add scheduleMetricsSave method
    ('  /**\n   * Update metrics when a message is sent\n   */',
     '  /**\n   * Schedule a debounced metrics save\n   */\n  private scheduleMetricsSave(): void {\n    this.metricsNeedsSave = true;\n    if (this.metricsSaveTimer) {\n      clearTimeout(this.metricsSaveTimer);\n    }\n    this.metricsSaveTimer = setTimeout(() => {\n      if (this.metricsNeedsSave) {\n        this.saveMetrics().catch(error => console.error(\'[Metrics Save Error]\', error));\n        this.metricsNeedsSave = false;\n      }\n      this.metricsSaveTimer = null;\n    }, this.METRICS_SAVE_DEBOUNCE_MS);\n  }\n\n  /**\n   * Update metrics when a message is sent\n   */'),

    # Update trackCacheHit
    ('  private trackCacheHit(): void {\n    this.metrics.cache_hits++;\n    // Save metrics asynchronously\n    this.saveMetrics().catch((error) => console.error("[Metrics Save Error]", error));\n  }',
     '  private trackCacheHit(): void {\n    this.metrics.cache_hits++;\n    this.scheduleMetricsSave();\n  }'),

    # Update trackCacheMiss
    ('  private trackCacheMiss(): void {\n    this.metrics.cache_misses++;\n    // Save metrics asynchronously\n    this.saveMetrics().catch((error) => console.error("[Metrics Save Error]", error));\n  }',
     '  private trackCacheMiss(): void {\n    this.metrics.cache_misses++;\n    this.scheduleMetricsSave();\n  }'),
]

for old, new in changes:
    if old in content:
        content = content.replace(old, new)
        print(f"✓ Applied change")
    else:
        print(f"✗ Warning: Could not find pattern")

# Now apply comprehensive handleDeleteMessage fix
old_delete = '''    try {
      await fs.unlink(filePath);
      await this.removeFromIndex(foundAgent, message_id);
      this.messageCache.delete(message_id);

      return {
        content: [
          {
            type: "text",
            text: `Message ${message_id} deleted successfully`,
          },
        ],
      };
    } catch {
      throw new Error(`Failed to delete message: ${message_id} not found`);
    }
  }

  private async handleClearMessages'''

new_delete = '''    try {
      const messageContent = await fs.readFile(filePath, "utf-8");
      const deletedMessage = JSON.parse(messageContent) as Message;
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;

      await fs.unlink(filePath);
      await this.removeFromIndex(foundAgent, message_id);
      this.messageCache.delete(message_id);

      this.metrics.total_messages--;
      this.metrics.total_storage_bytes -= fileSize;

      if (this.metrics.agents[deletedMessage.from]) {
        this.metrics.agents[deletedMessage.from].sent_count--;
        const partners = this.metrics.agents[deletedMessage.from].most_active_partners;
        if (partners[deletedMessage.to]) {
          partners[deletedMessage.to]--;
          if (partners[deletedMessage.to] === 0) delete partners[deletedMessage.to];
        }
      }

      if (this.metrics.agents[deletedMessage.to]) {
        this.metrics.agents[deletedMessage.to].received_count--;
      }

      const date = new Date(deletedMessage.timestamp);
      const dateStr = date.toISOString().split("T")[0];
      const hour = date.getHours().toString();

      if (dateStr && this.metrics.daily_activity[dateStr]) {
        this.metrics.daily_activity[dateStr]--;
        if (this.metrics.daily_activity[dateStr] === 0) delete this.metrics.daily_activity[dateStr];
      }

      if (this.metrics.hourly_activity[hour]) {
        this.metrics.hourly_activity[hour]--;
        if (this.metrics.hourly_activity[hour] === 0) delete this.metrics.hourly_activity[hour];
      }

      await this.saveMetrics();

      return {
        content: [
          {
            type: "text",
            text: `Message ${message_id} deleted successfully`,
          },
        ],
      };
    } catch {
      throw new Error(`Failed to delete message: ${message_id} not found`);
    }
  }

  private async handleClearMessages'''

if old_delete in content:
    content = content.replace(old_delete, new_delete)
    print("✓ Updated handleDeleteMessage")

with open('src/index.ts', 'w') as f:
    f.write(content)

print("\n✓ All fixes applied!")
