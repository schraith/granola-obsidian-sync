#!/bin/bash

# Get current time in PST
TIMESTAMP=$(TZ="America/Los_Angeles" date "+%Y-%m-%d %H:%M:%S PST")

# Log start time
echo "[$TIMESTAMP] Starting granola-sync..." >> granola-sync.log
echo "[$TIMESTAMP] Starting granola-sync..." >> granola-sync.error.log

# Run the sync script and capture output with timestamps
/Users/kevinschraith/.bun/bin/bun /Users/kevinschraith/dev/granola-obsidian-sync/sync.ts 2>&1 | while IFS= read -r line; do
    echo "[$TIMESTAMP] $line"
done >> granola-sync.log 2>> granola-sync.error.log

# Log completion
END_TIMESTAMP=$(TZ="America/Los_Angeles" date "+%Y-%m-%d %H:%M:%S PST")
echo "[$END_TIMESTAMP] Sync completed" >> granola-sync.log
echo "----------------------------------------" >> granola-sync.log