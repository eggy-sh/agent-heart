# Automatic Observability for OpenClaw Plugin Tool Calls with agent-heart

## Overview

The fastest way to get automatic observability for every `exec` tool call in your OpenClaw plugin is to wire agent-heart's lifecycle (lock, beat, unlock) into OpenClaw's `before_tool_call` and `after_tool_call` plugin hooks. This requires no manual instrumentation of individual tools -- once the hooks are registered, every exec call is tracked automatically.

## Prerequisites

Install agent-heart globally:

```bash
npm install -g agent-heart
```

## Step 1: Register the OpenClaw hooks via the CLI

agent-heart ships with a built-in command that registers itself with OpenClaw's hook system:

```bash
agent-heart hook openclaw
```

This command configures OpenClaw to pipe JSON into agent-heart on every `before_tool_call` and `after_tool_call` event. Once registered, you are done -- all exec tool calls will be tracked automatically.

That single command is the easiest setup. If you need more control or want to understand what is happening under the hood, read on.

## Step 2 (optional): Understand the lifecycle

When OpenClaw fires a tool call, the following happens behind the scenes:

1. **`before_tool_call` hook fires** -- OpenClaw pipes a JSON payload to stdin describing the tool invocation (tool name, arguments, run ID, etc.). agent-heart receives this and performs a **lock** on the run, signaling that execution has started. It then begins emitting periodic **beats** (heartbeats) to indicate the run is still alive.

2. **Tool executes** -- While the tool runs, agent-heart continues heartbeating. If the heartbeat stops arriving (the process crashed or hung), agent-heart will mark the run as **stale** after its configured timeout.

3. **`after_tool_call` hook fires** -- OpenClaw pipes the result JSON to stdin. agent-heart receives this and performs an **unlock**, marking the run as complete. If the tool returned an error or empty output that matches failure heuristics, agent-heart may flag the run as **dead** (silent failure).

## Step 3 (optional): Manual hook wiring

If `agent-heart hook openclaw` does not fit your environment, or you want to customize behavior, you can wire the hooks manually in your OpenClaw plugin configuration.

### Option A: Shell-level hooks (recommended for simplicity)

In your OpenClaw plugin manifest or configuration file, register shell commands for the two hooks:

```json
{
  "hooks": {
    "before_tool_call": "agent-heart exec --lock --stdin",
    "after_tool_call": "agent-heart exec --unlock --stdin"
  }
}
```

OpenClaw will pipe the tool call JSON to stdin of these commands automatically. The `--stdin` flag tells agent-heart to read the run context (run ID, tool name, etc.) from the incoming JSON rather than requiring explicit CLI arguments.

### Option B: TypeScript SDK (for programmatic control)

If your OpenClaw plugin is written in TypeScript/JavaScript and you want finer-grained control, use the agent-heart SDK directly:

```typescript
import { AgentPulse } from "agent-heart";

const pulse = new AgentPulse({
  port: 7778, // default HTTP API port
});

export const hooks = {
  async before_tool_call(context: ToolCallContext) {
    await pulse.lock(context.runId, {
      tool: context.toolName,
      args: context.arguments,
    });
  },

  async after_tool_call(context: ToolCallContext, result: ToolCallResult) {
    await pulse.unlock(context.runId, {
      tool: context.toolName,
      status: result.error ? "dead" : "ok",
      output: result.output,
    });
  },
};
```

This gives you the ability to add custom metadata, override status detection, or conditionally skip tracking for certain tools.

## Step 4: Verify it is working

After registering the hooks, trigger a tool call in your OpenClaw plugin and then check the status:

```bash
agent-heart status
```

This will display all tracked runs and their current states: **active** (locked and heartbeating), **completed** (unlocked successfully), **stale** (heartbeat stopped, possibly stuck), or **dead** (silent failure detected).

You can also query the HTTP API directly:

```bash
curl http://localhost:7778/status
```

## Summary

| Approach | Effort | Control |
|---|---|---|
| `agent-heart hook openclaw` | One command, fully automatic | Least -- uses defaults |
| Shell hooks in plugin manifest | Edit one config file | Moderate -- customize CLI flags |
| TypeScript SDK in hook handlers | Write code in your plugin | Most -- full programmatic control |

For most users, `agent-heart hook openclaw` is the right answer. It registers both hooks automatically and you get full lifecycle tracking (lock/beat/unlock), stale detection, and silent failure flagging with zero code changes to your plugin.
