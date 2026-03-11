import { Command } from "commander";
import chalk from "chalk";
import { log, chrome } from "../../utils/logger.js";

export function makeServerCommand(): Command {
  const server = new Command("server").description(
    "Manage the agent-heart server",
  );

  server
    .command("start")
    .description("Start the pulse server")
    .option("-p, --port <port>", "Port to listen on", parseInt)
    .option("-H, --host <host>", "Host to bind to")
    .option("--db <path>", "Path to SQLite database file")
    .action(async (opts) => {
      const ora = (await import("ora")).default;
      const { loadConfig } = await import("../../core/config.js");

      const config = loadConfig();
      const port = opts.port ?? config.server.port;
      const host = opts.host ?? config.server.host;

      if (opts.db) {
        config.database.path = opts.db;
      }

      const spinner = ora({ text: "Starting agent-heart server...", stream: process.stderr }).start();

      try {
        const { startServer } = await import("../../server/index.js");

        // Build config overrides matching Partial<PulseConfig>
        const overrides: Record<string, unknown> = {
          server: { host, port },
        };
        if (opts.db) {
          overrides.database = { path: opts.db };
        }

        spinner.succeed("Server started");

        chrome.blank();
        chrome.log(
          chalk.bold.cyan("  agent-heart server"),
        );
        chrome.log(
          chalk.dim("  ─────────────────────────────────"),
        );
        chrome.log(
          `  ${chalk.dim("Listening on")}  ${chalk.green(`http://${host}:${port}`)}`,
        );
        chrome.log(
          `  ${chalk.dim("Database")}      ${chalk.white(config.database.path)}`,
        );
        chrome.log(
          `  ${chalk.dim("API docs")}      ${chalk.white(`http://${host}:${port}/api/v1/overview`)}`,
        );
        chrome.blank();
        chrome.log(
          chalk.dim("  Press Ctrl+C to stop the server"),
        );
        chrome.blank();

        await startServer(overrides);
      } catch (error) {
        spinner.fail("Failed to start server");
        log.error(
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      }
    });

  server
    .command("stop")
    .description("Stop the pulse server")
    .action(() => {
      log.info(
        "To stop the server, press Ctrl+C in the terminal where it is running.",
      );
      log.dim(
        "Programmatic stop is not yet implemented. Use signals to stop the process.",
      );
    });

  return server;
}
