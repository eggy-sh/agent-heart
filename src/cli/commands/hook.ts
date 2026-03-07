import { Command } from "commander";
import { PulseClient } from "../../core/client.js";
import { handleHookEvent, readStdin } from "../../hooks/claude-code.js";
import { readStdinAndHandle as handleOpenClawStdin } from "../../hooks/openclaw.js";
import { log } from "../../utils/logger.js";

/**
 * Read stdin with a timeout to avoid hanging when no input is piped.
 * Returns the raw string or empty string on timeout / TTY.
 */
async function readStdinWithTimeout(timeoutMs = 5000): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];

  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    }, timeoutMs);

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

export function makeHookCommand(): Command {
  const hook = new Command("hook")
    .description(
      "Dispatch hook events from agent runtimes (claude-code, openclaw, generic)",
    )
    .argument("<runtime>", "Agent runtime: claude-code, openclaw, or generic")
    .option(
      "--event <type>",
      "Event type (claude-code: session-start, pre-tool-use, post-tool-use, session-end)",
    )
    .option("--action <action>", "Action for generic hooks: lock, beat, unlock")
    .option("--service <name>", "Service name (generic hooks)")
    .option("-t, --tool <name>", "Tool name (generic hooks)")
    .option("--command <cmd>", "Command string (generic hooks)")
    .option("-s, --session <id>", "Session ID (generic hooks)")
    .option("-m, --message <msg>", "Message (generic hooks)")
    .option("--exit-code <code>", "Exit code for unlock (generic hooks)", parseInt)
    .option("--metadata <json>", "Additional metadata as JSON string")
    .option("--timeout <ms>", "Stdin read timeout in milliseconds", parseInt)
    .action(async (runtime: string, opts) => {
      const parentOpts = hook.parent?.opts() ?? {};
      const serverUrl: string | undefined = parentOpts.server;

      try {
        switch (runtime) {
          case "claude-code": {
            if (!opts.event) {
              log.error(
                "--event is required for claude-code hooks (session-start, pre-tool-use, post-tool-use, session-end)",
              );
              process.exit(1);
            }

            await handleHookEvent(opts.event);
            break;
          }

          case "openclaw": {
            await handleOpenClawStdin();
            break;
          }

          case "generic": {
            const action = opts.action;
            const service = opts.service;

            if (!action || !service) {
              log.error(
                "--action and --service are required for generic hooks",
              );
              log.dim(
                'Usage: agent-pulse hook generic --action lock --service my-agent --tool bash --command "ls -la"',
              );
              process.exit(1);
            }

            if (!["lock", "beat", "unlock"].includes(action)) {
              log.error(
                `Invalid action "${action}". Must be one of: lock, beat, unlock`,
              );
              process.exit(1);
            }

            // Parse optional metadata
            let metadata: Record<string, string> | undefined;
            if (opts.metadata) {
              try {
                metadata = JSON.parse(opts.metadata);
              } catch {
                log.error("Invalid JSON for --metadata");
                process.exit(1);
              }
            }

            // Also try to read stdin for additional JSON payload
            const stdinTimeout = opts.timeout ?? 500;
            const stdinRaw = await readStdinWithTimeout(stdinTimeout);
            if (stdinRaw.trim()) {
              try {
                const stdinData = JSON.parse(stdinRaw) as Record<string, unknown>;
                // Merge stdin metadata with CLI metadata (CLI takes precedence)
                if (stdinData.metadata && typeof stdinData.metadata === "object") {
                  metadata = {
                    ...(stdinData.metadata as Record<string, string>),
                    ...metadata,
                  };
                }
              } catch {
                // Ignore invalid stdin JSON for generic hooks — CLI flags are primary
              }
            }

            const client = new PulseClient({
              serverUrl,
              sessionId: opts.session,
            });

            const requestOpts = {
              tool_name: opts.tool,
              command: opts.command,
              message: opts.message,
              exit_code: opts.exitCode,
              metadata,
            };

            switch (action) {
              case "lock":
                await client.lock(service, requestOpts);
                break;
              case "beat":
                await client.beat(service, requestOpts);
                break;
              case "unlock":
                await client.unlock(service, requestOpts);
                break;
            }

            break;
          }

          default:
            log.error(
              `Unknown runtime "${runtime}". Supported: claude-code, openclaw, generic`,
            );
            process.exit(1);
        }
      } catch (error) {
        log.error(
          `Hook failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  return hook;
}
