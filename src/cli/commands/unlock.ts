import { Command } from "commander";
import { PulseClient } from "../../core/client.js";
import { parseIntArg, parseFloatArg } from "../parse.js";
import { log } from "../../utils/logger.js";

export function makeUnlockCommand(): Command {
  const unlock = new Command("unlock")
    .description("Unlock a service (mark work as complete)")
    .argument("<service>", "Name of the service to unlock")
    .option("--run-id <id>", "Run ID to unlock")
    .option("-s, --session <id>", "Session ID")
    .option(
      "--exit-code <n>",
      "Exit code of the completed work",
      parseIntArg,
    )
    .option("-m, --message <msg>", "Completion message")
    .option("--tokens <n>", "Total tokens used by this run", parseIntArg)
    .option("--cost <usd>", "Total cost (USD) of this run", parseFloatArg)
    .option(
      "--needs-verify",
      "Mark the run completed-but-unverified (awaiting oversight)",
    )
    .action(async (service: string, opts) => {
      const parentOpts = unlock.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      try {
        const client = new PulseClient({
          serverUrl: parentOpts.server,
          sessionId: opts.session,
        });

        const response = await client.unlock(service, {
          run_id: opts.runId,
          exit_code: opts.exitCode,
          message: opts.message,
          ...(opts.tokens !== undefined && { tokens: opts.tokens }),
          ...(opts.cost !== undefined && { cost_usd: opts.cost }),
          ...(opts.needsVerify && { requires_verification: true }),
        });

        if (jsonOutput) {
          log.json(response);
        } else {
          log.success(`Unlocked service ${service}`);
          log.dim(`  run_id: ${response.run_id}`);
          log.dim(`  status: ${response.status}`);
          log.dim(`  timestamp: ${response.timestamp}`);
        }
      } catch (error) {
        if (jsonOutput) {
          log.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          log.error(
            `Failed to unlock service: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exit(1);
      }
    });

  return unlock;
}
