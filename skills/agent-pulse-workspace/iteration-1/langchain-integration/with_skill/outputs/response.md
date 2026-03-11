# Adding agent-heart to a LangChain Agent

agent-heart tracks the full lifecycle of every tool call your LangChain agent makes -- start, progress, completion, failure, or disappearance -- so you can see exactly which calls are getting stuck.

## Step 1: Install and Start agent-heart

```bash
npm install -g agent-heart
agent-heart init
agent-heart server start
```

The server runs locally on `127.0.0.1:7778` (SQLite-backed). You can verify it is running with:

```bash
curl http://127.0.0.1:7778/api/v1/health
```

## Step 2: Create the Callback Handler

LangChain's callback system is the natural integration point. Create a file called `agent_pulse_callback.py` alongside your agent code:

```python
"""agent_pulse_callback.py -- LangChain callback handler for agent-heart."""

import subprocess
import time
from typing import Any, Dict, List, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler


class AgentPulseCallbackHandler(BaseCallbackHandler):
    """Track LangChain tool calls via agent-heart lifecycle events."""

    def __init__(self, service_prefix: str = "langchain", session_id: Optional[str] = None):
        self.service_prefix = service_prefix
        self.session_id = session_id or f"langchain-{int(time.time())}"
        self._active_runs: Dict[str, str] = {}  # run_id -> service_name

    def _pulse_cmd(self, args: List[str]) -> None:
        """Fire-and-forget agent-heart CLI call."""
        try:
            subprocess.run(
                ["agent-heart", "hook", "generic"] + args,
                capture_output=True,
                timeout=5,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        tool_name = serialized.get("name", "unknown")
        service = f"{self.service_prefix}/{tool_name}"
        self._active_runs[str(run_id)] = service

        self._pulse_cmd([
            "--action", "lock",
            "--service", service,
            "--tool", tool_name,
            "--session", self.session_id,
            "--command", input_str[:500],
            "--message", f"LangChain tool call: {tool_name}",
        ])

    def on_tool_end(
        self,
        output: str,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "0",
            "--message", "Tool completed successfully",
        ])

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "1",
            "--message", str(error)[:200],
        ])
```

### How this works

The handler hooks into three LangChain callback events:

- **`on_tool_start`** sends a `lock` event to agent-heart, recording which tool was invoked and what input it received. This is the moment the clock starts ticking.
- **`on_tool_end`** sends an `unlock` event with exit code 0, telling agent-heart the tool finished successfully.
- **`on_tool_error`** sends an `unlock` event with exit code 1 and the error message, so you can see what failed.

If a tool call starts (lock) but never finishes (no unlock), agent-heart will flag it as **stale** (stuck longer than expected) or **dead** (no heartbeat at all). That is exactly how you detect which tool calls are getting stuck.

## Step 3: Attach the Handler to Your Agent

Pass the handler as a callback when constructing both your LLM and your executor:

```python
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_tool_calling_agent
from agent_pulse_callback import AgentPulseCallbackHandler

# Create the handler
pulse_handler = AgentPulseCallbackHandler(
    service_prefix="langchain",
    session_id="my-session-001",
)

# Attach to LLM and executor
llm = ChatOpenAI(model="gpt-4o", callbacks=[pulse_handler])
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, callbacks=[pulse_handler])

# Run as normal -- tracking is automatic
result = executor.invoke({"input": "What PRs are open?"})
```

That is all the code changes you need. Every tool call your agent makes will now be tracked automatically.

## Step 4: Find Stuck Tool Calls

Once your agent has run, use the agent-heart CLI to inspect what happened:

```bash
# See an overview of all tracked services
agent-heart overview

# List all recent runs
agent-heart runs

# Filter to only your LangChain agent's runs
agent-heart runs --service langchain

# Find stuck tool calls (locked but never unlocked)
agent-heart runs --status stale

# Find silently failed calls (no heartbeat received)
agent-heart runs --status dead
```

- **stale** means the tool call started but has been running longer than expected (stuck).
- **dead** means no heartbeat was ever received after the lock -- the tool call silently disappeared.

Both of these are the signals you want for detecting which tool calls are getting stuck.

## Step 5: Tune Detection Thresholds

By default, agent-heart uses generous thresholds (5 minutes for stale, 10 minutes for dead). If your tools are expected to be fast, tighten these per service in `~/.agent-heart/config.json`:

```json
{
  "services": [
    {
      "name": "langchain/search",
      "expected_cycle_ms": 30000,
      "max_silence_ms": 60000
    },
    {
      "name": "langchain/database_query",
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

- `expected_cycle_ms` -- how long a tool call should take before it is flagged as stale.
- `max_silence_ms` -- how long without any heartbeat before it is flagged as dead.

Set shorter thresholds for tools you know should return quickly (search, simple lookups) and longer thresholds for tools that legitimately take time (database migrations, large file operations).

## Optional: Track Chains Too

The callback handler above only tracks tool calls. If you also want visibility into chain-level execution (to see which chain a stuck tool belongs to), add chain callbacks to the same handler file:

```python
    def on_chain_start(
        self,
        serialized: Dict[str, Any],
        inputs: Dict[str, Any],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        chain_name = serialized.get("name", serialized.get("id", ["unknown"])[-1])
        service = f"{self.service_prefix}/chain/{chain_name}"
        self._active_runs[str(run_id)] = service

        self._pulse_cmd([
            "--action", "lock",
            "--service", service,
            "--tool", chain_name,
            "--session", self.session_id,
            "--message", f"Chain started: {chain_name}",
        ])

    def on_chain_end(
        self,
        outputs: Dict[str, Any],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/chain/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "0",
        ])

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/chain/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "1",
            "--message", str(error)[:200],
        ])
```

## LangGraph Variant

If you are using LangGraph instead of (or in addition to) LangChain's AgentExecutor, attach the same callback handler at the graph invocation level:

```python
from langgraph.graph import StateGraph
from agent_pulse_callback import AgentPulseCallbackHandler

pulse = AgentPulseCallbackHandler(service_prefix="langgraph")

graph = StateGraph(MyState)
# ... build your graph ...
app = graph.compile()

result = app.invoke(initial_state, config={"callbacks": [pulse]})
```

## Summary

1. Install agent-heart and start its server.
2. Create `AgentPulseCallbackHandler` (the file above).
3. Pass it as a callback to your LLM and executor.
4. Run your agent as normal.
5. Use `agent-heart runs --status stale` and `agent-heart runs --status dead` to find stuck tool calls.
6. Optionally tune `expected_cycle_ms` and `max_silence_ms` per tool in the config to control how quickly stuck calls are flagged.
