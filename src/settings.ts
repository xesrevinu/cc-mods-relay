import * as fs from "node:fs";
import * as path from "node:path";
import {
  filterEscalatingDefaultMode,
  resolveSettings,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CONFIG_DIR } from "./acp-agent.js";

function getManagedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

export interface SettingsManagerOptions {
  onChange?: () => void;
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
}

export class SettingsManager {
  private cwd: string;
  private effective: Settings = {};
  private watchers: fs.FSWatcher[] = [];
  private onChange?: () => void;
  private logger: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  private initialized = false;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(cwd: string, options?: SettingsManagerOptions) {
    this.cwd = cwd;
    this.onChange = options?.onChange;
    this.logger = options?.logger ?? console;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.disposed = false;
    this.initPromise = this.loadAllSettings().then(() => {
      if (!this.disposed) {
        this.setupWatchers();
        this.initialized = true;
      }
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private getWatchedPaths(): string[] {
    return [
      path.join(CLAUDE_CONFIG_DIR, "settings.json"),
      path.join(this.cwd, ".claude", "settings.json"),
      path.join(this.cwd, ".claude", "settings.local.json"),
      getManagedSettingsPath(),
    ];
  }

  private async loadAllSettings(): Promise<void> {
    try {
      const resolved = await resolveSettings({ cwd: this.cwd });
      this.effective = filterEscalatingDefaultMode(resolved);
    } catch (error) {
      this.logger.error("Failed to resolve settings:", error);
      this.effective = {};
    }
  }

  private setupWatchers(): void {
    for (const filePath of this.getWatchedPaths()) {
      try {
        const dir = path.dirname(filePath);
        const filename = path.basename(filePath);

        if (fs.existsSync(dir)) {
          const watcher = fs.watch(dir, (eventType, changedFilename) => {
            if (changedFilename === filename) {
              this.handleSettingsChange();
            }
          });
          watcher.unref?.();

          watcher.on("error", (error) => {
            this.logger.error(`Settings watcher error for ${filePath}:`, error);
          });

          this.watchers.push(watcher);
        }
      } catch (error) {
        this.logger.error(`Failed to set up watcher for ${filePath}:`, error);
      }
    }
  }

  private handleSettingsChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      if (this.disposed) {
        return;
      }
      try {
        await this.loadAllSettings();
        if (!this.disposed) {
          this.onChange?.();
        }
      } catch (error) {
        this.logger.error("Failed to reload settings:", error);
      }
    }, 100);
    this.debounceTimer?.unref?.();
  }

  getSettings(): Settings {
    return this.effective;
  }

  getCwd(): string {
    return this.cwd;
  }

  async setCwd(cwd: string): Promise<void> {
    if (this.cwd === cwd) {
      return;
    }

    this.dispose();
    this.cwd = cwd;
    await this.initialize();
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    this.initPromise = null;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
