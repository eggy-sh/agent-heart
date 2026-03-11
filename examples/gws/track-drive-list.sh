#!/usr/bin/env bash
# Example: Track a Google Drive file listing with automatic observability
#
# This wraps `gws drive files list` with automatic lifecycle tracking.
# agent-heart will:
#   1. Lock a run before the command starts
#   2. Send periodic heartbeats while it runs
#   3. Unlock the run when it finishes (with exit code, duration, and GWS metadata)
#
# Metadata is extracted automatically from the gws command structure:
#   service    -> gws-drive
#   resource   -> files
#   method     -> list
#   operation  -> read
#
# Prerequisites:
#   - agent-heart installed: npm install -g agent-heart
#   - agent-heart server running: agent-heart server start
#   - gws CLI installed and authenticated

set -euo pipefail

# Basic usage — wraps the command with full lifecycle tracking
agent-heart gws drive files list --params '{"pageSize": 50}'
