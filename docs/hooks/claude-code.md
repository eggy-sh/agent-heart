# Claude Code Hooks Integration

This guide explains how to use `agent-heart` with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) hooks to automatically track every tool call in an agent session.

## How Claude Code Hooks Work

Claude Code emits lifecycle events at four points during a session:

| Hook | When it fires | What you get |
|---|---|---|
| `SessionStart` | Agent session begins | Session metadata |
| `PreToolUse` | Before each tool call | Tool name, input parameters |
| `PostToolUse` | After each tool call | Tool name, output, duration |
| `SessionEnd` | Agent session ends | Session summary |

Hooks are configured in `.claude/settings.json` (project-level) or `~/.claude/settings.json` (user-level). Each hook runs a shell command and receives event data as JSON on stdin.

## Quick Setup

### 1. Start the server

```bash
npx agent-heart init
npx agent-heart server start
```

### 2. Add hooks to your Claude Code settings

Create or edit `.claude/settings.json` in your project root:

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

That is it. Every tool call in your Claude Code session will now be tracked by `agent-heart`.

## What Gets Tracked

### Session-Level Tracking

- `SessionStart` creates a `lock` on `claude-code/session` with the session ID
- `SessionEnd` sends an `unlock` to close the session
- If the session crashes without reaching `SessionEnd`, the monitor will mark it `stale` then `dead`

### Tool-Call Tracking

- `PreToolUse` creates a `lock` on `claude-code/<tool_name>` for each tool call
- `PostToolUse` sends an `unlock` with the tool result
- If a tool call hangs, the monitor will detect the missing heartbeat

### Example: What You See in Status

After a Claude Code session that read a file and ran a bash command:

```bash
$ npx agent-heart status

SERVICE                STATUS    RUNS  STALE  DEAD
claude-code/session    active       1      0     0
claude-code/Read       completed    1      0     0
claude-code/Bash       active       1      0     0
```

## How Hook Events Map to Lifecycle

| Claude Code Event | agent-heart Action | Service Name | Details |
|---|---|---|---|
| `SessionStart` | `lock` | `claude-code/session` | Creates session run |
| `PreToolUse` | `lock` | `claude-code/<tool_name>` | Creates tool-call run |
| `PostToolUse` | `unlock` | `claude-code/<tool_name>` | Completes tool-call run |
| `SessionEnd` | `unlock` | `claude-code/session` | Closes session run |

## Example: Session-Level Heartbeat Monitoring

For long-running sessions, you can add a heartbeat that fires on every tool call to keep the session marked as active:

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
            "command": "npx agent-heart hook claude-code --event pre-tool-use && npx agent-heart beat claude-code/session"
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

The `npx agent-heart beat claude-code/session` call in `PreToolUse` ensures the session stays marked `active` as long as the agent is making tool calls. If the agent goes silent (no tool calls for the configured `max_silence_ms`), the session will transition to `stale`.

## Privacy and Redaction

By default, `agent-heart` redacts sensitive values from tool call parameters before storing them. The following patterns are redacted:

- `password`, `secret`, `token`, `key`, `auth`, `credential`, `api_key`, `apikey`

This means if a tool call includes `--token ghp_abc123`, it will be stored as `--token [REDACTED]`.

### Configuring Redaction

Edit `~/.agent-heart/config.json`:

```json
{
  "redact": {
    "enabled": true,
    "patterns": [
      "password",
      "secret",
      "token",
      "key",
      "auth",
      "credential",
      "api_key",
      "apikey",
      "session_key",
      "private"
    ]
  }
}
```

### What Is Stored

For each tool call, `agent-heart` stores:

- Tool name (e.g., `Bash`, `Read`, `Write`)
- Redacted command/input summary
- Exit status (success/failure)
- Duration
- Session ID for correlation

It does **not** store:
- Full tool output/response content
- File contents read or written
- Raw API responses
- Unredacted secrets or tokens

### Disabling Tracking for Specific Tools

Use the `matcher` field in your hook config to control which tools are tracked:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|Read|Write|Grep|Glob)$",
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

This limits tracking to specific tool names only.

## Programmatic Integration

If you are building a tool or wrapper that integrates with Claude Code, you can use the TypeScript handlers directly:

```typescript
import {
  handleSessionStart,
  handlePreToolUse,
  handlePostToolUse,
  handleSessionEnd,
} from "agent-heart/hooks/claude-code";

// In your hook script, read stdin and pass to the handler
const input = await readStdin();
const data = JSON.parse(input);

await handlePreToolUse(data);
```

See [`src/hooks/claude-code.ts`](../src/hooks/claude-code.ts) for the full implementation.

## Troubleshooting

**Hook not firing**: Make sure `agent-heart` is available via `npx`. Test by running the hook command manually.

**Server not reachable**: Ensure `npx agent-heart server start` is running. Check that the port in your config matches (default: 7778).

**No data appearing**: Check `npx agent-heart status` after a session. If the server was not running when hooks fired, events are lost (fire-and-forget by default).

**Redaction too aggressive**: Adjust the `redact.patterns` array in your config. Patterns match against flag names and metadata keys, not values directly.
