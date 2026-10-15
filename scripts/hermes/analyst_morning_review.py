#!/usr/bin/env python3
"""Hermes scheduler trigger; the Analyst's existing workflow owns the report."""
import json
import subprocess
import sys

try:
    result = subprocess.run(
        ["/Users/timsmith/.local/bin/node", "scripts/run_analyst_morning_review.cjs"],
        cwd="/Users/timsmith/Desktop/cursor/market-dashboard",
        capture_output=True, text=True, timeout=195, check=False,
    )
    output = json.loads(result.stdout)
    if output.get("status") != "skipped":
        print(json.dumps(output))
    sys.exit(result.returncode)
except (OSError, ValueError, subprocess.TimeoutExpired):
    print("Analyst morning review could not complete.", file=sys.stderr)
    sys.exit(1)
