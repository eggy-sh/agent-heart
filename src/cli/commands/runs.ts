import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { PulseClient } from "../../core/client.js";
import {
  log,
  formatStatus,
  formatDuration,
  formatSeverity,
} from "../../utils/logger.js";
import type { Run } from "../../core/models.js";

function truncateId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) : id;
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  return formatDuration(diff) + " ago";
}

function formatExitCode(code: number | null): string {
  if (code === null) return chalk.dim("-");
  return code === 0 ? chalk.green(String(code)) : chalk.red(String(code));
}

function formatRunDuration(run: Run): string {
  if (run.duration_ms !== null) {
    return formatDuration(run.duration_ms);
  }
  // For active/stale runs, show elapsed time
  if (run.status === "active" || run.status === "locked" || run.status === "stale") {
    const elapsed = Date.now() - new Date(run.started_at).getTime();
    return formatDuration(elapsed);
  }
  return chalk.dim("-");
}

function printRunDetails(run: Run): void {
  console.log("");
  console.log(chalk.bold.cyan("  Run Details"));
  console.log(chalk.dim("  " + "\u2501".repeat(40)));
  console.log("");

  const label = (s: string) => chalk.dim(s.padEnd(18));

  console.log(`  ${label("run_id")}${chalk.white(run.run_id)}`);
  console.log(`  ${label("service")}${chalk.white(run.service_name)}`);
  console.log(`  ${label("status")}${formatStatus(run.status)}`);
  console.log(`  ${label("severity")}${formatSeverity(run.severity)}`);

  if (run.session_id) {
    console.log(`  ${label("session_id")}${chalk.white(run.session_id)}`);
  }
  if (run.tool_name) {
    console.log(`  ${label("tool")}${chalk.cyan(run.tool_name)}`);
  }
  if (run.command) {
    console.log(`  ${label("command")}${chalk.white(run.command)}`);
  }
  if (run.command_family) {
    console.log(`  ${label("command_family")}${chalk.white(run.command_family)}`);
  }
  if (run.resource_kind) {
    console.log(`  ${label("resource_kind")}${chalk.white(run.resource_kind)}`);
  }
  if (run.resource_id) {
    console.log(`  ${label("resource_id")}${chalk.white(run.resource_id)}`);
  }

  console.log("");
  console.log(`  ${label("exit_code")}${formatExitCode(run.exit_code)}`);
  console.log(`  ${label("duration")}${formatRunDuration(run)}`);

  console.log("");
  console.log(`  ${label("started_at")}${chalk.white(run.started_at)}`);
  console.log(`  ${label("last_heartbeat")}${chalk.white(run.last_heartbeat)} ${chalk.dim("(" + timeSince(run.last_heartbeat) + ")")}`);
  if (run.completed_at) {
    console.log(`  ${label("completed_at")}${chalk.white(run.completed_at)}`);
  }

  if (run.message) {
    console.log("");
    console.log(`  ${label("message")}${chalk.white(run.message)}`);
  }

  if (run.metadata && Object.keys(run.metadata).length > 0) {
    console.log("");
    console.log(`  ${chalk.dim("metadata:")}`);
    for (const [key, value] of Object.entries(run.metadata)) {
      console.log(`    ${chalk.dim(key + ":")} ${chalk.white(value)}`);
    }
  }

  console.log("");
}

export function makeRunsCommand(): Command {
  const runs = new Command("runs")
    .description("List and inspect runs")
    .option("--service <name>", "Filter by service name")
    .option("--status <statuses>", "Filter by status (comma-separated: active,stale,dead,completed,failed,locked)")
    .option("--session <id>", "Filter by session ID")
    .option("--limit <n>", "Maximum number of runs to show", parseInt)
    .action(async (opts) => {
      const parentOpts = runs.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;
      const limit = opts.limit ?? 20;

      const client = new PulseClient({
        serverUrl: parentOpts.server,
      });

      try {
        const response = await client.listRuns({
          service: opts.service,
          status: opts.status,
          session_id: opts.session,
          limit,
        });

        if (jsonOutput) {
          log.json(response);
          return;
        }

        if (response.runs.length === 0) {
          log.dim("No runs found.");
          return;
        }

        console.log("");
        console.log(
          chalk.bold.cyan("  Runs") +
            chalk.dim(` (${response.runs.length} of ${response.total})`),
        );
        console.log("");

        const table = new Table({
          head: [
            chalk.dim("Run ID"),
            chalk.dim("Service"),
            chalk.dim("Tool"),
            chalk.dim("Status"),
            chalk.dim("Exit"),
            chalk.dim("Duration"),
            chalk.dim("Last Heartbeat"),
          ],
          style: {
            head: [],
            border: ["dim"],
          },
        });

        for (const run of response.runs) {
          table.push([
            chalk.white(truncateId(run.run_id)),
            chalk.white(run.service_name),
            run.tool_name ? chalk.cyan(run.tool_name) : chalk.dim("-"),
            formatStatus(run.status),
            formatExitCode(run.exit_code),
            formatRunDuration(run),
            timeSince(run.last_heartbeat),
          ]);
        }

        console.log(table.toString());
        console.log("");
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to fetch runs: ${error instanceof Error ? error.message : String(error)}`,
          );
          log.dim("Is the server running? Start it with: agent-pulse server start");
        }
        process.exit(1);
      }
    });

  // Subcommand: runs show <id>
  runs
    .command("show")
    .description("Show full details of a specific run")
    .argument("<run-id>", "The run ID to inspect")
    .action(async (runId: string) => {
      const parentOpts = runs.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      const client = new PulseClient({
        serverUrl: parentOpts.server,
      });

      try {
        const run = await client.getRun(runId);

        if (jsonOutput) {
          log.json(run);
          return;
        }

        printRunDetails(run);
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to fetch run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exit(1);
      }
    });

  return runs;
}
