# Cursor Usage

Track your Cursor API request usage from the VS Code/Cursor status bar.

## Features

- Auto-detects session token from Cursor's local database (no manual setup needed)
- Shows premium request usage (used/limit) in the status bar
- Shows extra charges from the monthly invoice
- Detailed per-model breakdown in tooltip
- Auto-refreshes every 15 minutes (configurable)
- Click status bar to manually refresh

## Installation

### Development Mode

1. Clone or copy this extension folder
2. Open the folder in Cursor
3. Press `F5` to run in development mode

### Production

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension cursor-usage-1.1.0.vsix
```

## Setup

### Automatic (recommended)

The extension auto-detects your session token from Cursor's local SQLite database. This requires `sqlite3` CLI to be available (pre-installed on macOS and most Linux distros).

No configuration needed -- just install and it works.

### Manual (fallback)

If auto-detection fails:

1. Open `cursor.com` in your browser
2. Open DevTools > Application > Cookies
3. Copy the `WorkosCursorSessionToken` value
4. Run command palette: `Cursor Usage: Set Session Token`
5. Paste the token value

## Usage

- **Status Bar**: Shows usage like `Cursor: 62/500` (requests used / limit)
- **Tooltip**: Hover for per-model breakdown and billing cycle info
- **Click Status Bar**: Refresh usage immediately
- **Extra Charges**: Shows overage costs if applicable (e.g., `Cursor: 62/500 | $13.12`)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cursorUsage.sessionToken` | (empty) | Session token. Leave empty for auto-detect. |
| `cursorUsage.autoDetectToken` | true | Auto-detect token from Cursor's local database. |
| `cursorUsage.refreshIntervalMinutes` | 15 | Auto-refresh interval in minutes. |

## Commands

| Command | Description |
|---------|-------------|
| `Cursor Usage: Set Session Token` | Manually set the session token |
| `Cursor Usage: Clear Session Token` | Clear saved token (revert to auto-detect) |
| `Cursor Usage: Refresh` | Manually refresh usage data |

## Troubleshooting

- **"No Token"**: Auto-detect failed and no manual token is set. Check that `sqlite3` is installed or set the token manually.
- **"Auth failed"**: Token expired. Clear the saved token to re-trigger auto-detect, or set a new one manually.
- **"Error"**: Hover over the status bar item to see the error details.
- **Auto-detect not working**: Ensure Cursor is installed and you've logged in at least once. Run `sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb "SELECT key FROM ItemTable WHERE key LIKE 'cursorAuth%'"` to verify the database has auth keys.

```
To get this exact JWT value from your browser, follow these steps:
Open cursor.com in your browser and ensure you are logged in.
Open the browser's Developer Tools (Right-click anywhere on the page -> Inspect, or press Cmd+Option+I on Mac).
Go to the Application tab (in Chrome/Edge) or Storage tab (in Firefox).
In the left sidebar, expand Cookies and click on https://cursor.com.
Find the cookie named WorkosCursorSessionToken.
Look at the Value column for that cookie.
The value you see will look something like this: user_01K7BWSY6BKPK3ARXFPDCQGHS5%3A%3AeyJhbGciOiJIUzI1NiIs...

The JWT value is everything after the %3A%3A (or :: if your browser decodes it).

So, you just copy the part that starts with eyJ all the way to the end.

(Note: If you are using the updated extension code I just provided, you can actually copy the entire value including the user_... part, and the extension will automatically extract the eyJ... part for you!)
```