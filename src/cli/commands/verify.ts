import { Command } from "commander";
import { PulseClient } from "../../core/client.js";
import { log, formatStatus } from "../../utils/logger.js";

export function makeVerifyCommand(): Command {
  const verify = new Command("verify")
    .description(
      "Record an oversight verdict on a completed run (verify after self-review / tests)",
    )
    .requiredOption("--run-id <id>", "Run ID to verify")
    .option("--pass", "Mark verification passed (default)")
    .option("--fail", "Mark verification failed")
    .option("-m, --message <msg>", "Note explaining the verdict")
    .action(async (opts) => {
      const parentOpts = verify.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      if (opts.pass && opts.fail) {
        log.error("Pass --pass or --fail, not both");
        process.exit(2);
      }

      const status = opts.fail ? "failed" : "passed";
      const client = new PulseClient({ serverUrl: parentOpts.server });

      try {
        const run = await client.verify(opts.runId, {
          status,
          message: opts.message,
        });

        if (jsonOutput) {
          log.json(run);
          return;
        }

        if (status === "passed") {
          log.success(`Verified ${opts.runId.slice(0, 8)} — passed`);
        } else {
          log.error(`Marked ${opts.runId.slice(0, 8)} — verification failed`);
        }
        log.dim(`  run status: ${formatStatus(run.status)}`);
        if (run.message) log.dim(`  note: ${run.message}`);
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to verify run: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exit(1);
      }
    });

  return verify;
}
