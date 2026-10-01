#!/usr/bin/env bash
# Fixture for the scheduled-rebuild overlap test (issue #3): bumps a
# counter file (argv 1) once per invocation, then sleeps long enough that
# several poll ticks pass WHILE the command is in flight — the daemon's
# one-rebuild-per-project guard must keep the counter at 1.
c="$1"
printf 'x' >> "$c"
sleep 1.5
