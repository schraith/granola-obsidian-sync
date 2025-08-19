# Granola to Obsidian Sync

Simple tool for syncing Granola meeting notes to Obsidian. Single file, zero abstractions, fail-loud behavior.

## Setup

1. Clone the repository
```bash
git clone https://github.com/yourusername/granola-obsidian-sync.git
cd granola-obsidian-sync
```

2. Install dependencies
```bash
bun install
```

3. Configure environment
```bash
cp .env.example .env
# Edit .env with your paths and tokens
```

## Configuration

Edit `.env` with:
- `GRANOLA_AUTH_PATH`: Path to Granola's supabase.json auth file
- `OBSIDIAN_VAULT_MEETINGS_PATH`: Where to save meeting notes in your vault
- `CACHE_DIR_PATH`: Directory for cache files
- `PUSHOVER_USER_KEY` & `PUSHOVER_API_TOKEN`: Optional, for error notifications

## Running

### Manual
```bash
bun sync.ts
```

### Scheduled (macOS launchd)

Save this to `~/Library/LaunchAgents/com.user.granola-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.granola-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>/path/to/your/granola-obsidian-sync/sync.ts</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
    </array>
    <key>StandardOutPath</key>
    <string>/tmp/granola-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/granola-sync.error.log</string>
</dict>
</plist>
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/com.user.granola-sync.plist
```

### Scheduled (Linux cron)

Add to crontab with `crontab -e`:
```bash
*/30 * * * * /usr/local/bin/bun /path/to/granola-obsidian-sync/sync.ts >> /tmp/granola-sync.log 2>&1
```

## How It Works

1. Reads auth token from Granola app support directory
2. Fetches last 100 meetings from Granola API
3. Checks cache for upcoming meetings
4. Creates year/month folder structure in Obsidian vault
5. Generates filename: `YYYY-MM-DD HH-MM {title} -- {id}.md`
6. Skips if file already exists
7. Writes Markdown with YAML frontmatter

## Failure Behavior

- Fails immediately on any error (no retry logic)
- "0 meetings returned" = failure
- Exits with non-zero code on any error

Total: 1 file, ~100 lines, 1 dependency.