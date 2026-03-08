# agent-pulse

**Know what your agent started, what it finished, and what got stuck.**

<!-- Badges -->
<!-- [![npm version](https://img.shields.io/npm/v/agent-pulse.svg)](https://www.npmjs.com/package/agent-pulse) -->
<!-- [![license](https://img.shields.io/npm/l/agent-pulse.svg)](./LICENSE) -->
<!-- [![CI](https://github.com/YOUR_ORG/agent-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/agent-pulse/actions) -->

Agents are starting to do real operator work. They run `gh`, `kubectl`, `gws`, `terraform`, `psql`, and whatever internal CLI your team quietly depends on.

That sounds great right up until you need to answer the most basic question: what is the agent doing right now?

`agent-pulse` is a CLI-first observability layer for that exact gap. It tracks the lifecycle of tool calls, tells you when a run is still alive, flags runs that went stale, and makes silent failures visible before they turn into mystery.

---

## The Problem

Most monitoring asks whether the service is up.

If you're running agents through CLIs, that's not the question.

The real questions show up one level lower, in the messy middle between "command started" and "job finished." Your agent kicks off `gh pr create`, `kubectl apply`, `gws drive files list`, or some internal admin script, and now you need to know:

- What tool call did the agent start?
- Is it still running, or did it hang?
- Did it finish, or did it silently disappear?
- Which resource was it operating on?

That middle is where trust breaks. The agent looked busy. Then it stopped talking. Maybe it finished. Maybe it wedged on a prompt. Maybe it died halfway through after touching something important.

Traditional monitoring still matters. But it answers a different question. [Healthchecks](https://github.com/healthchecks/healthchecks) handles dead-man-switch heartbeats. [Uptime Kuma](https://github.com/louislam/uptime-kuma) handles endpoint uptime. [Blackbox Exporter](https://github.com/prometheus/blackbox_exporter) handles probing. None of them model the lifecycle of an agent executing real work through CLIs.

That is the gap `agent-pulse` is built to fill.

## What It Does

**Lifecycle tracking** -- every tool call goes through `lock` (started) -> `beat` (still alive) -> `unlock` (finished). You always know where things stand.

**Stuck-run detection** -- if a locked run exceeds its expected cycle time, it is marked `stale`. No more wondering if something hung.

**Silent failure detection** -- if a run stops sending heartbeats entirely, it is marked `dead`. No more silent disappearances.

**Universal CLI wrapper** -- wrap any command with `agent-pulse exec` and get automatic lifecycle tracking, duration capture, and exit code recording. No code changes required.

```
agent-pulse exec --service github --tool gh --resource pulls \
  -- gh pr list --repo myorg/myrepo
```

## Quickstart

```bash
# Install
npm install -g agent-pulse

# Initialize configuration
agent-pulse init

# Start the local server
agent-pulse server start

# Wrap any CLI command with automatic tracking
agent-pulse exec --service github --tool gh --resource pulls \
  -- gh pr list --repo myorg/myrepo

# Check status
agent-pulse status
```

## CLI Reference

### `agent-pulse exec` -- The Universal Wrapper

The hero feature. Wraps any CLI command with automatic lifecycle tracking.

```bash
# Basic usage
agent-pulse exec --service my-service -- <command>

# Full metadata
agent-pulse exec \
  --service github \
  --tool gh \
  --resource pulls \
  --session my-session-123 \
  --meta env=production \
  -- gh pr list --repo myorg/myrepo

# With custom heartbeat interval
agent-pulse exec \
  --service k8s \
  --tool kubectl \
  --heartbeat-interval 5000 \
  -- kubectl get pods -n production
```

What happens under the hood:
1. Sends `lock` before the command starts
2. Sends periodic `beat` while the command runs
3. Sends `unlock` on completion with exit code and duration
4. If the process dies, the server detects the missing heartbeat and marks the run `stale` then `dead`

### `agent-pulse lock <service>`

Signal that work is starting.

```bash
agent-pulse lock my-service
agent-pulse lock my-service --tool gh --resource repos --message "Starting sync"
```

### `agent-pulse beat <service>`

Send a heartbeat to indicate progress.

```bash
agent-pulse beat my-service
agent-pulse beat my-service --run-id abc123 --message "Processing page 3/10"
```

### `agent-pulse unlock <service>`

Signal that work is complete.

```bash
agent-pulse unlock my-service
agent-pulse unlock my-service --run-id abc123 --exit-code 0
```

### `agent-pulse status`

View current state of all tracked services and runs.

```bash
# Overview
agent-pulse status

# Filter by service
agent-pulse status --service github

# Show only stale/dead runs
agent-pulse status --filter stale,dead

# JSON output for automation
agent-pulse status --json
```

### `agent-pulse server start`

Start the local observability server.

```bash
agent-pulse server start
agent-pulse server start --port 7778 --host 127.0.0.1
```

### `agent-pulse init`

Initialize configuration and data directory.

```bash
agent-pulse init
```

Creates `~/.agent-pulse/config.json` with default settings.

## SDK Usage

Use the TypeScript/Node.js client in your own tools and agents:

```typescript
import { PulseClient } from "agent-pulse";

const client = new PulseClient({
  serverUrl: "http://127.0.0.1:7778",
  sessionId: "my-agent-session",
});

// Manual lifecycle
const { run_id } = await client.lock("github", {
  tool_name: "gh",
  resource_kind: "pulls",
});
// ... do work ...
await client.unlock("github", { run_id, exit_code: 0 });

// Or use the trackRun helper
await client.trackRun("github", async (runId) => {
  // Your work here -- heartbeats are sent automatically
  await deployThing();
}, { tool_name: "gh", resource_kind: "deployments" });

// Check overall status
const overview = await client.overview();
console.log(overview.runs.stale); // number of stuck runs
```

## Claude Code Hooks

`agent-pulse` integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) hooks to automatically track every tool call in an agent session.

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "agent-pulse lock claude-code/session --tool session --message 'Session started'" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "echo '$TOOL_INPUT' | npx agent-pulse hook claude-code --event pre-tool-use" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "echo '$TOOL_INPUT' | npx agent-pulse hook claude-code --event post-tool-use" }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "agent-pulse unlock claude-code/session --tool session --message 'Session ended'" }]
      }
    ]
  }
}
```

See [docs/hooks/claude-code.md](./docs/hooks/claude-code.md) for the full integration guide.

### Continuous Monitoring with `/loop`

Claude Code's [`/loop`](https://code.claude.com/docs/en/scheduled-tasks) runs a prompt on a recurring interval inside your session. Pair it with agent-pulse and the agent monitors its own work in real time.

```
# Watch for stuck runs every 3 minutes
/loop 3m check agent-pulse runs --status stale --json and tell me if anything is stuck

# Watch a specific deploy
/loop 1m check agent-pulse runs --service agent/deploy and tell me when it finishes

# Full session health check
/loop 10m run agent-pulse overview --json and summarize active, stale, and dead runs
```

Hooks record what the agent does. `/loop` watches whether it's going well. See [docs/why-agent-observability.md](./docs/why-agent-observability.md) for why this pattern matters and where the market is headed.

---

## Architecture

```
Agent / Human
      |
      v
  CLI Wrapper (agent-pulse exec)
      |
      |  lock -> beat -> unlock
      v
  Pulse Server (HTTP API)
      |
      v
  SQLite Store ---- Monitor Loop
                        |
                    stale / dead
                    detection
```

**Core lifecycle model**: Every tracked execution is a **Run**. Runs transition through states: `locked` -> `active` -> `completed` (or `failed`). If heartbeats stop, the monitor marks them `stale` then `dead`.

**Components**:
- **CLI** -- the `agent-pulse` binary, used by humans and agents alike
- **Client SDK** -- TypeScript library for programmatic integration
- **Server** -- lightweight HTTP API backed by SQLite
- **Monitor** -- background loop that detects stale and dead runs

See [docs/architecture.md](./docs/architecture.md) for the full breakdown.

## Configuration

Configuration lives at `~/.agent-pulse/config.json`:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7778
  },
  "monitor": {
    "check_interval_ms": 30000,
    "default_expected_cycle_ms": 300000,
    "default_max_silence_ms": 600000
  },
  "services": [
    {
      "name": "github",
      "expected_cycle_ms": 120000,
      "max_silence_ms": 300000
    }
  ],
  "database": {
    "path": "~/.agent-pulse/pulse.db"
  },
  "redact": {
    "enabled": true,
    "patterns": ["password", "secret", "token", "key", "auth", "credential"]
  }
}
```

Key settings:
- `expected_cycle_ms` -- how long a run should take before being marked `stale`
- `max_silence_ms` -- how long since last heartbeat before being marked `dead`
- `redact.patterns` -- sensitive flag/key names to redact from stored commands

## Fair Questions

### Isn't this just Healthchecks for agent runs?

Not really. Healthchecks is great at "did something ping on time?" `agent-pulse` tracks a run as a run: started, still alive, completed, stale, or dead, with tool and resource metadata attached.

### Why not use OpenTelemetry?

You probably still should if your system already speaks OpenTelemetry. But most agent workflows fall apart at the CLI boundary. `agent-pulse` starts there on purpose.

### Why a local server and SQLite?

Because the first version of this should be easy to install, easy to inspect, and hard to break. You can run it on your laptop, wrap a real command, and see whether the model holds before wiring it into something bigger.

### Why focus on CLIs instead of building an SDK only?

Because that is where a lot of agent work already happens. The fastest path to observability is not rewriting every tool integration. It is wrapping the commands agents already use.

See [docs/roadmap.md](./docs/roadmap.md) for what's planned next.

## Inspiration

- [Google Workspace CLI](https://www.npmjs.com/package/@googleworkspace/cli) -- one CLI for humans and AI agents. Demonstrates the shift toward CLI-first resource access.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) -- hooks-based agent that operates through tool calls, with [`/loop`](https://code.claude.com/docs/en/scheduled-tasks) for scheduled background tasks. The target integration for agentic observability.
- [Healthchecks](https://github.com/healthchecks/healthchecks) -- dead-man-switch heartbeat monitoring. Proven model, but lacks lifecycle semantics.

## Contributing

Contributions are welcome.

```bash
# Clone and install
git clone https://github.com/eggy-sh/agent-pulse.git
cd agent-pulse
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run lint
```

Please open an issue before submitting large changes. Keep PRs focused and include tests for new functionality.

## License

[Apache 2.0](./LICENSE)
