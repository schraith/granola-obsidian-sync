---
name: granola-auth-recovery
description: Recover the Granola sync from authentication failures. Use when the sync reports 401 Unauthorized, "session has ended (refresh token rejected)", "Unsupported client", or "No usable Granola auth token found in any store". Contains the symptom-to-fix table and diagnostic commands for the token stores under ~/Library/Application Support/Granola/.
---

# Recovering from Granola auth failures

The sync fails loud with an **actionable Pushover/log message** that names the remedy. Map the symptom to the fix:

| Symptom (log / Pushover) | Cause | Fix |
| --- | --- | --- |
| `401 Unauthorized` or `session has ended (refresh token rejected)` | WorkOS session ended; no usable token in any store | **Sign out and back in to the Granola desktop app**, then re-run `bun sync.ts`. A fresh login rewrites `stored-accounts.json.enc` with a live `refresh_token`. |
| `"Unsupported client"` | `X-Client-Version` is stale (rare, since it's read dynamically) | **Update the Granola desktop app**, then re-run. |
| `No usable Granola auth token found in any store` | All stores empty/unreadable | Confirm Granola is installed and logged in, then re-run. |

Diagnostic commands:

```bash
# Are the token files fresh and non-empty? (tiny .enc ≈ empty accounts)
ls -lat ~/Library/Application\ Support/Granola/stored-accounts.json*
# Installed app version (compared against the dynamic X-Client-Version)
defaults read /Applications/Granola.app/Contents/Info.plist CFBundleShortVersionString
```

If re-login no longer repopulates `stored-accounts.json[.enc]` at all, Granola has moved the token store again (it now also keeps a copy in the SQLCipher-encrypted `granola.db`) — that requires a code change to the resolution chain in `sync.ts`, not a runbook step.
