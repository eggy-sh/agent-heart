# Adding agent-heart to a LangChain Agent

## Overview

agent-heart gives you CLI-first observability for AI agent tool calls. It tracks each tool invocation through a lifecycle of **lock** (start), **beat** (heartbeat), and **unlock** (finish), and can automatically detect **stale** (stuck) and **dead** (silently failed) runs. Below is a step-by-step guide to wiring it into a LangChain agent.

---

## 1. Install agent-heart

```bash
npm install -g agent-heart
```

This gives you access to the `agent-heart` CLI, the HTTP API (when you run the daemon/server), and the TypeScript SDK you can import directly into your code.

---

## 2. Start the agent-heart server

Before your agent runs, start the agent-heart background process so it can receive lifecycle events:

```bash
agent-heart start
```

By default this starts an HTTP API on a local port (check `agent-heart --help` for configuration options like port selection). Keep this running in a separate terminal or as a background service.

---

## 3. Instrument your LangChain tool calls

The core idea is to wrap each tool invocation with three lifecycle calls:

| Lifecycle Event | Meaning | When to Call |
|---|---|---|
| **lock** | A tool call has started | Immediately before the tool executes |
| **beat** | The tool call is still alive | Periodically during long-running tools |
| **unlock** | The tool call has finished | Immediately after the tool returns (success or failure) |

### Option A: Using the TypeScript SDK (recommended)

If your LangChain agent is written in TypeScript/JavaScript, import the SDK directly:

```typescript
import { AgentPulse } from "agent-heart";

const pulse = new AgentPulse();

// Example: wrapping a LangChain tool call
async function instrumentedToolCall(toolName: string, toolFn: () => Promise<any>) {
  const runId = `${toolName}-${Date.now()}`;

  // Signal that this tool call is starting
  await pulse.lock(runId, { tool: toolName });

  try {
    const result = await toolFn();

    // Signal successful completion
    await pulse.unlock(runId, { status: "success" });

    return result;
  } catch (error) {
    // Signal failure — without this, agent-heart would eventually flag the run as "dead"
    await pulse.unlock(runId, { status: "error", error: String(error) });
    throw error;
  }
}
```

### Option B: Using the HTTP API

If you prefer language-agnostic integration or your agent calls tools from Python, you can hit the HTTP API directly:

```python
import requests
import time

AGENT_PULSE_URL = "http://localhost:4040"  # adjust port as needed

def lock(run_id: str, tool_name: str):
    requests.post(f"{AGENT_PULSE_URL}/lock", json={"runId": run_id, "tool": tool_name})

def beat(run_id: str):
    requests.post(f"{AGENT_PULSE_URL}/beat", json={"runId": run_id})

def unlock(run_id: str, status: str = "success"):
    requests.post(f"{AGENT_PULSE_URL}/unlock", json={"runId": run_id, "status": status})
```

### Option C: Using the CLI

For quick testing or shell-based agents, use the CLI directly:

```bash
agent-heart lock --run-id "search-1234" --tool "web_search"
# ... tool executes ...
agent-heart unlock --run-id "search-1234" --status success
```

---

## 4. Integrate with LangChain callbacks

LangChain provides a callback system that fires events on tool start and tool end. This is the cleanest integration point. Create a custom callback handler:

```typescript
import { BaseCallbackHandler } from "langchain/callbacks";
import { AgentPulse } from "agent-heart";

const pulse = new AgentPulse();

class AgentPulseCallbackHandler extends BaseCallbackHandler {
  name = "agent-heart-handler";

  async handleToolStart(
    tool: { name: string },
    input: string,
    runId: string
  ): Promise<void> {
    await pulse.lock(runId, { tool: tool.name, input });
  }

  async handleToolEnd(output: string, runId: string): Promise<void> {
    await pulse.unlock(runId, { status: "success" });
  }

  async handleToolError(error: Error, runId: string): Promise<void> {
    await pulse.unlock(runId, { status: "error", error: error.message });
  }
}
```

Then attach it to your agent:

```typescript
import { initializeAgentExecutorWithTools } from "langchain/agents";

const agent = await initializeAgentExecutorWithTools(tools, llm, {
  agentType: "chat-conversational-react-description",
  callbacks: [new AgentPulseCallbackHandler()],
});

const result = await agent.invoke({ input: "your prompt here" });
```

With this approach, every tool call your LangChain agent makes will automatically be tracked through the full lock/unlock lifecycle without modifying individual tool implementations.

---

## 5. Add heartbeats for long-running tools

If any of your tools take a long time (e.g., web scraping, database queries, API calls with retries), add periodic heartbeats so agent-heart can distinguish "still working" from "stuck":

```typescript
async function longRunningToolWithHeartbeat(runId: string, toolFn: () => Promise<any>) {
  const heartbeatInterval = setInterval(async () => {
    await pulse.beat(runId);
  }, 5000); // beat every 5 seconds

  try {
    return await toolFn();
  } finally {
    clearInterval(heartbeatInterval);
  }
}
```

Without heartbeats, agent-heart will flag a long-running tool as **stale** after its configured timeout.

---

## 6. Monitor stuck and dead tool calls

Once your agent is running with instrumentation, use the CLI to monitor:

```bash
# View all active (locked) tool calls
agent-heart status

# View tool calls that have gone stale (no heartbeat, not unlocked)
agent-heart stale

# View tool calls flagged as dead (silent failures)
agent-heart dead

# Watch tool call activity in real time
agent-heart watch
```

---

## Summary

| Step | Action |
|---|---|
| Install | `npm install -g agent-heart` |
| Start server | `agent-heart start` |
| Instrument | Use LangChain callbacks to call `lock` on tool start and `unlock` on tool end/error |
| Heartbeat | Call `beat` periodically for long-running tools |
| Monitor | Use `agent-heart status`, `agent-heart stale`, `agent-heart dead` to find stuck calls |

The LangChain callback approach is the least-invasive integration path: you write one callback handler and every tool in your agent is automatically tracked. From there, agent-heart handles detection of stale and dead runs so you can quickly identify which tool calls are getting stuck.
