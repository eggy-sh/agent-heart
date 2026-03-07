import { Command } from "commander";
import { existsSync } from "node:fs";
import chalk from "chalk";
import {
  getConfigPath,
  getConfigDir,
  saveConfig,
  DEFAULT_CONFIG,
} from "../../core/config.js";
import { log } from "../../utils/logger.js";

export function makeInitCommand(): Command {
  const init = new Command("init")
    .description("Initialize agent-pulse configuration")
    .option("-f, --force", "Overwrite existing configuration")
    .action(async (opts) => {
      const parentOpts = init.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      const configPath = getConfigPath();
      const configDir = getConfigDir();

      if (existsSync(configPath) && !opts.force) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: "Configuration already exists",
            path: configPath,
          });
        } else {
          log.warn(
            `Configuration already exists at ${chalk.white(configPath)}`,
          );
          log.dim("Use --force to overwrite.");
        }
        process.exit(1);
      }

      try {
        saveConfig(DEFAULT_CONFIG);

        if (jsonOutput) {
          log.json({
            ok: true,
            config_dir: configDir,
            config_path: configPath,
            config: DEFAULT_CONFIG,
          });
        } else {
          log.success("Configuration initialized");
          console.log("");
          console.log(
            `  ${chalk.dim("Config dir")}   ${chalk.white(configDir)}`,
          );
          console.log(
            `  ${chalk.dim("Config file")}  ${chalk.white(configPath)}`,
          );
          console.log(
            `  ${chalk.dim("Database")}     ${chalk.white(DEFAULT_CONFIG.database.path)}`,
          );
          console.log("");
          console.log(
            `  ${chalk.dim("Server")}       ${chalk.white(`${DEFAULT_CONFIG.server.host}:${DEFAULT_CONFIG.server.port}`)}`,
          );
          console.log(
            `  ${chalk.dim("Redaction")}    ${DEFAULT_CONFIG.redact.enabled ? chalk.green("enabled") : chalk.yellow("disabled")}`,
          );
          console.log("");
          console.log(
            chalk.dim("  Edit the config file to customize settings."),
          );
          console.log(
            chalk.dim("  Start the server with: agent-pulse server start"),
          );
          console.log("");
        }
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exit(1);
      }
    });

  return init;
}
