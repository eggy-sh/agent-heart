import { Command } from "commander";
import { PulseClient } from "../../core/client.js";
import { log } from "../../utils/logger.js";

export function makeLockCommand(): Command {
  const lock = new Command("lock")
    .description("Manually lock a service (indicate work is starting)")
    .argument("<service>", "Name of the service to lock")
    .option("-s, --session <id>", "Session ID to associate with the run")
    .option("-t, --tool <name>", "Tool name being invoked")
    .option("-r, --resource <kind>", "Resource kind being acted on")
    .option("-m, --message <msg>", "Human-readable message for the lock event")
    .option("--metadata <json>", "Additional metadata as JSON string")
    .action(async (service: string, opts) => {
      const parentOpts = lock.parent?.opts() ?? {};
      const jsonOutput = parentOpts.json === true;

      try {
        const client = new PulseClient({
          serverUrl: parentOpts.server,
          sessionId: opts.session,
        });

        let metadata: Record<string, string> | undefined;
        if (opts.metadata) {
          try {
            metadata = JSON.parse(opts.metadata);
          } catch {
            log.error("Invalid JSON for --metadata");
            process.exit(1);
          }
        }

        const response = await client.lock(service, {
          tool_name: opts.tool,
          resource_kind: opts.resource,
          message: opts.message,
          metadata,
        });

        if (jsonOutput) {
          log.json(response);
        } else {
          log.success(`Locked service ${service}`);
          log.info(`  run_id: ${response.run_id}`);
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
            `Failed to lock service: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.exit(1);
      }
    });

  return lock;
}
