#!/usr/bin/env bash
# Fixture for the scheduled-rebuild tests (issue #3): appends one job line
# to the queue file (argv 1) and prints queue.mjs-style numbers. The daemon
# treats this as a BLACK BOX — it never parses this output; the numbers only
# prove the command ran.
q="$1"
printf '{"job_id":"rb-added","payload":{"url":"https://example.com/rb","company":"RB","title":"Rebuilt","score":1}}\n' >> "$q"
echo "kept 3 already-done 1 quarantined 0"
