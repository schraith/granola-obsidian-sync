# Migration Guide

Steps to set up this sync on a new machine.

## 1. Install prerequisites

- **Bun**: `curl -fsSL https://bun.sh/install | bash`
- **Granola** app (creates `~/Library/Application Support/Granola/supabase.json` on sign-in)
- **Obsidian** with your vault synced

## 2. Clone and set up

```bash
git clone <repo-url> ~/dev/granola-obsidian-sync
cd ~/dev/granola-obsidian-sync
bun install
cp .env.example .env
```

## 3. Update `.env`

- **`OBSIDIAN_VAULT_ROOT_PATH`** — update if your vault path differs
- **`GRANOLA_AUTH_PATH`** — uses `~` so should work as-is if Granola is installed
- **`PUSHOVER_USER_KEY`** and **`PUSHOVER_API_TOKEN`** — copy from current `.env`
- **`OWNER_EMAILS`** — copy from current `.env`
- **`VAULT_OPS_SCRIPT_PATH`** — update if you enable meeting processing

## 4. Reinstall the LaunchAgent

Copy `com.user.granola-sync.plist` to `~/Library/LaunchAgents/`. If your macOS username changes, update these hardcoded paths in the plist:

- `ProgramArguments` — path to `run-sync-with-timestamp.sh`
- `WorkingDirectory` — path to the repo
- `PATH` env var — path to `.bun/bin`

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.user.granola-sync.plist
```

## 5. Test

```bash
bun sync.ts
```

If your macOS username and repo path stay the same, the only steps are: install Bun, clone, `bun install`, copy `.env`, copy the plist, and load it. Granola creates a fresh auth token when you sign in.
