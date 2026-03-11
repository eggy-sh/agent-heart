import { Command } from "commander";
import chalk from "chalk";
import { PulseClient } from "../../core/client.js";
import { log, chrome, formatDuration } from "../../utils/logger.js";
import type { OverviewResponse, ServiceState } from "../../core/models.js";

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  return formatDuration(diff) + " ago";
}

function statusIndicator(svc: ServiceState): string {
  switch (svc.severity) {
    case "ok":
      return chalk.green("\u25CF");
    case "warning":
      return chalk.yellow("\u25B2");
    case "critical":
      return chalk.red("\u25CF");
    default:
      return chalk.dim("\u25CB");
  }
}

function statusLabel(svc: ServiceState): string {
  switch (svc.severity) {
    case "ok": {
      if (svc.active_runs > 0) return chalk.green("active");
      return chalk.green("ok");
    }
    case "warning":
      return chalk.yellow("stale");
    case "critical":
      return chalk.red("dead");
    default:
      return chalk.dim(svc.status);
  }
}

function pluralize(count: number, word: string): string {
  return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

export function makeOverviewCommand(): Command {
  const overview = new Command("overview")
    .description("Show a quick summary of the agent-heart system")
    .action(async () => {
      const parentOpts = overview.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      const client = new PulseClient({
        serverUrl: parentOpts.server,
      });

      try {
        const data: OverviewResponse = await client.overview();

        if (jsonOutput) {
          log.json(data);
          return;
        }

        const { runs, services } = data;

        // Header → stderr so piping works cleanly
        chrome.blank();
        chrome.log(chalk.bold.cyan("  agent-heart overview"));
        chrome.log(chalk.dim("  " + "\u2501".repeat(22)));
        chrome.blank();

        // Summary counters → stdout (this is data)
        const active = chalk.bold.green(String(runs.active).padStart(2));
        const stale = chalk.bold.yellow(String(runs.stale).padStart(2));
        const dead = chalk.bold.red(String(runs.dead).padStart(2));
        const completed = chalk.dim(String(runs.completed).padStart(2));
        const failed = chalk.dim(String(runs.failed).padStart(2));

        console.log(
          `  ${chalk.dim("Active")}  ${active}    ${chalk.dim("Stale")}  ${stale}    ${chalk.dim("Dead")}  ${dead}`,
        );
        console.log(
          `  ${chalk.dim("Completed")} ${completed}  ${chalk.dim("Failed")} ${failed}`,
        );
        chrome.blank();

        // Services list → stdout (this is data)
        if (services.length > 0) {
          chrome.log(chalk.dim("  Services:"));

          // Find the longest service name for alignment
          const maxNameLen = Math.max(
            ...services.map((s) => s.service_name.length),
            7,
          );

          for (const svc of services) {
            const name = svc.service_name.padEnd(maxNameLen);
            const indicator = statusIndicator(svc);
            const label = statusLabel(svc);
            const totalRuns = svc.active_runs + svc.stale_runs + svc.dead_runs;
            const runCount = chalk.dim(pluralize(totalRuns, "run").padEnd(8));
            const lastBeat = svc.last_heartbeat
              ? chalk.dim("last: " + timeSince(svc.last_heartbeat))
              : chalk.dim("last: never");

            console.log(
              `    ${chalk.white(name)}  ${indicator} ${label.padEnd(20)}  ${runCount}  ${lastBeat}`,
            );
          }
        } else {
          log.dim("  No services registered.");
        }

        chrome.blank();
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to fetch overview: ${error instanceof Error ? error.message : String(error)}`,
          );
          log.dim("Is the server running? Start it with: npx agent-heart server start");
        }
        process.exit(1);
      }
    });

  return overview;
}
