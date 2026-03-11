# Setting Up agent-heart Hooks in Claude Code with a /loop Stale Alert

This guide walks you through wiring agent-heart into Claude Code so every tool call is tracked, and a recurring `/loop` command watches for stale runs.

---

## Prerequisites

Install agent-heart globally:

```bash
npm install -g agent-heart
```

Start the agent-heart daemon (runs the HTTP API on port 7778):

```bash
agent-heart exec
```

Leave this running in a separate terminal, or run it as a background process.

---

## Step 1: Configure Claude Code Hooks

Claude Code hooks are configured in your project's `.claude/hooks.json` file (or the global `~/.claude/hooks.json` if you want this active across all projects). Create or edit the file with the following content:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "agent-heart hook lock --session $CLAUDE_SESSION_ID --label 'claude-code-session'",
        "description": "Register a new agent-heart run when the Claude Code session starts"
      }
    ],
    "PreToolUse": [
      {
        "command": "agent-heart hook beat --session $CLAUDE_SESSION_ID --tool $CLAUDE_TOOL_NAME",
        "description": "Send a heartbeat to agent-heart before each tool call"
      }
    ],
    "PostToolUse": [
      {
        "command": "agent-heart hook beat --session $CLAUDE_SESSION_ID --tool $CLAUDE_TOOL_NAME --status complete",
        "description": "Send a completion heartbeat to agent-heart after each tool call"
      }
    ],
    "SessionEnd": [
      {
        "command": "agent-heart hook unlock --session $CLAUDE_SESSION_ID",
        "description": "Release the agent-heart run when the Claude Code session ends"
      }
    ]
  }
}
```

### What each hook does

| Hook | Lifecycle event | agent-heart action |
|---|---|---|
| **SessionStart** | Claude Code session begins | `lock` -- registers a new tracked run, starts the heartbeat clock |
| **PreToolUse** | Right before a tool (Bash, Read, Write, etc.) executes | `beat` -- sends a heartbeat so agent-heart knows the agent is alive and which tool is about to run |
| **PostToolUse** | Right after a tool finishes | `beat --status complete` -- confirms the tool call completed, resets the staleness timer |
| **SessionEnd** | Claude Code session closes | `unlock` -- marks the run as finished, cleans up tracking state |

### Environment variables available in hooks

Claude Code exposes several environment variables to hook commands:

- `$CLAUDE_SESSION_ID` -- unique identifier for the current session
- `$CLAUDE_TOOL_NAME` -- name of the tool being invoked (e.g., `Bash`, `Read`, `Write`, `Grep`)

These are used above to pass context into agent-heart so you can see exactly which session and which tool each event belongs to.

---

## Step 2: Verify the hooks are working

After saving `.claude/hooks.json`, start a new Claude Code session and run a few commands. Then check agent-heart status:

```bash
agent-heart status
```

You should see your session listed with recent heartbeat timestamps and the tools that have been called. You can also query the HTTP API directly:

```bash
curl http://localhost:7778/status
```

---

## Step 3: Set up a /loop to alert on stale runs

Claude Code's `/loop` command lets you define a recurring prompt that runs on a schedule. Use it to periodically check agent-heart for stale sessions and alert you.

In your Claude Code session, run:

```
/loop every 2 minutes: Run `agent-heart status --format json` and check for any runs where the state is "stale" or "dead". If you find any, alert me with the session ID, the last tool that was called, and how long ago the last heartbeat was. If everything is healthy, say nothing.
```

### What this does

- Every 2 minutes, Claude Code will automatically execute the prompt.
- It runs `agent-heart status --format json` to get structured output about all tracked runs.
- It inspects the results for any run marked `stale` (no heartbeat received within the expected interval) or `dead` (no heartbeat for an extended period, likely a silent failure).
- If something is wrong, it surfaces the details to you. If everything is fine, it stays silent so you are not interrupted.

### Tuning the interval

You can adjust the frequency depending on your needs:

- `every 1 minute` -- tighter monitoring for critical sessions
- `every 5 minutes` -- lighter touch for long-running background work

---

## Step 4 (Optional): Custom stale thresholds

By default, agent-heart uses its own thresholds to determine when a run is stale vs. dead. If your agent sessions involve long-running tool calls (e.g., large builds or test suites), you may want to increase the stale threshold when locking:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "agent-heart hook lock --session $CLAUDE_SESSION_ID --label 'claude-code-session' --stale-timeout 300",
        "description": "Register run with a 5-minute stale threshold"
      }
    ]
  }
}
```

The `--stale-timeout 300` flag sets the threshold to 300 seconds (5 minutes) before a run is considered stale.

---

## Summary

| Component | Purpose |
|---|---|
| `.claude/hooks.json` | Wires Claude Code lifecycle events into agent-heart lock/beat/unlock |
| `agent-heart exec` | Runs the agent-heart daemon and HTTP API |
| `agent-heart status` | CLI check on all tracked runs |
| `/loop` | Recurring Claude Code prompt that watches for stale/dead runs and alerts you |

With this setup, every tool call in your Claude Code session is tracked through agent-heart, and the `/loop` command acts as a watchdog that will notify you if anything goes stale or silently fails.
