# AI Battery

Frameless Electron desktop widget for monitoring Codex weekly quota across multiple local `CODEX_HOME` profiles.

## Platform

Windows only for now.

The current app package is a Windows `.exe`, and the built-in login helper opens the Codex CLI through `cmd.exe`.

## What It Does

- Tracks weekly remaining quota for multiple Codex profiles in one floating desktop widget
- Auto-syncs ready accounts when the widget opens, then refreshes every 5 minutes
- Keeps unsynced or failed accounts empty instead of showing fake quota
- Supports per-profile setup with custom `CODEX_HOME` paths
- Automatically recovers the common default profile folders like `.codex`, `.codex-2`, and `.codex-3`
- Includes manual `Resync All` and per-account retry from Settings
- Lets you drag and reorder accounts from Settings

## Quick Start

1. Install the Codex CLI once on this machine:
   `npm install -g @openai/codex`
2. Clone the repo and install project dependencies:
   `git clone https://github.com/lchian96/ai-battery.git`
   `cd ai-battery`
   `npm install`
3. Start the widget:
   `npm start`
4. Open Settings in the widget.
5. For each account you want to use, set a `CODEX_HOME` path.
6. If that profile is not logged in yet, click `Open Login`, finish `codex login` in the terminal window, then return to the widget.
7. Click `Check Setup` once if needed.
8. Reopen the widget or click `Sync Now` to fetch live quota immediately.

Ready accounts now auto-sync whenever the widget opens, and then refresh again every 5 minutes.

## What `CODEX_HOME` Means

`CODEX_HOME` is the folder Codex uses to store the local login/session data for one account profile. Using a different `CODEX_HOME` path lets this widget track a different Codex account. Typical paths look like `C:\Users\<you>\.codex`, `C:\Users\<you>\.codex-2`, and `C:\Users\<you>\.codex-3`.

## Setup Flow

1. Install the Codex CLI globally.
2. Choose one `CODEX_HOME` folder per account.
3. Use `Open Login` if that profile has not been logged in yet.
4. Use `Check Setup` to confirm the profile folder and login state.
5. Let the widget auto-sync on open, or use `Sync Now` / `Resync All` for immediate refresh.

## Troubleshooting

- `Codex CLI not found`: run `npm install -g @openai/codex`
- `Needs login` or `Not logged in`: use `Open Login` for that `CODEX_HOME`
- `Sync failed`: retry with `Resync All` or `Sync Now`
- Wrong account label: the widget updates account names from each profile's real logged-in email on successful sync

## Development

1. Install dependencies:
   `npm install`
2. Start the desktop app:
   `npm start`
3. Build a packaged Windows executable:
   `npm run dist`

The packaged app is written to:
`dist/AI Battery-win32-x64/AI Battery.exe`

## Current Behavior

- Compact widget sized to the component with no outer window gutter
- Drag the widget body to move it
- Tap the compact header to expand or collapse it
- Optional `Always On Top` toggle in Settings
- `Resync All` button in Settings for manual retry across all configured accounts
- Account setup per profile using `CODEX_HOME`
- Live Codex quota sync through the Codex CLI app-server
- Configured and ready accounts auto-sync whenever the widget opens
- Unsynced accounts stay empty instead of showing fallback quota
- Weekly remaining quota shown in the bars and percentages

## Notes

- `Open Login` launches `codex login` for the selected `CODEX_HOME`.
- `Sync Now` is still available in Settings, but it is only for manual refresh or retry. Ready accounts now auto-sync on app open.
- `Always On Top` is stored locally in the widget and restored on launch.
- The compact shell intentionally follows the original zip design, but the settings flow is more advanced than the original sample because it supports real profile setup and sync.
