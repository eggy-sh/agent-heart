import { Command } from "commander";
import { makeServerCommand } from "./commands/server.js";
import { makeLockCommand } from "./commands/lock.js";
import { makeBeatCommand } from "./commands/beat.js";
import { makeUnlockCommand } from "./commands/unlock.js";
import { makeExecCommand } from "./commands/exec.js";
import { makeStatusCommand } from "./commands/status.js";
import { makeInitCommand } from "./commands/init.js";
import { makeHookCommand } from "./commands/hook.js";
import { makeRunsCommand } from "./commands/runs.js";
import { makeOverviewCommand } from "./commands/overview.js";
import { makeGwsCommand } from "./commands/gws.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("agent-heart")
    .description(
      "CLI-first observability layer for AI agents — lifecycle tracking, stuck-run detection, and silent failure alerts",
    )
    .version("0.2.0")
    .option("--json", "Output as JSON for machine-readable consumption")
    .option("--server <url>", "Override the server URL");

  // Register subcommands
  program.addCommand(makeServerCommand());
  program.addCommand(makeLockCommand());
  program.addCommand(makeBeatCommand());
  program.addCommand(makeUnlockCommand());
  program.addCommand(makeExecCommand());
  program.addCommand(makeStatusCommand());
  program.addCommand(makeInitCommand());
  program.addCommand(makeHookCommand());
  program.addCommand(makeRunsCommand());
  program.addCommand(makeOverviewCommand());
  program.addCommand(makeGwsCommand());

  return program;
}

// Run when executed directly
const program = createProgram();
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
