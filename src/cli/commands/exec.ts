import { Command } from "commander";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { PulseClient } from "../../core/client.js";
import { redactCommand } from "../../utils/redact.js";
import { log, chrome, formatDuration } from "../../utils/logger.js";

export function makeExecCommand(): Command {
  const exec = new Command("exec")
    .description(
      "Wrap any CLI command with automatic observability (the killer feature)",
    )
    .option("--service <name>", "Service name (required)")
    .option("-t, --tool <name>", "Tool name being invoked")
    .option("-r, --resource <kind>", "Resource kind being acted on")
    .option("-s, --session <id>", "Session ID")
    .option(
      "--heartbeat-interval <ms>",
      "Heartbeat interval in milliseconds",
      parseInt,
    )
    .option("--metadata <json>", "Additional metadata as JSON string")
    .option(
      "-q, --quiet",
      "Suppress pulse output, only show child process output",
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption("-h, --help", "Display help for exec command")
    .usage("--service <name> [options] -- <command...>")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts();
      const parentOpts = exec.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      // Service name is required
      if (!opts.service) {
        log.error("--service <name> is required");
        log.dim(
          "Usage: npx agent-heart exec --service <name> [options] -- <command...>",
        );
        process.exit(1);
      }

      // Parse the child command from args after "--"
      const rawArgs = process.argv;
      const doubleDashIndex = rawArgs.indexOf("--");
      if (doubleDashIndex === -1 || doubleDashIndex === rawArgs.length - 1) {
        log.error(
          "No command specified. Use -- to separate the command to execute.",
        );
        log.dim(
          "Example: npx agent-heart exec --service github -- gh pr list",
        );
        process.exit(1);
      }

      const childArgs = rawArgs.slice(doubleDashIndex + 1);
      const childCommand = childArgs[0];
      const childCommandArgs = childArgs.slice(1);
      const fullCommand = childArgs.join(" ");
      const redactedCommand = redactCommand(fullCommand);

      // Parse metadata
      let metadata: Record<string, string> | undefined;
      if (opts.metadata) {
        try {
          metadata = JSON.parse(opts.metadata);
        } catch {
          log.error("Invalid JSON for --metadata");
          process.exit(1);
        }
      }

      // Initialize client
      const client = new PulseClient({
        serverUrl: parentOpts.server,
        sessionId: opts.session,
      });

      const heartbeatInterval = opts.heartbeatInterval ?? 15_000;
      // Auto-quiet when stdout is piped so pulse chrome doesn't
      // pollute the child process output being captured.
      const quiet = opts.quiet === true || !process.stdout.isTTY;

      let runId: string | undefined;
      let beatTimer: ReturnType<typeof setInterval> | undefined;
      const startTime = Date.now();

      // Cleanup function for signals
      const cleanup = async (exitCode: number) => {
        if (beatTimer) {
          clearInterval(beatTimer);
          beatTimer = undefined;
        }

        if (runId) {
          const duration = Date.now() - startTime;
          try {
            await client.unlock(opts.service, {
              run_id: runId,
              exit_code: exitCode,
              message:
                exitCode === -1
                  ? "Process interrupted by signal"
                  : `Exited with code ${exitCode}`,
              metadata: {
                duration_ms: String(duration),
                command: redactedCommand,
              },
            });
          } catch {
            // Best effort — server may be unreachable
          }
        }
      };

      try {
        // Step 1: Lock (announce start)
        if (!quiet) {
          log.dim(`Executing: ${redactedCommand}`);
        }

        const lockResponse = await client.lock(opts.service, {
          tool_name: opts.tool,
          resource_kind: opts.resource,
          command: redactedCommand,
          message: `Executing: ${redactedCommand}`,
          metadata,
        });

        runId = lockResponse.run_id;

        if (!quiet) {
          log.info(
            `Run ${chalk.bold(runId.slice(0, 8))}... started`,
          );
        }

        // Step 2: Set up periodic heartbeats
        beatTimer = setInterval(() => {
          client
            .beat(opts.service, {
              run_id: runId,
              message: `Running: ${redactedCommand}`,
            })
            .catch(() => {
              // Heartbeat failures are non-fatal
            });
        }, heartbeatInterval);

        // Step 3: Handle signals for clean shutdown
        const signalHandler = async (signal: string) => {
          if (!quiet) {
            log.warn(`Received ${signal}, cleaning up...`);
          }
          await cleanup(-1);
          process.exit(128 + (signal === "SIGINT" ? 2 : 15));
        };

        process.on("SIGINT", () => signalHandler("SIGINT"));
        process.on("SIGTERM", () => signalHandler("SIGTERM"));

        // Step 4: Spawn child process
        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(childCommand, childCommandArgs, {
            stdio: ["inherit", "inherit", "inherit"],
            shell: false,
            env: process.env,
          });

          child.on("error", (err) => {
            reject(
              new Error(`Failed to start process "${childCommand}": ${err.message}`),
            );
          });

          child.on("close", (code) => {
            resolve(code ?? 1);
          });
        });

        // Step 5: Clean up heartbeats
        if (beatTimer) {
          clearInterval(beatTimer);
          beatTimer = undefined;
        }

        // Step 6: Unlock (announce completion)
        const duration = Date.now() - startTime;

        await client.unlock(opts.service, {
          run_id: runId,
          exit_code: exitCode,
          message:
            exitCode === 0
              ? `Completed successfully in ${formatDuration(duration)}`
              : `Failed with exit code ${exitCode} after ${formatDuration(duration)}`,
          metadata: {
            duration_ms: String(duration),
            command: redactedCommand,
          },
        });

        // Step 7: Show summary
        if (jsonOutput) {
          log.json({
            ok: exitCode === 0,
            run_id: runId,
            service: opts.service,
            command: redactedCommand,
            exit_code: exitCode,
            duration_ms: duration,
            duration_human: formatDuration(duration),
          });
        } else if (!quiet) {
          chrome.blank();
          chrome.log(
            chalk.dim("  ─────────────────────────────────"),
          );
          chrome.log(
            `  ${chalk.dim("run_id")}     ${chalk.white(runId)}`,
          );
          chrome.log(
            `  ${chalk.dim("service")}    ${chalk.white(opts.service)}`,
          );
          chrome.log(
            `  ${chalk.dim("exit code")}  ${exitCode === 0 ? chalk.green(exitCode) : chalk.red(exitCode)}`,
          );
          chrome.log(
            `  ${chalk.dim("duration")}   ${chalk.white(formatDuration(duration))}`,
          );
          chrome.blank();
        }

        // Exit with the child's exit code
        process.exit(exitCode);
      } catch (error) {
        // Handle lock/unlock failures gracefully
        if (beatTimer) {
          clearInterval(beatTimer);
        }

        const duration = Date.now() - startTime;

        // Try to unlock if we got a run_id
        if (runId) {
          try {
            await client.unlock(opts.service, {
              run_id: runId,
              exit_code: 1,
              message:
                error instanceof Error ? error.message : String(error),
              metadata: {
                duration_ms: String(duration),
                command: redactedCommand,
              },
            });
          } catch {
            // Best effort
          }
        }

        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            run_id: runId,
            duration_ms: duration,
          });
        } else {
          log.error(
            error instanceof Error ? error.message : String(error),
          );
        }

        process.exit(1);
      }
    });

  return exec;
}
