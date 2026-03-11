import { serve } from "@hono/node-server";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../core/config.js";
import type { PulseConfig } from "../core/models.js";
import { createDatabase } from "./db.js";
import { createApp } from "./routes.js";
import { startMonitor } from "./monitor.js";
import { log } from "../utils/logger.js";

export { createDatabase } from "./db.js";
export type { PulseDB } from "./db.js";
export { createApp } from "./routes.js";
export { startMonitor } from "./monitor.js";

export async function startServer(
  configOverrides?: Partial<PulseConfig>,
): Promise<void> {
  const baseConfig = loadConfig();
  const config: PulseConfig = {
    ...baseConfig,
    ...configOverrides,
    server: { ...baseConfig.server, ...configOverrides?.server },
    monitor: { ...baseConfig.monitor, ...configOverrides?.monitor },
    database: { ...baseConfig.database, ...configOverrides?.database },
    redact: { ...baseConfig.redact, ...configOverrides?.redact },
  };

  // Ensure database directory exists
  const dbDir = dirname(config.database.path);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database
  const db = await createDatabase(config.database.path);
  log.info(`Database initialized at ${config.database.path}`);

  // Seed configured services
  for (const svc of config.services) {
    db.upsertService(svc);
  }

  // Create the Hono app
  const app = createApp(db);

  // Start the monitor
  const stopMonitor = startMonitor(db, config);

  // Graceful shutdown handler
  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("Shutting down...");
    stopMonitor();
    db.close();
    log.info("Server stopped");
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the HTTP server
  const { host, port } = config.server;

  serve(
    {
      fetch: app.fetch,
      hostname: host,
      port,
    },
    (info) => {
      log.info(`Server listening on http://${host}:${info.port}`);
    },
  );
}
