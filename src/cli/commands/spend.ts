import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { PulseClient } from "../../core/client.js";
import { isOverBudget } from "../../core/budget.js";
import { log, chrome } from "../../utils/logger.js";
import type { ServiceSpend, Severity } from "../../core/models.js";

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function sevColor(s: Severity): (text: string) => string {
  if (s === "critical") return chalk.red;
  if (s === "warning") return chalk.yellow;
  return chalk.green;
}

function bar(pct: number | null, severity: Severity, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct ?? 0) / (100 / width))));
  return sevColor(severity)("█".repeat(filled)) + chalk.dim("░".repeat(width - filled));
}

/** The metric (cost or tokens) closest to its limit — the one that drives the
 *  service's overall severity, so the rendered bar never contradicts the verdict. */
function drivingMetric(
  s: ServiceSpend,
): { m: ServiceSpend["budget"]["tokens"]; fmt: (n: number) => string; used: number } | null {
  const candidates = [];
  if (s.budget.cost_usd.limit != null)
    candidates.push({ m: s.budget.cost_usd, fmt: fmtUsd, used: s.cost_usd });
  if (s.budget.tokens.limit != null)
    candidates.push({ m: s.budget.tokens, fmt: fmtTokens, used: s.tokens });
  if (candidates.length === 0) return null;
  return candidates.sort((a, z) => (z.m.pct ?? 0) - (a.m.pct ?? 0))[0];
}

function budgetCell(s: ServiceSpend): string {
  const metric = drivingMetric(s);
  if (!metric || metric.m.limit == null) return chalk.dim("no budget");
  const color = sevColor(metric.m.severity);
  return (
    `${metric.fmt(metric.used)}/${metric.fmt(metric.m.limit)} ` +
    `${bar(metric.m.pct, metric.m.severity)} ` +
    `${color((metric.m.pct ?? 0) + "%")}`
  );
}

/** Plain-text (no ANSI) budget summary for log lines. */
function budgetSummary(s: ServiceSpend): string {
  const metric = drivingMetric(s);
  if (!metric || metric.m.limit == null) return "no budget";
  return `${metric.fmt(metric.used)}/${metric.fmt(metric.m.limit)} (${metric.m.pct ?? 0}%)`;
}

export function makeSpendCommand(): Command {
  const spend = new Command("spend")
    .description(
      "Show token/cost spend per service and session, with budget status",
    )
    .option("--service <name>", "Filter by service")
    .option("--session <id>", "Filter by session")
    .option(
      "--fail-over-budget",
      "Exit non-zero if any shown service is over budget (for loop self-halt)",
    )
    .action(async (opts) => {
      const parentOpts = spend.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      const client = new PulseClient({ serverUrl: parentOpts.server });

      try {
        const data = await client.spend({
          service: opts.service,
          session: opts.session,
        });
        const overBudget = data.services.filter((s) => isOverBudget(s.budget));

        if (jsonOutput) {
          log.json({ ...data, over_budget: overBudget.map((s) => s.key) });
          if (opts.failOverBudget && overBudget.length > 0) process.exit(1);
          return;
        }

        chrome.blank();
        chrome.log(chalk.bold.cyan("  agent-heart spend"));
        chrome.blank();
        chrome.log(
          `  ${chalk.white(fmtTokens(data.total.tokens))} tokens  ` +
            `${chalk.white(fmtUsd(data.total.cost_usd))}  ` +
            `${chalk.dim(data.total.runs + " runs")}`,
        );
        chrome.blank();

        if (data.services.length === 0) {
          log.dim("  No spend recorded yet.");
          chrome.blank();
          return;
        }

        const svcTable = new Table({
          head: [
            chalk.dim("Service"),
            chalk.dim("Tokens"),
            chalk.dim("Cost"),
            chalk.dim("Budget"),
            chalk.dim("Runs"),
          ],
          style: { head: [], border: ["dim"] },
        });
        for (const s of data.services) {
          svcTable.push([
            chalk.white(s.key),
            fmtTokens(s.tokens),
            fmtUsd(s.cost_usd),
            budgetCell(s),
            chalk.dim(String(s.runs)),
          ]);
        }
        console.log(svcTable.toString());
        chrome.blank();

        const topSessions = data.sessions.slice(0, 5);
        if (topSessions.length > 0) {
          chrome.log(chalk.bold("  Top sessions by cost"));
          chrome.blank();
          const sessTable = new Table({
            head: [chalk.dim("Session"), chalk.dim("Tokens"), chalk.dim("Cost"), chalk.dim("Runs")],
            style: { head: [], border: ["dim"] },
          });
          for (const s of topSessions) {
            sessTable.push([
              chalk.white(s.key.length > 12 ? s.key.slice(0, 12) + "…" : s.key),
              fmtTokens(s.tokens),
              fmtUsd(s.cost_usd),
              chalk.dim(String(s.runs)),
            ]);
          }
          console.log(sessTable.toString());
          chrome.blank();
        }

        if (overBudget.length > 0) {
          for (const s of overBudget) {
            log.error(
              `${s.key} is over budget — ${budgetSummary(s)}`,
            );
          }
          chrome.blank();
        }

        if (opts.failOverBudget && overBudget.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to fetch spend: ${error instanceof Error ? error.message : String(error)}`,
          );
          log.dim("Is the server running? Start it with: npx agent-heart server start");
        }
        process.exit(1);
      }
    });

  return spend;
}
