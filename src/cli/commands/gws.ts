import { Command } from "commander";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { PulseClient } from "../../core/client.js";
import { redactCommand } from "../../utils/redact.js";
import { log, chrome, formatDuration } from "../../utils/logger.js";
import { parseGwsCommand, parseGwsOutput } from "../../adapters/gws.js";
import type { GwsCommandInfo, GwsResultInfo } from "../../adapters/gws.js";

/**
 * Dedicated GWS (Google Workspace CLI) wrapper command.
 *
 * Usage:
 *   npx agent-heart gws drive files list --params '{"pageSize": 10}'
 *
 * This is equivalent to:
 *   npx agent-heart exec --service gws-drive --tool gws --resource files -- gws drive files list --params '{"pageSize": 10}'
 *
 * But with automatic metadata extraction and GWS-aware output parsing.
 */
export function makeGwsCommand(): Command {
  const gws = new Command("gws")
    .description(
      "Wrap a gws (Google Workspace CLI) command with automatic observability",
    )
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
    .helpOption(false) // we handle our own help so flags pass through to gws
    .usage("<service> <resource> <method> [gws flags]")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts();
      const parentOpts = gws.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;
      const quiet = opts.quiet === true || !process.stdout.isTTY;

      // Collect all args after "gws" subcommand from process.argv.
      // Commander will have consumed "agent-heart" and "gws" but the
      // remaining tokens (including gws flags) are left in process.argv.
      const gwsArgs = extractGwsArgs(process.argv);

      // Handle help explicitly since we disabled Commander's helpOption
      if (gwsArgs.length === 0 || gwsArgs[0] === "--help" || gwsArgs[0] === "-h") {
        console.log(`Usage: npx agent-heart gws <service> <resource> <method> [gws flags]

Wrap a gws (Google Workspace CLI) command with automatic observability.
Auto-extracts service, resource, and method metadata from the gws command structure.

Examples:
  npx agent-heart gws drive files list --params '{"pageSize": 10}'
  npx agent-heart gws sheets spreadsheets create --body '{"properties":{"title":"Report"}}'
  npx agent-heart gws gmail users messages list --params '{"userId":"me"}'
  npx agent-heart gws calendar events list --params '{"calendarId":"primary"}'

Options:
  -s, --session <id>              Session ID
  --heartbeat-interval <ms>       Heartbeat interval in milliseconds
  --metadata <json>               Additional metadata as JSON string
  -q, --quiet                     Suppress pulse output
`);
        process.exit(0);
      }

      if (gwsArgs.length === 0) {
        log.error("No gws command specified.");
        log.dim("Usage: npx agent-heart gws <service> <resource> <method> [gws flags]");
        log.dim("Example: npx agent-heart gws drive files list --params '{\"pageSize\": 10}'");
        process.exit(1);
      }

      // Parse the gws command structure for metadata
      const cmdInfo = parseGwsCommand(gwsArgs);

      if (!cmdInfo) {
        log.error("Could not parse gws command. Expected: gws <service> <resource> <method>");
        log.dim(`Received args: ${gwsArgs.join(" ")}`);
        process.exit(1);
      }

      const serviceName = `gws-${cmdInfo.service}`;
      const redactedCommand = redactCommand(cmdInfo.fullCommand);

      // Parse optional metadata
      let extraMetadata: Record<string, string> | undefined;
      if (opts.metadata) {
        try {
          extraMetadata = JSON.parse(opts.metadata);
        } catch {
          log.error("Invalid JSON for --metadata");
          process.exit(1);
        }
      }

      // Build metadata combining GWS-specific info and user-provided metadata
      const metadata: Record<string, string> = {
        gws_service: cmdInfo.service,
        gws_resource: cmdInfo.resource,
        gws_method: cmdInfo.method,
        gws_operation_type: cmdInfo.operationType,
        ...(cmdInfo.isPaginated ? { gws_paginated: "true" } : {}),
        ...(cmdInfo.isDryRun ? { gws_dry_run: "true" } : {}),
        ...extraMetadata,
      };

      // Heartbeat interval: longer for paginated ops (they can take a while)
      const defaultInterval = cmdInfo.isPaginated ? 30_000 : 15_000;
      const heartbeatInterval = opts.heartbeatInterval ?? defaultInterval;

      // Check if gws is installed
      const gwsBin = "gws";

      // Initialize client
      const client = new PulseClient({
        serverUrl: parentOpts.server,
        sessionId: opts.session,
      });

      let runId: string | undefined;
      let beatTimer: ReturnType<typeof setInterval> | undefined;
      const startTime = Date.now();

      // Buffers for capturing output (we need stdout for parsing)
      let stdoutBuf = "";
      let stderrBuf = "";

      const cleanup = async (exitCode: number) => {
        if (beatTimer) {
          clearInterval(beatTimer);
          beatTimer = undefined;
        }

        if (runId) {
          const duration = Date.now() - startTime;
          try {
            await client.unlock(serviceName, {
              run_id: runId,
              exit_code: exitCode,
              message:
                exitCode === -1
                  ? "Process interrupted by signal"
                  : `Exited with code ${exitCode}`,
              metadata: {
                ...metadata,
                duration_ms: String(duration),
                command: redactedCommand,
              },
            });
          } catch {
            // Best effort
          }
        }
      };

      try {
        // Step 1: Lock
        if (!quiet) {
          log.dim(`GWS ${cmdInfo.service}/${cmdInfo.resource} ${cmdInfo.method}`);
          log.dim(`Executing: ${redactedCommand}`);
        }

        const lockResponse = await client.lock(serviceName, {
          tool_name: "gws",
          resource_kind: cmdInfo.resource,
          command: redactedCommand,
          command_family: cmdInfo.service,
          message: `Executing: ${redactedCommand}`,
          metadata,
        });

        runId = lockResponse.run_id;

        if (!quiet) {
          log.info(`Run ${chalk.bold(runId.slice(0, 8))}... started`);
        }

        // Step 2: Heartbeats
        beatTimer = setInterval(() => {
          client
            .beat(serviceName, {
              run_id: runId,
              message: `Running: ${redactedCommand}`,
            })
            .catch(() => {
              // Heartbeat failures are non-fatal
            });
        }, heartbeatInterval);

        // Step 3: Signal handling
        const signalHandler = async (signal: string) => {
          if (!quiet) {
            log.warn(`Received ${signal}, cleaning up...`);
          }
          await cleanup(-1);
          process.exit(128 + (signal === "SIGINT" ? 2 : 15));
        };

        process.on("SIGINT", () => signalHandler("SIGINT"));
        process.on("SIGTERM", () => signalHandler("SIGTERM"));

        // Step 4: Spawn gws
        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(gwsBin, gwsArgs, {
            stdio: ["inherit", "pipe", "pipe"],
            shell: false,
            env: process.env,
          });

          child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdoutBuf += text;
            process.stdout.write(text);
          });

          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderrBuf += text;
            process.stderr.write(text);
          });

          child.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              reject(
                new Error(
                  `gws CLI not found. Please install it first.\n` +
                    `  See: https://github.com/niceguydave/gws`,
                ),
              );
            } else {
              reject(
                new Error(`Failed to start gws: ${err.message}`),
              );
            }
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

        // Step 6: Parse gws output for error classification
        const resultInfo = parseGwsOutput(stdoutBuf || stderrBuf, exitCode);

        // Build final metadata with result info
        const unlockMetadata: Record<string, string> = {
          ...metadata,
          duration_ms: String(Date.now() - startTime),
          command: redactedCommand,
        };

        if (resultInfo.errorType) {
          unlockMetadata.gws_error_type = resultInfo.errorType;
        }
        if (resultInfo.httpStatus !== null) {
          unlockMetadata.gws_http_status = String(resultInfo.httpStatus);
        }
        if (resultInfo.itemCount !== null) {
          unlockMetadata.gws_item_count = String(resultInfo.itemCount);
        }
        if (resultInfo.hasNextPage) {
          unlockMetadata.gws_has_next_page = "true";
        }

        // Step 7: Unlock
        const duration = Date.now() - startTime;

        const unlockMessage = buildUnlockMessage(cmdInfo, resultInfo, exitCode, duration);

        await client.unlock(serviceName, {
          run_id: runId,
          exit_code: exitCode,
          message: unlockMessage,
          metadata: unlockMetadata,
        });

        // Step 8: Show summary
        if (jsonOutput) {
          log.json({
            ok: exitCode === 0,
            run_id: runId,
            service: serviceName,
            gws: {
              service: cmdInfo.service,
              resource: cmdInfo.resource,
              method: cmdInfo.method,
              operation_type: cmdInfo.operationType,
              paginated: cmdInfo.isPaginated,
              dry_run: cmdInfo.isDryRun,
            },
            result: {
              error_type: resultInfo.errorType,
              http_status: resultInfo.httpStatus,
              item_count: resultInfo.itemCount,
              has_next_page: resultInfo.hasNextPage,
            },
            command: redactedCommand,
            exit_code: exitCode,
            duration_ms: duration,
            duration_human: formatDuration(duration),
          });
        } else if (!quiet) {
          chrome.blank();
          chrome.log(chalk.dim("  ─────────────────────────────────"));
          chrome.log(`  ${chalk.dim("run_id")}     ${chalk.white(runId)}`);
          chrome.log(`  ${chalk.dim("service")}    ${chalk.white(serviceName)}`);
          chrome.log(
            `  ${chalk.dim("gws")}        ${chalk.white(cmdInfo.service)}/${chalk.white(cmdInfo.resource)} ${chalk.cyan(cmdInfo.method)}`,
          );
          chrome.log(
            `  ${chalk.dim("operation")}  ${formatOperationType(cmdInfo.operationType)}`,
          );
          if (resultInfo.itemCount !== null) {
            chrome.log(
              `  ${chalk.dim("items")}      ${chalk.white(String(resultInfo.itemCount))}${resultInfo.hasNextPage ? chalk.dim(" (more pages)") : ""}`,
            );
          }
          if (resultInfo.errorType) {
            chrome.log(
              `  ${chalk.dim("error")}      ${chalk.red(resultInfo.errorType)}${resultInfo.httpStatus ? chalk.dim(` (${resultInfo.httpStatus})`) : ""}`,
            );
          }
          chrome.log(
            `  ${chalk.dim("exit code")}  ${exitCode === 0 ? chalk.green(exitCode) : chalk.red(exitCode)}`,
          );
          chrome.log(
            `  ${chalk.dim("duration")}   ${chalk.white(formatDuration(duration))}`,
          );
          chrome.blank();
        }

        process.exit(exitCode);
      } catch (error) {
        if (beatTimer) {
          clearInterval(beatTimer);
        }

        const duration = Date.now() - startTime;

        if (runId) {
          try {
            await client.unlock(serviceName, {
              run_id: runId,
              exit_code: 1,
              message: error instanceof Error ? error.message : String(error),
              metadata: {
                ...metadata,
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
          log.error(error instanceof Error ? error.message : String(error));
        }

        process.exit(1);
      }
    });

  return gws;
}

// --- Helpers ---

/**
 * Extract gws arguments from the full process.argv.
 *
 * process.argv looks like:
 *   ["node", "agent-heart", "gws", "drive", "files", "list", "--params", "..."]
 *
 * We need everything after the "gws" subcommand, but we must skip any
 * agent-heart-level flags that appear before or mixed in.
 * Commander processes its own flags (--quiet, --session, --json, --server, etc.)
 * but the gws positionals and gws-specific flags need to pass through.
 */
function extractGwsArgs(argv: string[]): string[] {
  // Find the position of "gws" in argv
  const gwsIndex = argv.indexOf("gws");
  if (gwsIndex === -1) return [];

  const afterGws = argv.slice(gwsIndex + 1);

  // Filter out agent-heart flags that Commander may not have consumed
  // since we use allowUnknownOption. The gws command's own flags
  // (--session, --quiet, --heartbeat-interval, --metadata) are consumed
  // by Commander. Everything else passes through to gws.
  const pulseFlags = new Set([
    "--quiet",
    "-q",
    "--json",
    "--server",
    "--session",
    "-s",
    "--heartbeat-interval",
    "--metadata",
  ]);

  const pulseFlagsWithValue = new Set([
    "--server",
    "--session",
    "-s",
    "--heartbeat-interval",
    "--metadata",
  ]);

  const result: string[] = [];
  let i = 0;

  while (i < afterGws.length) {
    const token = afterGws[i];

    if (pulseFlags.has(token)) {
      // Skip the flag
      if (pulseFlagsWithValue.has(token) && i + 1 < afterGws.length) {
        // Also skip its value
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    result.push(token);
    i += 1;
  }

  return result;
}

function buildUnlockMessage(
  cmdInfo: GwsCommandInfo,
  resultInfo: GwsResultInfo,
  exitCode: number,
  duration: number,
): string {
  const base = `gws ${cmdInfo.service} ${cmdInfo.resource} ${cmdInfo.method}`;

  if (exitCode === 0) {
    const parts = [`${base} completed in ${formatDuration(duration)}`];
    if (resultInfo.itemCount !== null) {
      parts.push(`${resultInfo.itemCount} item(s) returned`);
    }
    if (resultInfo.hasNextPage) {
      parts.push("more pages available");
    }
    return parts.join(" - ");
  }

  const parts = [`${base} failed (exit ${exitCode}) after ${formatDuration(duration)}`];
  if (resultInfo.errorType) {
    parts.push(`error: ${resultInfo.errorType}`);
  }
  if (resultInfo.httpStatus !== null) {
    parts.push(`HTTP ${resultInfo.httpStatus}`);
  }
  return parts.join(" - ");
}

function formatOperationType(type: GwsCommandInfo["operationType"]): string {
  switch (type) {
    case "read":
      return chalk.green(type);
    case "write":
      return chalk.yellow(type);
    case "delete":
      return chalk.red(type);
    case "admin":
      return chalk.magenta(type);
  }
}
