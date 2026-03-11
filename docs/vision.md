# Project Vision

## The Shift

Resource management is moving from GUIs to CLIs. Not because CLIs are new, but because a new class of operator has arrived: the AI agent.

Agents cannot click buttons. They cannot navigate dashboards. They operate through tool calls -- and for most platforms, that means CLIs. Google is shipping [Google Workspace CLI](https://www.npmjs.com/package/@googleworkspace/cli) with explicit support for AI agents. GitHub has `gh`. Kubernetes has `kubectl`. AWS has `aws`. The pattern is clear: **CLIs are becoming the primary interface for both human and agentic resource access.**

This creates an observability gap.

## Agents as First-Class CLI Operators

When a human runs `gh pr create`, they see the output, notice if it hangs, and can ctrl-C if something goes wrong. When an agent runs the same command inside an automated session, none of that happens. The agent might:

- Start a long-running command and move on without waiting
- Retry a failing command in a loop
- Hang on a command that requires interactive input
- Lose its session before a command completes
- Run dozens of tool calls with no record of which succeeded or failed

Traditional uptime monitoring does not help here. "Is GitHub's API up?" is a different question from "Did the agent's `gh pr merge` call finish, or is it stuck waiting for a check to pass?"

## The Missing Observability Layer

The world has good tools for two things:

1. **Resource access** -- CLIs that let you manage cloud resources, repositories, databases, deployments
2. **Infrastructure monitoring** -- tools that tell you if endpoints are reachable and services are running

What is missing is the layer in between: **execution observability for tool calls made by agents.**

This layer needs to answer:

- What tool call started?
- Is it still running?
- Has it exceeded its expected duration?
- Did it complete, fail, or vanish?
- What resource was it operating on?
- How long did it take?

`agent-heart` is built for exactly this.

## Why Stale/Dead Matters More Than Up/Down

Traditional monitoring uses a binary model: a service is either up or down. That works for long-running servers. It does not work for agent-driven tool calls, which are short-lived, numerous, and have expected durations.

`agent-heart` uses a lifecycle model with two failure modes that matter far more for agent work:

**Stale** -- a run has been locked (started) longer than its expected cycle time. The tool call might be hanging, the agent might be stuck in a retry loop, or the underlying service might be throttling. The run is not dead -- it is still technically active -- but it is not progressing as expected.

**Dead** -- a run has stopped sending heartbeats entirely. The agent session might have crashed, the network might have dropped, or the process might have been killed. There is no activity at all.

This distinction is critical for agents because:

- A stale run might recover on its own (e.g., API throttling clears up)
- A dead run will never recover -- something needs to intervene
- Alert thresholds should be different for stale vs. dead
- Remediation actions are different: wait vs. restart vs. escalate

## Comparison with Existing Tools

| Capability | agent-heart | Healthchecks | Uptime Kuma | Blackbox Exporter |
|---|---|---|---|---|
| **Dead-man-switch heartbeat** | Yes | Yes | No | No |
| **Lock/unlock lifecycle tracking** | Yes | No | No | No |
| **Stale detection (stuck runs)** | Yes | No | No | No |
| **Dead detection (silent failure)** | Yes | Yes (via missed pings) | No | No |
| **CLI wrapper for any command** | Yes | No | No | No |
| **Per-run metadata (tool, resource)** | Yes | Limited (tags) | No | No |
| **Session/run correlation** | Yes | No | No | No |
| **Agent hook integration** | Yes | No | No | No |
| **Endpoint probing** | Planned | No | Yes | Yes |
| **Status page / dashboard** | Planned | No | Yes | No (Grafana) |
| **Self-hosted** | Yes | Yes | Yes | Yes |
| **Designed for agent workloads** | Yes | No | No | No |

**Healthchecks** is the closest conceptually -- it uses a ping/miss model similar to heartbeats. But it does not track execution lifecycle (start/progress/end), does not wrap CLI commands, and does not correlate runs within agent sessions.

**Uptime Kuma** and **Blackbox Exporter** solve a fundamentally different problem: "is this endpoint reachable?" That is useful infrastructure monitoring, but it tells you nothing about what an agent is doing through tools.

## Design Principles

1. **CLI-first** -- the primary interface is a CLI binary that agents and humans both use
2. **Lifecycle-aware** -- every tracked execution has a beginning, middle, and end
3. **Vendor-neutral** -- works with any CLI, any agent framework, any platform
4. **Privacy-conscious** -- sensitive command arguments are redacted by default
5. **Composable** -- use the CLI wrapper, the SDK, or the hooks -- whatever fits your workflow
6. **Lightweight** -- single binary, SQLite storage, no external dependencies at runtime

## The Wedge

Most tools in this space focus on one of two things:

- Access to resources via CLI
- Monitoring services and endpoints

Very few sit in the middle and answer: what was the agent doing, which CLI was involved, did it finish, did it get stuck, did it disappear mid-task?

That middle layer is where `agent-heart` lives. It is the observability plane for CLI-driven agent work.
