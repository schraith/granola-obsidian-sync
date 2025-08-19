# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a simple tool for syncing Granola meeting notes to Obsidian. The entire sync logic is contained in a single `sync.ts` file with zero abstractions, no retry logic, and fail-loud behavior.

## Core Commands

```bash
# Run the sync
bun sync.ts

# Via shell wrapper (for launchctl)
./run-sync.sh
```

## Architecture

### Single File Design
- **sync.ts**: Contains all sync logic inline - no abstractions, no separate modules
- Configuration via environment variables (see `.env.example`)
- Crashes immediately on any error (no retry logic)
- Skips existing files (no overwrite logic)

### Configuration
All paths and tokens are configured via environment variables in `.env`:
- **GRANOLA_AUTH_PATH**: Path to Granola's supabase.json auth file
- **OBSIDIAN_VAULT_MEETINGS_PATH**: Where meeting notes are saved in Obsidian
- **CACHE_DIR_PATH**: Directory for cache files
- **PUSHOVER_USER_KEY** & **PUSHOVER_API_TOKEN**: Optional error notifications
- **API Base**: `https://api.granola.ai/v1` (hardcoded as it's unlikely to change)

### File Organization
- Main directory: Keep clean with only essential files
- `.cache/`: Cache files (git-ignored)
- `/temp/`: All debug scripts, test files, and temporary utilities go here
- `/logs/`: Sync operation logs (if logging is enabled)

## Sync Behavior

1. Reads auth token from Granola app support directory
2. Fetches last 100 meetings from Granola API
3. For each meeting:
   - Creates year/month folder structure in Obsidian vault
   - Generates filename: `YYYY-MM-DD HH-MM {title} -- {id}.md`
   - Skips if file already exists
   - Fetches metadata and transcript
   - Creates Markdown with YAML frontmatter
   - Writes to Obsidian vault

## Failure Behavior 

- The Granola API is under active development with frequent breaking changes to the API endpoints, authentication, etc.
- The API should always return past meetings (even if they are all duplicates of meetings that have already been synced to Obsidian)
- The cache should always return future meetings (even if they are all duplicates of meetings that have already been synced to Obsidian)
- "0 meetings returned" = failure
- The script should send a Pushover notification via the Pushover API (https://pushover.net/api) in case of error so that the script can be reviewed and updated

## Scheduled Execution

The sync can be scheduled via:
- **macOS**: launchctl with plist (see README for example)
- **Linux**: cron (see README for example)
- Wrapper script: `run-sync.sh` ensures correct PATH for bun

## API Endpoints Used

- `POST /v1/get-documents` - Fetch meeting list
- `POST /v1/get-document-metadata` - Get meeting metadata
- `POST /v1/get-document-transcript` - Get meeting transcript

## Development Notes

- Uses Bun runtime (not Node.js)
- TypeScript with `.ts` extension imports allowed
- Dependencies: `gray-matter` (YAML frontmatter), `dotenv` (env vars)
- No build step - runs directly with `bun`

## Setup for New Users

1. Clone repo
2. `bun install`
3. `cp .env.example .env`
4. Edit `.env` with your paths
5. `bun sync.ts`