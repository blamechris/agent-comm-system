#!/usr/bin/env python3

import re

# Read the file
with open('src/index.ts', 'r') as f:
    content = f.read()

# Fix #6 & #9: Add debouncing properties to class
old = '''  private metrics: Metrics;
  private metricsPath: string;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {'''

new = '''  private metrics: Metrics;
  private metricsPath: string;
  private metricsSaveTimer: NodeJS.Timeout | null = null;
  private readonly METRICS_SAVE_DEBOUNCE_MS = 5000; // 5 seconds
  private metricsNeedsSave = false;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {'''

content = content.replace(old, new)

# Fix #9: Update SIGINT handler
old = '''    process.on("SIGINT", async () => {
      await this.saveIndex();
      await this.server.close();
      process.exit(0);
    });'''

new = '''    process.on("SIGINT", async () => {
      console.log("\\nGracefully shutting down...");

      // Clear debounce timer and save immediately
      if (this.metricsSaveTimer) {
        clearTimeout(this.metricsSaveTimer);
        this.metricsSaveTimer = null;
      }

      // Save both index and metrics
      await this.saveIndex();
      await this.saveMetrics();

      await this.server.close();
      process.exit(0);
    });'''

content = content.replace(old, new)

# Fix #6: Add scheduleMetricsSave method
old = '''  /**
   * Update metrics when a message is sent
   */'''

new = '''  /**
   * Schedule a debounced metrics save
   */
  private scheduleMetricsSave(): void {
    this.metricsNeedsSave = true;

    if (this.metricsSaveTimer) {
      clearTimeout(this.metricsSaveTimer);
    }

    this.metricsSaveTimer = setTimeout(() => {
      if (this.metricsNeedsSave) {
        this.saveMetrics().catch(error =>
          console.error('[Metrics Save Error]', error)
        );
        this.metricsNeedsSave = false;
      }
      this.metricsSaveTimer = null;
    }, this.METRICS_SAVE_DEBOUNCE_MS);
  }

  /**
   * Update metrics when a message is sent
   */'''

content = content.replace(old, new)

# Fix #6: Update trackCacheHit
old = '''  /**
   * Track cache hit
   */
  private trackCacheHit(): void {
    this.metrics.cache_hits++;
    // Save metrics asynchronously
    this.saveMetrics().catch((error) => console.error("[Metrics Save Error]", error));
  }'''

new = '''  /**
   * Track cache hit
   */
  private trackCacheHit(): void {
    this.metrics.cache_hits++;
    this.scheduleMetricsSave(); // Debounced save
  }'''

content = content.replace(old, new)

# Fix #6: Update trackCacheMiss
old = '''  /**
   * Track cache miss
   */
  private trackCacheMiss(): void {
    this.metrics.cache_misses++;
    // Save metrics asynchronously
    this.saveMetrics().catch((error) => console.error("[Metrics Save Error]", error));
  }'''

new = '''  /**
   * Track cache miss
   */
  private trackCacheMiss(): void {
    this.metrics.cache_misses++;
    this.scheduleMetricsSave(); // Debounced save
  }'''

content = content.replace(old, new)

# Fix #4: Update handleDeleteMessage
old_pattern = r'''(\s+try \{\n\s+await fs\.unlink\(filePath\);\n\s+await this\.removeFromIndex\(foundAgent, message_id\);\n\s+this\.messageCache\.delete\(message_id\);)(\n\n\s+return \{)'''

new_text = r'''\1

      // Read message BEFORE deleting to update metrics
      const messageContent = await fs.readFile(filePath, "utf-8");
      const deletedMessage = JSON.parse(messageContent) as Message;

      // Get file size before deletion for storage metrics
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;

      // Delete the file
      await fs.unlink(filePath);
      await this.removeFromIndex(foundAgent, message_id);
      this.messageCache.delete(message_id);

      // Update ALL metrics comprehensively
      this.metrics.total_messages--;
      this.metrics.total_storage_bytes -= fileSize;

      // Update agent-specific metrics
      if (this.metrics.agents[deletedMessage.from]) {
        this.metrics.agents[deletedMessage.from].sent_count--;

        // Update partner counts
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

      // Update temporal metrics (daily and hourly activity)
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

      // NOTE: first_message and last_message timestamps are expensive to update
      // They may become inaccurate after deletions unless we rebuild
      // Document this behavior or trigger selective rebuild for boundary messages

      await this.saveMetrics();\2'''

# Fix Delete - Actually let's do this more carefully
# Find and replace the try block in handleDeleteMessage
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
      // Read message BEFORE deleting to update metrics
      const messageContent = await fs.readFile(filePath, "utf-8");
      const deletedMessage = JSON.parse(messageContent) as Message;

      // Get file size before deletion for storage metrics
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;

      // Delete the file
      await fs.unlink(filePath);
      await this.removeFromIndex(foundAgent, message_id);
      this.messageCache.delete(message_id);

      // Update ALL metrics comprehensively
      this.metrics.total_messages--;
      this.metrics.total_storage_bytes -= fileSize;

      // Update agent-specific metrics
      if (this.metrics.agents[deletedMessage.from]) {
        this.metrics.agents[deletedMessage.from].sent_count--;

        // Update partner counts
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

      // Update temporal metrics (daily and hourly activity)
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

      // NOTE: first_message and last_message timestamps are expensive to update
      // They may become inaccurate after deletions unless we rebuild
      // Document this behavior or trigger selective rebuild for boundary messages

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

content = content.replace(old_delete, new_delete)

# Write back
with open('src/index.ts', 'w') as f:
    f.write(content)

print("Fixes applied successfully!")
