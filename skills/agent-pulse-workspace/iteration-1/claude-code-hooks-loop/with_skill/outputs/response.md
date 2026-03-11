# Setting Up agent-heart Hooks and /loop Monitoring in Claude Code

Below is a complete walkthrough for wiring agent-heart into your Claude Code project so every tool call is tracked automatically, plus a `/loop` that alerts you when something goes stale.

---

## Prerequisites

Install agent-heart globally, initialize its config, and start the local server. These three commands only need to be run once (the server must be running whenever you use Claude Code with agent-heart):

```bash
npm install -g agent-heart
agent-heart init
agent-heart server start
```

The server listens on `127.0.0.1:7778` by default and stores data in SQLite. You can verify it is running with:

```bash
curl http://127.0.0.1:7778/api/v1/health
```

---

## Step 1 -- Add Claude Code Hooks

Create (or edit) the file `.claude/settings.json` in your project root. If you want the hooks active across all projects, use `~/.claude/settings.json` instead.

Paste the following configuration:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx agent-heart hook claude-code --event session-start"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx agent-heart hook claude-code --event pre-tool-use && agent-heart beat claude-code/session"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx agent-heart hook claude-code --event post-tool-use"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx agent-heart hook claude-code --event session-end"
          }
        ]
      }
    ]
  }
}
```

### What each hook does

| Hook | Fires when | agent-heart action |
|---|---|---|
| `SessionStart` | A Claude Code session begins | `lock` on `claude-code/session` |
| `PreToolUse` | Before every tool call (Bash, Read, Write, Grep, Glob, etc.) | `lock` on `claude-code/<tool_name>`, plus a heartbeat on the session so it stays marked active |
| `PostToolUse` | After every tool call completes | `unlock` on `claude-code/<tool_name>` with exit status and duration |
| `SessionEnd` | The session exits | `unlock` on `claude-code/session` |

Claude Code pipes event JSON to stdin for each hook invocation. The agent-heart handler parses it and sends the corresponding lifecycle event to the server. No extra wiring is needed on your part.

### What gets recorded per tool call

- Tool name (Bash, Read, Write, Grep, Glob, Agent, etc.)
- Redacted command/input summary (secrets like tokens and passwords are scrubbed automatically)
- Exit status and wall-clock duration
- Session ID (for correlating all calls in one session)
- Working directory and model metadata

Full tool output, file contents, and raw API responses are **not** stored.

### Optional: track only specific tools

If you want to reduce noise and only track filesystem and shell operations, set the `matcher` field to a regex. For example, to track only Bash, Read, Write, Grep, Glob, and Agent:

```json
"PreToolUse": [
  {
    "matcher": "^(Bash|Read|Write|Grep|Glob|Agent)$",
    "hooks": [
      {
        "type": "command",
        "command": "npx agent-heart hook claude-code --event pre-tool-use && agent-heart beat claude-code/session"
      }
    ]
  }
]
```

Apply the same matcher pattern to the `PostToolUse` entry to keep them consistent.

---

## Step 2 -- Set Up a /loop for Stale-Run Alerts

Once your hooks are in place and you start a Claude Code session, type the following to create a recurring monitoring loop:

```
/loop 3m check agent-heart status for stale or dead runs and alert me
```

This asks Claude to run `agent-heart overview --json` every 3 minutes and report anything concerning -- stuck tool calls, dead sessions, or unexpected failures.

### More targeted loops you can use

**Stale run watcher** -- catches tool calls that are hanging:

```
/loop 2m check agent-heart runs --status stale --json and if there are any stale runs, tell me which service and how long they've been stuck
```

**Dead session detector** -- finds sessions that vanished without a clean exit:

```
/loop 5m check agent-heart runs --status dead --json and alert me if any runs died in the last 10 minutes
```

**Full health dashboard** -- a broader periodic summary:

```
/loop 10m run agent-heart overview --json and give me a brief status summary. highlight any services with stale or dead runs, and note any services with high failure rates
```

Pick whichever combination makes sense for your workflow. You can run multiple loops simultaneously (up to 50 per session).

### /loop tips

- Loops are session-scoped; they stop when you exit Claude Code.
- Intervals use `s`, `m`, `h`, `d` units (minimum granularity is 1 minute).
- Scheduled prompts fire between turns, not mid-response.
- To see active loops, ask: "what scheduled tasks do I have?"
- To cancel one, say: "cancel the stale run watcher"

---

## Step 3 -- Tune Stale/Dead Thresholds (Optional)

The default thresholds (5 minutes for stale, 10 minutes for dead) work for most interactive sessions. If you want tighter detection for fast tool calls like shell commands, edit `~/.agent-heart/config.json`:

```json
{
  "services": [
    {
      "name": "claude-code/Bash",
      "expected_cycle_ms": 60000,
      "max_silence_ms": 120000
    },
    {
      "name": "claude-code/Read",
      "expected_cycle_ms": 15000,
      "max_silence_ms": 30000
    }
  ],
  "monitor": {
    "check_interval_ms": 30000,
    "default_expected_cycle_ms": 300000,
    "default_max_silence_ms": 600000
  }
}
```

- `expected_cycle_ms` -- how long a run should take before it is marked **stale**.
- `max_silence_ms` -- how long without any heartbeat before it is marked **dead**.

Set shorter thresholds for fast operations (Bash, Read) and leave the defaults for things that naturally take longer.

---

## Step 4 -- Verify Everything Works

After starting a new Claude Code session with the hooks in place:

```bash
# See an overview of all tracked services
agent-heart overview

# List recent runs
agent-heart runs

# Filter to a specific tool
agent-heart runs --service claude-code/Bash

# Check for problems
agent-heart runs --status stale
agent-heart runs --status dead
```

Or ask Claude directly at the end of a session:

```
show me agent-heart overview for this session -- what tools were used, how many succeeded/failed, and were there any issues?
```

---

## Summary

| What | Where | Purpose |
|---|---|---|
| Hook config | `.claude/settings.json` (project) or `~/.claude/settings.json` (global) | Automatically tracks every tool call lifecycle |
| /loop | Typed into Claude Code at session start | Proactive alerting for stale/dead runs |
| Threshold tuning | `~/.agent-heart/config.json` | Controls when runs are flagged as stale or dead |
| Server | `agent-heart server start` | Must be running for any of the above to work |

Hooks give you **complete tracking**. The /loop gives you **proactive alerting**. Together they ensure you always know what tools the agent is using and get warned the moment something goes quiet.
