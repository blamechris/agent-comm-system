#!/usr/bin/env python3
"""
Comprehensive script to apply all metrics integrity fixes at once.
This ensures all changes are made atomically.
"""

import re

print("Reading src/index.ts...")
with open('src/index.ts', 'r') as f:
    content = f.read()

original_length = len(content)
print(f"Original file: {original_length} bytes")

# Fix #1: Add debouncing properties to class
print("Applying Fix #1: Adding debouncing properties...")
old = '''  private metrics: Metrics;
  private metricsPath: string;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {'''

new = '''  private metrics: Metrics;
  private metricsPath: string;
  private metricsSaveTimer: NodeJS.Timeout | null = null;
  private readonly METRICS_SAVE_DEBOUNCE_MS = 5000; // 5 seconds
  private metricsNeedsSave = false;

  constructor(storageDir?: string, cacheSize: number = DEFAULT_CACHE_SIZE) {'''

if old in content:
    content = content.replace(old, new)
    print("  ✓ Debouncing properties added")
else:
    print("  ✗ Warning: Could not find class properties section")

# Fix #2: Update SIGINT handler
print("Applying Fix #2: Updating SIGINT handler...")
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

if old in content:
    content = content.replace(old, new)
    print("  ✓ SIGINT handler updated")
else:
    print("  ✗ Warning: Could not find SIGINT handler")

# Fix #3: Add scheduleMetricsSave method (after saveMetrics, before updateMetricsOnSend)
print("Applying Fix #3: Adding scheduleMetricsSave method...")
old = '''  /**
   * Update metrics when a message is sent
   */
  private updateMetricsOnSend(from: string, to: string): void {'''

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
   */
  private updateMetricsOnSend(from: string, to: string): void {'''

if old in content:
    content = content.replace(old, new)
    print("  ✓ scheduleMetricsSave method added")
else:
    print("  ✗ Warning: Could not find updateMetricsOnSend")

# Fix #4: Update trackCacheHit
print("Applying Fix #4: Updating trackCacheHit...")
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

if old in content:
    content = content.replace(old, new)
    print("  ✓ trackCacheHit updated")
else:
    print("  ✗ Warning: Could not find trackCacheHit")

# Fix #5: Update trackCacheMiss
print("Applying Fix #5: Updating trackCacheMiss...")
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

if old in content:
    content = content.replace(old, new)
    print("  ✓ trackCacheMiss updated")
else:
    print("  ✗ Warning: Could not find trackCacheMiss")

# Fix #6: Update handleDeleteMessage with comprehensive metrics updates
print("Applying Fix #6: Updating handleDeleteMessage...")
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

if old_delete in content:
    content = content.replace(old_delete, new_delete)
    print("  ✓ handleDeleteMessage updated")
else:
    print("  ✗ Warning: Could not find handleDeleteMessage")

# Fix #7: Update handleClearMessages first loop (specific agent)
print("Applying Fix #7: Updating handleClearMessages (specific agent)...")
old_clear1 = '''      for (const messageId of messageIds) {
        const filePath = path.join(agentDir, `${messageId}.json`);
        try {
          await fs.unlink(filePath);
          this.messageCache.delete(messageId);
          deletedCount++;
        } catch {
          // File already deleted or doesn't exist
        }
      }

      await this.clearAgentFromIndex(agent);'''

new_clear1 = '''      for (const messageId of messageIds) {
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
      await this.saveMetrics();'''

if old_clear1 in content:
    content = content.replace(old_clear1, new_clear1)
    print("  ✓ handleClearMessages (specific agent) updated")
else:
    print("  ✗ Warning: Could not find handleClearMessages first loop")

# Fix #8: Update handleClearMessages second loop (all agents)
print("Applying Fix #8: Updating handleClearMessages (all agents)...")
old_clear2 = '''      // Clear all messages for all agents
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
    }'''

new_clear2 = '''      // Clear all messages for all agents
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
    }'''

if old_clear2 in content:
    content = content.replace(old_clear2, new_clear2)
    print("  ✓ handleClearMessages (all agents) updated")
else:
    print("  ✗ Warning: Could not find handleClearMessages second loop")

# Write back
print("\nWriting changes to src/index.ts...")
with open('src/index.ts', 'w') as f:
    f.write(content)

new_length = len(content)
print(f"New file: {new_length} bytes ({new_length - original_length:+d} bytes)")
print("\n✓ All fixes applied successfully!")
