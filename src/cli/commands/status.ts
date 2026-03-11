import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { PulseClient } from "../../core/client.js";
import {
  log,
  chrome,
  formatStatus,
  formatSeverity,
  formatDuration,
  formatTimestamp,
} from "../../utils/logger.js";
import type { OverviewResponse, Run } from "../../core/models.js";

function truncateId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) + "..." : id;
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  return formatDuration(diff) + " ago";
}

export function makeStatusCommand(): Command {
  const status = new Command("status")
    .description("Show current state of all runs and services")
    .option("--service <name>", "Filter by service name")
    .action(async (opts) => {
      const parentOpts = status.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      const client = new PulseClient({
        serverUrl: parentOpts.server,
      });

      try {
        const overview: OverviewResponse = await client.overview();

        // If --json, just dump the overview
        if (jsonOutput) {
          // If filtering by service, narrow down
          if (opts.service) {
            const filtered = {
              ...overview,
              services: overview.services.filter(
                (s) => s.service_name === opts.service,
              ),
            };
            log.json(filtered);
          } else {
            log.json(overview);
          }
          return;
        }

        // ---- Pretty output ----
        // Headers/chrome go to stderr so piping the table works cleanly.

        chrome.blank();
        chrome.log(
          chalk.bold.cyan("  agent-heart status"),
        );
        chrome.log(
          chalk.dim(`  ${overview.timestamp}`),
        );
        chrome.blank();

        // Summary line
        const { runs } = overview;
        chrome.log(
          `  ${chalk.green(runs.active)} active  ${chalk.yellow(runs.stale)} stale  ${chalk.red(runs.dead)} dead  ${chalk.dim(runs.completed + " completed")}  ${chalk.dim(runs.failed + " failed")}`,
        );
        chrome.blank();

        // Services table
        let services = overview.services;
        if (opts.service) {
          services = services.filter(
            (s) => s.service_name === opts.service,
          );
        }

        if (services.length > 0) {
          const servicesTable = new Table({
            head: [
              chalk.dim("Service"),
              chalk.dim("Status"),
              chalk.dim("Severity"),
              chalk.dim("Active"),
              chalk.dim("Stale"),
              chalk.dim("Dead"),
              chalk.dim("Last Heartbeat"),
            ],
            style: {
              head: [],
              border: ["dim"],
            },
          });

          for (const svc of services) {
            servicesTable.push([
              chalk.white(svc.service_name),
              formatStatus(svc.status),
              formatSeverity(svc.severity),
              svc.active_runs > 0
                ? chalk.green(svc.active_runs)
                : chalk.dim("0"),
              svc.stale_runs > 0
                ? chalk.yellow(svc.stale_runs)
                : chalk.dim("0"),
              svc.dead_runs > 0
                ? chalk.red(svc.dead_runs)
                : chalk.dim("0"),
              svc.last_heartbeat
                ? timeSince(svc.last_heartbeat)
                : chalk.dim("never"),
            ]);
          }

          console.log(servicesTable.toString());
          chrome.blank();
        } else {
          log.dim("  No services registered.");
          chrome.blank();
        }

        // Active runs — we need to fetch runs separately
        try {
          const runList = await client.listRuns({
            service: opts.service,
            status: "active",
            limit: 50,
          });

          // Also fetch stale and locked
          const staleRuns = await client.listRuns({
            service: opts.service,
            status: "stale",
            limit: 50,
          });

          const lockedRuns = await client.listRuns({
            service: opts.service,
            status: "locked",
            limit: 50,
          });

          const allRuns: Run[] = [
            ...lockedRuns.runs,
            ...runList.runs,
            ...staleRuns.runs,
          ];

          if (allRuns.length > 0) {
            chrome.log(chalk.bold("  Active Runs"));
            chrome.blank();

            const runsTable = new Table({
              head: [
                chalk.dim("Run ID"),
                chalk.dim("Service"),
                chalk.dim("Tool"),
                chalk.dim("Status"),
                chalk.dim("Duration"),
                chalk.dim("Last Beat"),
              ],
              style: {
                head: [],
                border: ["dim"],
              },
            });

            for (const run of allRuns) {
              const duration = run.duration_ms
                ? formatDuration(run.duration_ms)
                : formatDuration(
                    Date.now() - new Date(run.started_at).getTime(),
                  );

              runsTable.push([
                chalk.white(truncateId(run.run_id)),
                chalk.white(run.service_name),
                run.tool_name ? chalk.cyan(run.tool_name) : chalk.dim("-"),
                formatStatus(run.status),
                duration,
                timeSince(run.last_heartbeat),
              ]);
            }

            console.log(runsTable.toString());
            chrome.blank();
          } else {
            log.dim("  No active runs.");
            chrome.blank();
          }
        } catch {
          // If run listing fails (e.g., endpoint not available), just skip
          log.dim("  Could not fetch active runs.");
          chrome.blank();
        }
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to fetch status: ${error instanceof Error ? error.message : String(error)}`,
          );
          log.dim("Is the server running? Start it with: npx agent-heart server start");
        }
        process.exit(1);
      }
    });

  return status;
}
