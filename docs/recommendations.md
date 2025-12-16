# Granola-Obsidian-Sync Recommendations
*Synthesized from Codex and Gemini analysis - 2025-08-25*

**IMPORTANT:** After a recommendation is completed, move it out of the "## Prioritized Fixes" section and move it into the "## Implemented Recommendations" section and add an "[Implmented: YYYY-MM-DD]" note.

## Prioritized Fixes

### 2. Pushover notification race condition [added: 2025-08-25]
- **Issue**: `sendPushover` not awaited in catch block
- **Impact**: Error notifications may never send when script crashes
- **Fix**: Make `sendPushover` async and await it in the catch block

### 3. Transcript content detection edge case [added: 2025-08-25]
- **Issue**: `hasContent` only recognizes array transcripts, skips string transcripts
- **Impact**: Valid meetings with string-only transcripts get skipped
- **Fix**: Update `hasContent` to accept non-empty string transcripts

### 4. Configurable timezone [added: 2025-08-25]
- **Issue**: Hardcoded to 'America/Los_Angeles'
- **Impact**: Tool unusable for users in other timezones
- **Fix**: Add TIMEZONE env variable (default to America/Los_Angeles)

### 5. Remove hardcoded bash path [added: 2025-08-25]
- **Issue**: Uses `/opt/homebrew/bin/bash` which is macOS-specific
- **Impact**: Breaks on non-macOS systems
- **Fix**: Use shell-based invocation to resolve from PATH

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

## Implemented Recommendations

### 6. Remove Slack cache files from git [added: 2025-08-25] 
- [IMPLEMENTED: 2025-08-25]
- **Issue**: `.channels_cache.json` and `.users_cache.json` were committed
- **Impact**: Added noise to repo
- **Fix**: Added to .gitignore and removed from tracking
- **Status**: ✅ Completed - Files removed from git and added to .gitignore

### 1. ~~Missing `run-sync.sh` wrapper script~~ [added: 2025-08-25]
- [IMPLEMENTED: 2025-08-25]
- **Issue**: Was referenced in docs but added unnecessary complexity
- **Impact**: None - plist calls bun directly with PATH configured
- **Fix**: Removed wrapper, updated docs to show direct bun invocation
- **Status**: ✅ Simplified - Removed wrapper for cleaner setup