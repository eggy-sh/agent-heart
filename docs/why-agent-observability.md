# Why Agent Observability

## The Market Is Moving Here

Here's the thing about `/loop`. It's not just a convenience feature. It's a signal.

Anthropic didn't ship scheduled tasks because people asked for cron in their terminal. They shipped it because agents need to do work over time -- check on deploys, babysit pull requests, poll for build status -- and the infrastructure for that has to live somewhere.

The same pattern is showing up everywhere.

---

## Three Platforms, One Direction

**Google** shipped [Google Workspace CLI](https://www.npmjs.com/package/@googleworkspace/cli) with explicit AI agent support. Not a REST API wrapper. A CLI designed for both humans and agents, with structured JSON output and runtime command discovery. That's a platform saying: agents are going to operate through this interface, so we'd better make it good.

**GitHub** built `gh` into the default toolset for every coding agent. When Claude Code runs `gh pr create`, it's not calling a library. It's executing a CLI. Same for `kubectl`, `terraform`, `aws`. The pattern is consistent: CLIs are the operational boundary where agent work actually happens.

**Anthropic** added hooks to Claude Code -- `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd` -- and now [`/loop`](https://code.claude.com/docs/en/scheduled-tasks) for recurring background tasks. That's a runtime acknowledging that agents need lifecycle infrastructure, not just a prompt-and-response loop.

---

## The Gap Nobody Fills

But here's what none of these platforms answer on their own: **what happened?**

Google's CLI gives access to Drive. `/loop` gives scheduling. Claude Code hooks give lifecycle events. Nobody is aggregating that into "your agent started 14 tool calls, 12 finished, one is stale, and one disappeared."

That's the gap. The resource planes are maturing fast. The observability plane barely exists.

`agent-heart` sits in that gap. Not as another framework. Not as another dashboard. As a thin runtime ledger that answers the most basic operational question: did the agent's work actually land?

---

## `/loop` + Hooks: Continuous Agent Observability

Claude Code's `/loop` command runs a prompt on a recurring interval inside your session. Think of it as cron for your agent. You type `/loop 5m check the deploy` and Claude runs that check every five minutes until you stop it or close the session.

Pair that with `agent-heart` and you get something that didn't exist before: **an agent that monitors its own work in real time.**

```
/loop 3m check npx agent-heart runs --status stale --json and tell me if anything is stuck
```

That one line creates a background watcher. Every three minutes, Claude queries agent-heart, looks for stale or dead runs, and surfaces problems before you notice them yourself. The hooks record what the agent does. The loop watches whether it's going well.

### Patterns That Work

```
# Catch stuck tool calls early
/loop 2m check npx agent-heart for stale runs and tell me which service is stuck

# Watch a specific deploy
/loop 1m check npx agent-heart runs --service agent/deploy and tell me when it finishes

# Full session health check
/loop 10m run npx agent-heart overview --json and summarize active, stale, and dead runs

# One-shot reminder (not recurring)
in 30 minutes, run npx agent-heart overview and tell me if the deploy completed
```

### How `/loop` Works

Loops are session-scoped -- they stop when you exit Claude Code, auto-expire after three days, and fire between turns so they never interrupt mid-response. Intervals support `s`, `m`, `h`, `d` units (seconds rounded up to nearest minute). Default is every 10 minutes if you don't specify.

Under the hood, Claude uses `CronCreate`, `CronList`, and `CronDelete` tools. You can manage loops in natural language:

```
what scheduled tasks do I have?
cancel the stale run watcher
```

Maximum 50 scheduled tasks per session.

---

## What This Looks Like in Practice

**Step 1:** Set up Claude Code hooks (see [hooks/claude-code.md](./hooks/claude-code.md)) so every tool call is tracked automatically.

**Step 2:** At the start of a work session, set up a monitoring loop:

```
/loop 3m check npx agent-heart for stale or dead runs and warn me
```

**Step 3:** Work normally. Every Bash command, file read, file write, grep, and agent spawn is recorded. The loop watches for problems in the background.

**Step 4:** At the end of the session, ask for a summary:

```
run npx agent-heart overview --json and summarize this session -- what tools were used, how many succeeded, and were there any issues?
```

The combination of hooks (tracking) plus `/loop` (watching) is the first version of what continuous agent observability looks like in practice. And it works today.
