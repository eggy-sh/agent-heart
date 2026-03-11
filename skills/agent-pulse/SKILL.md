---
name: agent-heart
description: >
  Integrate agent-heart observability into agentic projects and frameworks.
  agent-heart is a CLI-first observability layer that tracks AI agent tool-call
  lifecycle (lock/beat/unlock), detects stuck runs (stale), and flags silent
  failures (dead). Use this skill whenever the user wants to add observability,
  monitoring, or heartbeat tracking to an agent project, track what an agent is
  doing through CLIs, integrate agent-heart with Claude Code hooks or /loop
  scheduled tasks, connect agent-heart to frameworks like OpenClaw, LangChain,
  LangGraph, CrewAI, OpenAI Agents SDK, or Anthropic Agent SDK, or wrap CLI
  tool calls with lifecycle tracking. Also use when the user mentions
  agent-heart, tool-call observability, stuck-run detection, or wants to
  monitor agentic CLI execution.
---

# agent-heart Integration

agent-heart provides CLI-first observability for AI agent tool calls. It tracks
the full lifecycle of every tool invocation — start, progress, completion,
failure, or disappearance — through a simple lock/beat/unlock model.

## Core Concepts

**Lifecycle model:**
- `lock` — a tool call or run has started
- `beat` — still progressing (heartbeat)
- `unlock` — completed or failed (with exit code)
- `stale` — locked longer than expected (stuck)
- `dead` — no heartbeat received (silent failure)

**Service naming convention:**
- `<runtime>/<tool_or_family>` — e.g., `claude-code/Bash`, `openclaw/github`
- Command families group related CLIs: `gh` → `github`, `kubectl` → `kubernetes`

**Three integration surfaces:**
1. **CLI exec wrapper** — wrap any command with `agent-heart exec`
2. **Hook handlers** — automatic tracking via Claude Code or OpenClaw hooks
3. **SDK client** — programmatic `PulseClient` for custom integrations

## Setup (Required First Step)

Before any integration, agent-heart needs to be installed and its server running.

```bash
npx agent-heart init
npx agent-heart server start
```

The server runs on `127.0.0.1:7778` by default (SQLite-backed, single process).
Config lives at `~/.agent-heart/config.json`.

## Choose Your Integration Approach

Pick the approach that matches the user's framework and needs:

| Framework / Runtime | Best Approach | Reference |
|---|---|---|
| **Claude Code** | Hooks + /loop monitoring | `references/claude-code-integration.md` |
| **OpenClaw** | Plugin hooks or skill-based | `references/openclaw-integration.md` |
| **LangChain / LangGraph** | Custom callback handler | `references/framework-integrations.md` |
| **CrewAI** | Tool wrapper | `references/framework-integrations.md` |
| **OpenAI Agents SDK** | Function tool wrapper | `references/framework-integrations.md` |
| **Anthropic Agent SDK** | Tool callback | `references/framework-integrations.md` |
| **Any CLI tool** | `agent-heart exec` wrapper | See below |
| **Custom / other** | PulseClient SDK | `references/framework-integrations.md` |

Read the appropriate reference file for detailed instructions specific to each
framework.

## Universal CLI Wrapper (Works Everywhere)

The fastest way to add observability to any CLI invocation:

```bash
npx agent-heart exec \
  --service <runtime>/<family> \
  --tool <binary> \
  --resource <resource_kind> \
  -- <actual command...>
```

**Example:**
```bash
npx agent-heart exec \
  --service agent/github \
  --tool gh \
  --resource pulls \
  -- gh pr list --repo myorg/myrepo
```

This automatically:
- Sends `lock` before execution
- Sends periodic `beat` while running (default: every 15s)
- Sends `unlock` on completion with exit code and duration
- Redacts sensitive flags (tokens, passwords, keys)

**Options:**
- `--service <name>` — required, the service to track under
- `--tool <name>` — tool/binary name
- `--resource <kind>` — resource being acted on
- `--session <id>` — session ID for correlation
- `--heartbeat-interval <ms>` — beat frequency (default: 15000)
- `--metadata <json>` — extra metadata as JSON string
- `-q, --quiet` — suppress agent-heart output
- `--json` (parent flag) — machine-readable JSON output

## Programmatic SDK Usage (TypeScript/Node.js)

For custom integrations, use `PulseClient` directly:

```typescript
import { PulseClient } from "agent-heart";

const pulse = new PulseClient({
  serverUrl: "http://127.0.0.1:7778",
  sessionId: "my-session-123",
});

// Option 1: Manual lock/beat/unlock
const { run_id } = await pulse.lock("my-agent/tool", {
  tool_name: "gh",
  command: "gh pr list",
  command_family: "github",
  resource_kind: "pulls",
});

// ... do work ...

await pulse.unlock("my-agent/tool", {
  run_id,
  exit_code: 0,
  message: "Completed successfully",
});

// Option 2: Automatic tracking with trackRun
await pulse.trackRun("my-agent/tool", async (runId) => {
  // Your work here — lock/beat/unlock handled automatically
  await doSomething();
}, {
  tool_name: "custom-tool",
  metadata: { heartbeat_interval_ms: "10000" },
});
```

`trackRun` is the recommended approach — it handles lock, periodic beats,
unlock on success, and unlock with error on failure automatically.

## Checking Status

After integration, verify everything works:

```bash
# Overview of all services
npx agent-heart overview

# List recent runs
npx agent-heart runs

# Filter by service
npx agent-heart runs --service claude-code/Bash

# Filter by status (find problems)
npx agent-heart runs --status stale
npx agent-heart runs --status dead

# JSON output for automation
npx agent-heart overview --json
```

## Monitor Configuration

Tune stale/dead detection per service in `~/.agent-heart/config.json`:

```json
{
  "services": [
    {
      "name": "claude-code/Bash",
      "expected_cycle_ms": 60000,
      "max_silence_ms": 120000
    }
  ],
  "monitor": {
    "check_interval_ms": 30000,
    "default_expected_cycle_ms": 300000,
    "default_max_silence_ms": 600000
  }
}
```

- `expected_cycle_ms` — how long a run should take before it's marked stale
- `max_silence_ms` — how long without any heartbeat before it's marked dead
- Set shorter thresholds for fast tool calls (shell commands), longer for
  operations that naturally take time (deployments, builds)

## Redaction

agent-heart redacts sensitive values from commands by default. Patterns matched:
`password`, `secret`, `token`, `key`, `auth`, `credential`, `api_key`, `apikey`.

Customize in config:

```json
{
  "redact": {
    "enabled": true,
    "patterns": ["password", "secret", "token", "key", "auth", "credential"]
  }
}
```

## Generic Hook Interface

For any framework with a hook/plugin system, agent-heart provides a generic
CLI hook that accepts flags instead of stdin JSON:

```bash
# On tool start
npx agent-heart hook generic \
  --action lock \
  --service my-agent/tool \
  --tool gh \
  --command "gh pr list" \
  --session sess-123

# On tool completion
npx agent-heart hook generic \
  --action unlock \
  --service my-agent/tool \
  --tool gh \
  --exit-code 0 \
  --session sess-123
```

This is the escape hatch for any runtime that can shell out to a CLI.

## Troubleshooting

**Server not reachable:** Make sure `npx agent-heart server start` is running.
Test: `curl http://127.0.0.1:7778/api/v1/health`

**No data after hook fires:** Events are fire-and-forget. Start the server
before running your agent session.

**Runs stuck as "locked":** The monitor marks them stale/dead after the
configured thresholds. Check `npx agent-heart runs --status locked`.

**Redaction too aggressive:** Adjust `redact.patterns` in your config.

**Port conflict:** Change `server.port` in `~/.agent-heart/config.json`.
