import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { PulseClient } from "../../core/client.js";
import { evaluateWatch } from "../../core/watch.js";
import { RunStatus } from "../../core/models.js";
import type { Run } from "../../core/models.js";
import { log, chrome, formatStatus, formatDuration } from "../../utils/logger.js";

function intArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return n;
}

const VALID_STATUSES = Object.values(RunStatus) as string[];

function parseUntil(raw: string): RunStatus[] {
  const states = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of states) {
    if (!VALID_STATUSES.includes(s)) {
      throw new InvalidArgumentError(
        `unknown status "${s}". Valid: ${VALID_STATUSES.join(", ")}`,
      );
    }
  }
  return states as RunStatus[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fireWebhook(url: string | undefined, payload: unknown): Promise<void> {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Best effort — a failed notification must never change the exit code.
  } finally {
    clearTimeout(timer);
  }
}

function summarize(runs: Run[]) {
  return runs.map((r) => ({
    run_id: r.run_id,
    service_name: r.service_name,
    status: r.status,
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
  }));
}

function printSummary(runs: Run[], reason: string): void {
  chrome.blank();
  chrome.log(chalk.bold.cyan("  watch resolved") + chalk.dim(` — ${reason}`));
  chrome.blank();
  if (runs.length === 0) {
    log.dim("  (no matching runs)");
    chrome.blank();
    return;
  }
  const table = new Table({
    head: [chalk.dim("Run ID"), chalk.dim("Service"), chalk.dim("Status"), chalk.dim("Duration")],
    style: { head: [], border: ["dim"] },
  });
  for (const r of runs) {
    const duration =
      r.duration_ms != null
        ? formatDuration(r.duration_ms)
        : formatDuration(Date.now() - new Date(r.started_at).getTime());
    table.push([
      chalk.white(r.run_id.slice(0, 8)),
      chalk.white(r.service_name),
      formatStatus(r.status),
      duration,
    ]);
  }
  console.log(table.toString());
  chrome.blank();
}

export function makeWatchCommand(): Command {
  const watch = new Command("watch")
    .description(
      "Block until watched runs resolve (all terminal, or an --until state), then exit with a status-reflecting code (0 ok, 1 problem, 124 timeout)",
    )
    .option("--service <name>", "Watch all runs for a service")
    .option("-s, --session <id>", "Watch all runs in a session")
    .option("--run-id <id>", "Watch a single run")
    .option(
      "--until <states>",
      "Resolve as soon as a run reaches one of these states (comma list)",
      parseUntil,
    )
    .option("--timeout <s>", "Max seconds to wait (0 = no timeout)", intArg)
    .option("--interval <s>", "Poll interval in seconds (default 2)", intArg)
    .option("--webhook <url>", "POST a JSON summary when resolved")
    .action(async (opts) => {
      const parentOpts = watch.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      if (!opts.service && !opts.session && !opts.runId) {
        log.error("Specify --run-id, --session, or --service to watch");
        process.exit(2);
      }

      const until: RunStatus[] | null = opts.until ?? null;
      const intervalMs = (opts.interval ?? 2) * 1000;
      const timeoutMs = (opts.timeout ?? 0) * 1000;
      const client = new PulseClient({ serverUrl: parentOpts.server });
      const start = Date.now();

      const fetchRuns = async (): Promise<Run[]> => {
        if (opts.runId) {
          const r = await client.getRun(opts.runId);
          return r ? [r] : [];
        }
        const res = await client.listRuns({
          service: opts.service,
          session_id: opts.session,
          limit: 500,
        });
        return res.runs;
      };

      for (;;) {
        let runs: Run[] = [];
        try {
          runs = await fetchRuns();
        } catch (error) {
          // A transient fetch failure shouldn't abort a long watch.
          if (!jsonOutput) {
            log.dim(
              `  (server unreachable, retrying) ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await sleep(intervalMs);
          continue;
        }

        const verdict = evaluateWatch(runs, until);

        if (verdict.resolved) {
          await fireWebhook(opts.webhook, {
            resolved: true,
            exit_code: verdict.exitCode,
            reason: verdict.reason,
            counts: verdict.counts,
            runs: summarize(runs),
            timestamp: new Date().toISOString(),
          });
          if (jsonOutput) {
            log.json({
              resolved: true,
              exit_code: verdict.exitCode,
              reason: verdict.reason,
              counts: verdict.counts,
              runs: summarize(runs),
            });
          } else {
            printSummary(runs, verdict.reason);
          }
          process.exit(verdict.exitCode);
        }

        if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
          await fireWebhook(opts.webhook, {
            resolved: false,
            exit_code: 124,
            reason: "timeout",
            counts: verdict.counts,
            runs: summarize(runs),
            timestamp: new Date().toISOString(),
          });
          if (jsonOutput) {
            log.json({
              resolved: false,
              exit_code: 124,
              reason: "timeout",
              counts: verdict.counts,
            });
          } else {
            log.warn(`Timed out after ${opts.timeout}s — ${verdict.reason}`);
          }
          process.exit(124);
        }

        await sleep(intervalMs);
      }
    });

  return watch;
}
