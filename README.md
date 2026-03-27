# AI Battery

Frameless Electron desktop widget for monitoring Codex weekly quota across multiple local `CODEX_HOME` profiles.

## Platform

Source support is now set up for Windows and macOS.

- Windows packaging produces a `.exe`
- macOS packaging produces a `.app`
- `Open Login` opens the Codex CLI in `cmd.exe` on Windows and Terminal on macOS

The macOS code path is implemented, but the final UX still needs real-device verification on a Mac before calling it fully production-proven.

## What It Does

- Tracks weekly remaining quota for multiple Codex profiles in one floating desktop widget
- Auto-syncs ready accounts when the widget opens, then refreshes every 5 minutes
- Keeps unsynced or failed accounts empty instead of showing fake quota
- Supports dynamic account management: add, remove, and reorder accounts from Settings
- Supports per-profile setup with custom `CODEX_HOME` paths
- Automatically recovers the common default profile folders like `.codex`, `.codex-2`, `.codex-3`, and higher `.codex-N` suggestions as you add accounts
- Includes manual `Resync All` and per-account retry from Settings
- Lets you drag and reorder accounts from Settings
- Expands taller in Settings so account setup has more visible workspace

## Quick Start

1. Install the Codex CLI once on this machine:
   `npm install -g @openai/codex`
2. Clone the repo and install project dependencies:
   `git clone https://github.com/lchian96/ai-battery.git`
   `cd ai-battery`
   `npm install`
3. Start the widget on your current platform:
   `npm start`
4. Open Settings in the widget.
5. For each account you want to use, set a `CODEX_HOME` path.
6. If that profile is not logged in yet, click `Open Login`, finish `codex login` in the terminal window, then return to the widget.
7. Click `Check Setup` once if needed.
8. Reopen the widget or click `Sync Now` to fetch live quota immediately.

Ready accounts now auto-sync whenever the widget opens, and then refresh again every 5 minutes.

Important: AI Battery is tray-based. Closing or minimizing the window hides it instead of quitting. Reopen it from the tray icon, and use the tray menu to quit fully.

## What `CODEX_HOME` Means

`CODEX_HOME` is the folder Codex uses to store the local login/session data for one account profile. Using a different `CODEX_HOME` path lets this widget track a different Codex account. Typical paths look like `C:\Users\<you>\.codex`, `C:\Users\<you>\.codex-2`, and `C:\Users\<you>\.codex-3`.

## Setup Flow

1. Install the Codex CLI globally.
2. Choose one `CODEX_HOME` folder per account.
3. Use `Open Login` if that profile has not been logged in yet.
4. Use `Check Setup` to confirm the profile folder and login state.
5. Let the widget auto-sync on open, or use `Sync Now` / `Resync All` for immediate refresh.

You can start with the common default profiles (`.codex`, `.codex-2`, `.codex-3`) or add more accounts and point them at additional profile folders as needed.

## Troubleshooting

- `Codex CLI not found`: run `npm install -g @openai/codex`
- `Needs login` or `Not logged in`: use `Open Login` for that `CODEX_HOME`
- `Sync failed`: retry with `Resync All` or `Sync Now`
- Display name changed unexpectedly: successful setup checks and live syncs currently replace the visible account label with the profile's logged-in email

## Development

1. Install dependencies:
   `npm install`
2. Start the desktop app:
   `npm start`
3. Build a package for the current host platform:
   `npm run dist`
4. Build a Windows package explicitly:
   `npm run dist:win`
5. Build a macOS package explicitly:
   `npm run dist:mac`

Packaged output is written under `dist/`, for example:

- `dist/AI Battery-win32-x64/AI Battery.exe`
- `dist/AI Battery-darwin-*/AI Battery.app`

## Validation

Before pushing changes, at minimum:

1. Run syntax checks:
   `node --check main.js`
   `node --check preload.js`
   `node --check renderer.js`
2. Start the app:
   `npm start`
3. Verify the key flows manually:
   - open and collapse the widget
   - open Settings and confirm layout/scrolling
   - check `Always On Top` / `Launch On Startup`
   - run `Check Setup`, `Open Login`, `Sync Now`, and `Resync All`
   - confirm tray behavior and single-instance behavior on relaunch

## Current Behavior

- Compact widget sized to the component with no outer window gutter
- Drag the widget body to move it
- Tap the compact header to expand or collapse it
- Clicking outside the widget collapses it back to compact mode
- Optional `Always On Top` toggle in Settings
- Optional `Launch On Startup` toggle in Settings for Windows sign-in
- `Resync All` button in Settings for manual retry across all configured accounts
- Account setup per profile using `CODEX_HOME`
- Live Codex quota sync through the Codex CLI app-server
- Configured and ready accounts auto-sync whenever the widget opens
- Unsynced accounts stay empty instead of showing fallback quota
- Weekly remaining quota shown in the bars and percentages
- Tray-based behavior: close/minimize hide the window instead of quitting
- Single-instance guard: launching the app again should focus the existing widget instead of opening another copy

## Notes

- `Open Login` launches `codex login` for the selected `CODEX_HOME`.
- On macOS, `Open Login` uses Terminal via AppleScript and is intended to be run from a Mac environment.
- `Sync Now` is still available in Settings, but it is only for manual refresh or retry. Ready accounts now auto-sync on app open.
- `Always On Top` is stored locally in the widget and restored on launch.
- `Launch On Startup` registers the packaged Windows app to open when you sign in.
- `Launch On Startup` is currently Windows-only.
- The compact shell intentionally follows the original zip design, but the settings flow is more advanced than the original sample because it supports real profile setup and sync.
