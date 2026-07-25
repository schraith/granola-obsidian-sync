# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a simple tool for syncing Granola meeting notes to Obsidian. It fetches past meetings with transcripts from the Granola API and creates organized Markdown files in your Obsidian vault. The sync logic is split into two focused files: `sync.ts` for orchestration and `transcript-processor.ts` for transcript processing. Maintains zero abstractions, no retry logic, and fail-loud behavior.

IMPORTANT! All file and meeting operations occur in 'America/Los_Angeles' (Pacific US) time zone. ALWAYS use this time zone for date operations in this project - never use UTC for any user-visible information, files, folders, or metadata.

## Core Commands

```bash
# Run the sync
bun sync.ts
```

## Architecture

- Crashes immediately on any error (no retry logic)
- Skips existing files (no overwrite logic)

### File Organization
- Main directory: Keep clean with only essential files
- `/temp/`: All debug scripts, test files, and temporary utilities go here (git-tracked directory, all files inside are git-ignored except .gitkeep)
- `/logs/`: Sync operation logs (if logging is enabled)

## Authentication

### Supported public API (preferred)

When `GRANOLA_API_KEY` is set, the sync uses `https://public-api.granola.ai/v1` and does not read Granola desktop credentials. It cursor-paginates `GET /notes` in pages of up to 30, then calls `GET /notes/{note_id}?include=transcript` for each selected note. Requests are paced below the documented sustained limit and retry HTTP 429 responses.

Public note IDs (`not_...`) differ from the historical document UUIDs stored in Obsidian frontmatter. The sync extracts the document UUID from each note's `web_url` so existing notes remain deduplicated after migration.

### Legacy local-session fallback

As of May 2026, Granola migrated to an encrypted token store and also requires client-identification headers on every API call. The sync handles both:

### Required API headers (added May 2026)
Every Granola API request must include:
- `X-Client-Version: <Granola app version>` — checked against the installed app at `GRANOLA_CLIENT_VERSION` in `sync.ts`
- `X-Granola-Platform: darwin` — platform identifier

Without these headers the API returns `{"message":"Unsupported client"}` (HTTP 200), which was the root cause of `TypeError: {} is not iterable` errors.

### Token resolution order
`getTokenFromStoredAccounts()` tries sources in mtime order and **falls through to the next source if one yields no usable token** (not just on read/decrypt failure). This matters because newer Granola app versions (7.277.x) can write an empty `{"accounts":"[]"}` to `stored-accounts.json.enc` even while a valid account still lives in the plaintext file — returning early on the empty `.enc` would discard a working token. Sources, in preference order:

1. **`stored-accounts.json.enc`** (primary) — encrypted file kept up-to-date by the running Granola Electron app; decrypted with a DEK derived from the macOS Keychain (full decryption chain in `sync.ts`)
2. **`stored-accounts.json`** (plaintext fallback) — written by the app on login; may be stale between logins
3. **`supabase.json` / `GRANOLA_AUTH_PATH`** (legacy fallback) — old auth format from before WorkOS migration

If the access token from any source is expired (within 60 s of `exp`), `refreshWorkosToken()` exchanges the `refresh_token` via the WorkOS `/user_management/authenticate` endpoint and saves the new tokens to the plaintext `stored-accounts.json` for the next run.

### Client version
`X-Client-Version` is read **dynamically** at startup from the installed app's `Info.plist` (`getGranolaClientVersion()`), falling back to `GRANOLA_CLIENT_VERSION_FALLBACK` only if the app/plist can't be read. A stale version makes the API answer `{"message":"Unsupported client"}` at HTTP 200, which the sync now detects and reports explicitly. Keeping Granola updated keeps this header correct automatically — no manual bump needed.

### Recovery when auth fails
When the sync exits on an auth error, invoke the `granola-auth-recovery` skill for the symptom-to-fix table and diagnostic commands.

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

## Development Notes

- Uses Bun runtime (not Node.js)
- TypeScript with `.ts` extension imports allowed

## Documentation

- `/docs/recommendations.md` - Prioritized improvements and bug fixes with implementation dates
