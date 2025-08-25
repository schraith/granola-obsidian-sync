# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a simple tool for syncing Granola meeting notes to Obsidian. It fetches past meetings with transcripts from the Granola API and creates organized Markdown files in your Obsidian vault. The sync logic is split into two focused files: `sync.ts` for orchestration and `transcript-processor.ts` for transcript processing. Maintains zero abstractions, no retry logic, and fail-loud behavior.

IMPORTANT! All file and meeting operations occur in 'America/New York' (Eastern US) time zone. ALWAYS use this time zone for date operations in this project - never use UTC for any user-visible information, files, folders, or metadata.

## Core Commands

```bash
# Run the sync
bun sync.ts
```

## Architecture

### Two-File Design
- **sync.ts**: Orchestrates the sync - fetches data, writes files
- **transcript-processor.ts**: Processes transcripts - adds speaker labels (Me/Them), removes duplicates, groups by speaker
- Configuration via environment variables (see `.env.example`)
- Crashes immediately on any error (no retry logic)
- Skips existing files (no overwrite logic)

### Configuration
All paths and tokens are configured via environment variables in `.env`:
- **GRANOLA_AUTH_PATH**: Path to Granola's supabase.json auth file
- **OBSIDIAN_VAULT_MEETINGS_PATH**: Where meeting notes are saved in Obsidian
- **PUSHOVER_USER_KEY** & **PUSHOVER_API_TOKEN**: Optional error notifications
- **API Base**: `https://api.granola.ai/v1` (hardcoded as it's unlikely to change)

### File Organization
- Main directory: Keep clean with only essential files
- `/temp/`: All debug scripts, test files, and temporary utilities go here (git-tracked directory, all files inside are git-ignored except .gitkeep)
- `/logs/`: Sync operation logs (if logging is enabled)

## Sync Behavior

1. Reads auth token from Granola app support directory
2. Fetches past meetings from Granola API (configurable limit, default 50)
3. For each meeting with transcript:
   - Skips solo meetings and meetings without transcripts
   - Creates year/month folder structure in Obsidian vault
   - Generates filename: `YYYY-MM-DD HH-MM {title} -- {id}.md`
   - Skips if file already exists
   - **Processes transcript**: Adds speaker labels (Me/Them), removes duplicates, groups text by speaker
   - Creates Markdown with YAML frontmatter (status: filed)
   - Writes to Obsidian vault

## Failure Behavior 

- The Granola API is under active development with frequent breaking changes to the API endpoints, authentication, etc.
- The API should always return past meetings (even if they are all duplicates of meetings that have already been synced to Obsidian)
- "0 meetings returned" = failure
- The script should send a Pushover notification via the Pushover API (https://pushover.net/api) in case of error so that the script can be reviewed and updated

## Scheduled Execution

The sync can be scheduled via:
- **macOS**: launchctl with plist (see README for example)
- **Linux**: cron (see README for example)
- Both methods call bun directly with proper PATH configuration

## API Endpoints Used

- `POST /v1/get-documents` - Fetch meeting list
- `POST /v1/get-document-metadata` - Get meeting metadata
- `POST /v1/get-document-transcript` - Get meeting transcript

## Development Notes

- Uses Bun runtime (not Node.js)
- TypeScript with `.ts` extension imports allowed
- Dependencies: `gray-matter` (YAML frontmatter), `dotenv` (env vars)
- No build step - runs directly with `bun`

## Documentation

- `/docs/recommendations.md` - Prioritized improvements and bug fixes with implementation dates
- `CLAUDE.md` - This file, guidance for Claude Code (claude.ai/code)
- `GEMINI.md` - Guidance for Gemini CLI
- `AGENTS.md` - Guidance for OpenAI Codex CLI

## Setup for New Users

1. Clone repo
2. `bun install`
3. `cp .env.example .env`
4. Edit `.env` with your paths
5. `bun sync.ts`