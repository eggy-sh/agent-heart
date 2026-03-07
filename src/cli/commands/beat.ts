import { Command } from "commander";
import { PulseClient } from "../../core/client.js";
import { log } from "../../utils/logger.js";

export function makeBeatCommand(): Command {
  const beat = new Command("beat")
    .description("Send a heartbeat for a service")
    .argument("<service>", "Name of the service to send a heartbeat for")
    .option("--run-id <id>", "Run ID to associate the heartbeat with")
    .option("-s, --session <id>", "Session ID")
    .option("-m, --message <msg>", "Human-readable status message")
    .action(async (service: string, opts) => {
      const parentOpts = beat.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      try {
        const client = new PulseClient({
          serverUrl: parentOpts.server,
          sessionId: opts.session,
        });

        const response = await client.beat(service, {
          run_id: opts.runId,
          message: opts.message,
        });

        if (jsonOutput) {
          log.json(response);
        } else {
          log.success(`Heartbeat sent for ${service}`);
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
            `Failed to send heartbeat: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exit(1);
      }
    });

  return beat;
}
