import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { PulseConfig } from "./models.js";

const CONFIG_DIR = join(homedir(), ".agent-heart");
const CONFIG_FILE = "config.json";
const DB_FILE = "pulse.db";

export const DEFAULT_CONFIG: PulseConfig = {
  server: {
    host: "127.0.0.1",
    port: 7778,
  },
  monitor: {
    check_interval_ms: 30_000,
    default_expected_cycle_ms: 300_000, // 5 minutes
    default_max_silence_ms: 600_000, // 10 minutes
  },
  services: [],
  database: {
    path: join(CONFIG_DIR, DB_FILE),
  },
  redact: {
    enabled: true,
    patterns: [
      "password",
      "secret",
      "token",
      "key",
      "auth",
      "credential",
      "api_key",
      "apikey",
    ],
  },
};

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return join(CONFIG_DIR, CONFIG_FILE);
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): PulseConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...parsed.server },
      monitor: { ...DEFAULT_CONFIG.monitor, ...parsed.monitor },
      database: { ...DEFAULT_CONFIG.database, ...parsed.database },
      redact: { ...DEFAULT_CONFIG.redact, ...parsed.redact },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: PulseConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function getServerUrl(config?: PulseConfig): string {
  const c = config ?? loadConfig();
  return `http://${c.server.host}:${c.server.port}`;
}

export function resolveDbPath(config?: PulseConfig): string {
  const c = config ?? loadConfig();
  const dbPath = c.database.path;
  if (dbPath.startsWith("/")) return dbPath;
  return resolve(CONFIG_DIR, dbPath);
}
