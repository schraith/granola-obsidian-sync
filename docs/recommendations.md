# Granola-Obsidian-Sync Recommendations
*Synthesized from Codex and Gemini analysis - 2025-08-25*

## High Priority Fixes

### 1. Missing `run-sync.sh` wrapper script [added: 2025-08-25]
- **Issue**: Referenced in README and CLAUDE.md but doesn't exist
- **Impact**: Breaks scheduled execution setup
- **Fix**: Create the shell wrapper script with proper PATH setup for bun

### 2. Pushover notification race condition [added: 2025-08-25]
- **Issue**: `sendPushover` not awaited in catch block
- **Impact**: Error notifications may never send when script crashes
- **Fix**: Make `sendPushover` async and await it in the catch block

### 3. Transcript content detection edge case [added: 2025-08-25]
- **Issue**: `hasContent` only recognizes array transcripts, skips string transcripts
- **Impact**: Valid meetings with string-only transcripts get skipped
- **Fix**: Update `hasContent` to accept non-empty string transcripts

## Portability Improvements

### 4. Configurable timezone [added: 2025-08-25]
- **Issue**: Hardcoded to 'America/New_York'
- **Impact**: Tool unusable for users in other timezones
- **Fix**: Add TIMEZONE env variable (default to America/New_York)

### 5. Remove hardcoded bash path [added: 2025-08-25]
- **Issue**: Uses `/opt/homebrew/bin/bash` which is macOS-specific
- **Impact**: Breaks on non-macOS systems
- **Fix**: Use shell-based invocation to resolve from PATH

## Code Hygiene

### 6. Remove Slack cache files from git [added: 2025-08-25]
- **Issue**: `.channels_cache.json` and `.users_cache.json` are committed
- **Impact**: Adds noise to repo
- **Fix**: Add to .gitignore and remove from tracking

## Lower Priority Enhancements

### 7. Template priority configuration [added: 2025-08-25]
- Make panel template sorting configurable via env variable
- Current hardcoding works fine for single-user tool

### 8. Package.json naming consistency [added: 2025-08-25]
- Change name from "granola-sync" to "granola-obsidian-sync"
- Minor inconsistency, no functional impact

### 9. Optional improvements [added: 2025-08-25]
- Dry-run mode for safe testing
- Basic tests for transcript processing
- More defensive token parsing with clear error messages

## Implementation Priority
1. Items 1-3: Critical bug fixes
2. Items 4-5: Portability fixes  
3. Item 6: Cleanup
4. Items 7-9: Nice to have