#!/usr/bin/env python3
"""Hermes schedule adapter; the dashboard verifies and stores closing holdings."""
import json
import subprocess
import sys

try:
    result = subprocess.run(
        ["/Users/timsmith/.local/bin/node", "scripts/run_analyst_portfolio_close.cjs"],
        cwd="/Users/timsmith/Desktop/cursor/market-dashboard",
        capture_output=True, text=True, timeout=195, check=False,
    )
    output = json.loads(result.stdout)
    if output.get("status") not in {"scheduled", "skipped"}:
        print(json.dumps(output))
    sys.exit(result.returncode)
except (OSError, ValueError, subprocess.TimeoutExpired):
    print("Analyst closing holdings capture could not complete.", file=sys.stderr)
    sys.exit(1)
