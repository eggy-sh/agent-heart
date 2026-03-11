#!/usr/bin/env bash
# Example: Track a kubectl command with agent-heart
#
# This wraps `kubectl get pods` with automatic lifecycle tracking.
# agent-heart will:
#   1. Lock a run before the command starts
#   2. Send periodic heartbeats while it runs
#   3. Unlock the run when it finishes (with exit code and duration)
#
# If the command hangs (e.g., waiting for API server), agent-heart
# will detect the missing heartbeat and mark the run as stale, then dead.
#
# Prerequisites:
#   - agent-heart installed: npm install -g agent-heart
#   - agent-heart server running: agent-heart server start
#   - kubectl installed and configured

set -euo pipefail

# Basic usage — wraps the command with full lifecycle tracking
agent-heart exec \
  --service k8s \
  --tool kubectl \
  --resource pods \
  -- kubectl get pods -n default

# With additional metadata for a specific operation
# agent-heart exec \
#   --service k8s \
#   --tool kubectl \
#   --resource deployments \
#   --session "deploy-session-001" \
#   --meta cluster=production \
#   --meta namespace=default \
#   -- kubectl rollout status deployment/my-app -n default

# Tracking a potentially long-running operation with a shorter heartbeat interval
# agent-heart exec \
#   --service k8s \
#   --tool kubectl \
#   --resource pods \
#   --heartbeat-interval 5000 \
#   -- kubectl logs -f deployment/my-app -n default --since=1h
