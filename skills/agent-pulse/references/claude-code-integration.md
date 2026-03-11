# Claude Code Integration

This reference covers two complementary approaches for using agent-heart with
Claude Code:

1. **Hooks** — automatic tool-call tracking via Claude Code lifecycle hooks
2. **/loop monitoring** — continuous observability during active sessions

Use hooks for tracking. Use /loop for watching. Best results come from both.

---

## Part 1: Claude Code Hooks

Claude Code emits lifecycle events at four points:

| Hook | When | agent-heart Action |
|---|---|---|
| `SessionStart` | Session begins | `lock` on `claude-code/session` |
| `PreToolUse` | Before each tool call | `lock` on `claude-code/<tool_name>` |
| `PostToolUse` | After each tool call | `unlock` on `claude-code/<tool_name>` |
| `SessionEnd` | Session ends | `unlock` on `claude-code/session` |

### Full Hook Setup

Create or edit `.claude/settings.json` in the project root (or
`~/.claude/settings.json` for all projects):

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
            "command": "npx agent-heart hook claude-code --event pre-tool-use"
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

Claude Code pipes event JSON to stdin for each hook. The agent-heart handler
parses it and sends the appropriate lifecycle event.

### What Gets Tracked

**Session-level:** SessionStart creates a locked run on `claude-code/session`.
SessionEnd unlocks it. If the session crashes, the monitor marks it stale then
dead — giving you visibility into sessions that disappeared mid-work.

**Tool-call level:** PreToolUse creates a locked run on
`claude-code/<tool_name>` (e.g., `claude-code/Bash`, `claude-code/Read`).
PostToolUse unlocks it with the result. Hanging tool calls get flagged by the
monitor.

**What is stored per tool call:**
- Tool name (Bash, Read, Write, Grep, Glob, etc.)
- Redacted command/input summary
- Exit status and duration
- Session ID for correlation
- Working directory and model metadata

**What is NOT stored:**
- Full tool output/response content
- File contents read or written
- Raw API responses
- Unredacted secrets or tokens

### Session Heartbeat Enhancement

For long-running sessions, add a session-level heartbeat on every tool call so
the session stays marked active:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx agent-heart hook claude-code --event pre-tool-use && npx agent-heart beat claude-code/session"
          }
        ]
      }
    ]
  }
}
```

The `npx agent-heart beat claude-code/session` call ensures the session run stays
active as long as tool calls are happening. Without it, a session that goes
quiet between tool calls could be marked stale.

### Selective Tracking

Use the `matcher` field to limit which tools are tracked:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|Read|Write|Grep|Glob|Agent)$",
        "hooks": [
          {
            "type": "command",
            "command": "npx agent-heart hook claude-code --event pre-tool-use"
          }
        ]
      }
    ]
  }
}
```

This is useful if you only care about filesystem and shell operations, or want
to reduce noise from high-frequency read operations.

### Programmatic Hook Usage

For custom tools or wrappers that integrate with Claude Code:

```typescript
import {
  handleSessionStart,
  handlePreToolUse,
  handlePostToolUse,
  handleSessionEnd,
} from "agent-heart/hooks/claude-code";

// Read stdin JSON and dispatch
const data = JSON.parse(stdinContent);
await handlePreToolUse(data);
```

---

## Part 2: /loop Monitoring

Claude Code's `/loop` command runs a prompt on a recurring schedule within the
session. Combined with agent-heart, this creates a live monitoring loop that
watches for stuck runs, dead sessions, and anomalies while you work.

### Basic Monitoring Loop

```text
/loop 5m check npx agent-heart status for any stale or dead runs and alert me
```

This asks Claude to run `agent-heart overview --json` every 5 minutes and
report anything that looks concerning.

### Recommended Monitoring Loops

**Stale run watcher** — catch stuck tool calls early:
```text
/loop 2m check npx agent-heart runs --status stale --json and if there are any stale runs, tell me which service and how long they've been stuck
```

**Dead session detector** — find sessions that vanished:
```text
/loop 5m check npx agent-heart runs --status dead --json and alert me if any runs died in the last 10 minutes
```

**Full health dashboard** — periodic overview:
```text
/loop 10m run npx agent-heart overview --json and give me a brief status summary. highlight any services with stale or dead runs, and note any services with high failure rates
```

**Deployment watcher** — monitor a specific service:
```text
/loop 1m check npx agent-heart runs --service agent/deploy --json and tell me when the deploy completes or if it goes stale
```

**Session audit** — track what the current session is doing:
```text
/loop 5m run npx agent-heart runs --session $(npx agent-heart overview --json | jq -r '.services[0].last_heartbeat // empty') --json and summarize what tools have been used and their success rate
```

### Loop + Hooks Together

The most powerful setup combines hooks (for tracking) with /loop (for watching):

1. **Hooks** fire on every tool call, recording lifecycle events automatically
2. **/loop** periodically reads the data and surfaces problems proactively

This means you get both:
- Complete tracking of every tool call (hooks)
- Proactive alerts when something goes wrong (/loop)

**Example combined workflow:**

First, set up hooks in `.claude/settings.json` (see Part 1 above).

Then, at the start of a work session:
```text
/loop 3m check npx agent-heart for any stale or dead runs in my session and warn me. also tell me if any tool call took more than 30 seconds
```

### /loop Tips

- `/loop` tasks are session-scoped — they stop when you exit Claude Code
- Tasks auto-expire after 3 days
- Intervals use `s`, `m`, `h`, `d` units (seconds rounded up to nearest minute)
- Default interval is 10 minutes if you don't specify one
- Scheduled prompts fire between turns, not mid-response
- You can loop over other skills: `/loop 20m /some-other-skill`
- List active loops: "what scheduled tasks do I have?"
- Cancel a loop: "cancel the stale run watcher"
- Maximum 50 scheduled tasks per session

### One-Shot Reminders with agent-heart

For non-recurring checks:

```text
in 30 minutes, check agent-heart overview and tell me if the deploy service completed
```

```text
remind me at 3pm to check agent-heart for any dead runs from today's session
```

These create a single-fire task that runs once and deletes itself.

---

## Example: Full Claude Code + agent-heart Setup

**Step 1: Install and start agent-heart**
```bash
npx agent-heart init
npx agent-heart server start
```

**Step 2: Add hooks to `.claude/settings.json`**

Use the full hook config from Part 1 (all four hooks: SessionStart, PreToolUse,
PostToolUse, SessionEnd).

**Step 3: Start a Claude Code session and set up monitoring**

```text
/loop 3m check npx agent-heart status for stale or dead runs and alert me
```

**Step 4: Work normally — everything is tracked**

Every tool call (Bash commands, file reads/writes, grep, glob, agent spawns)
is automatically tracked. The /loop watches for problems in the background.

**Step 5: Review at session end**

```text
run npx agent-heart overview --json and summarize this session — what tools were used, how many succeeded/failed, and were there any issues?
```
