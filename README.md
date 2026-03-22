# pi-alert

A [pi](https://github.com/badlogic/pi-mono) extension that sends a system notification when the agent ends its turn.

## Install

```bash
pi install npm:pi-alert
```

Or from GitHub:

```bash
pi install git:github.com/maxpetretta/pi-alert
```

## Usage

Install the extension and notifications will fire automatically whenever the agent finishes responding to a prompt.

Notifications use the project root directory in the title (for example `pi — pi-alert`) and include an activity summary with elapsed time in the body.

Alert text prioritizes the most useful activity summary from the completed run:

- updated files
- other tool calls
- read files
- generic completion fallback

Notification delivery is terminal-first, with OS fallback:

- **Ghostty**, **WezTerm**, and **rxvt-unicode**: OSC 777 terminal notifications
- **iTerm2**: OSC 9 terminal notifications
- **Kitty**: OSC 99 terminal notifications
- **tmux**: supported via passthrough to supported outer terminals
- **macOS** fallback: `osascript` with a native notification and the `Glass` sound
- **Linux** fallback: `notify-send` from `libnotify`
- **Windows** fallback: PowerShell and a `System.Windows.Forms.NotifyIcon` balloon notification
- **Final fallback**: terminal bell (`BEL`) when no notification transport succeeds

## Platform support

| Platform | Terminal-native notifications | Fallback |
|---|---|---|
| macOS | Yes, in supported terminals such as Ghostty, iTerm2, WezTerm, Kitty, and rxvt-unicode | `osascript` |
| Linux | Yes, in supported terminals such as Ghostty, WezTerm, Kitty, and rxvt-unicode | `notify-send` |
| Windows | Not the primary path today | PowerShell balloon notification |

Terminal-native notifications require pi to be running inside a supported TTY terminal with the expected environment variables available. When running inside tmux, `pi-alert` attempts to detect the outer client terminal and forwards notifications through tmux passthrough when `allow-passthrough` is enabled. If tmux passthrough is unavailable or no supported terminal transport is detected, `pi-alert` falls back to the platform notification command, and finally to a terminal bell when no notification command succeeds.

### Linux notes

Most desktop Linux setups already have `notify-send`. If yours does not, install it with your distro package manager.

Examples:

```bash
sudo apt install libnotify-bin
sudo dnf install libnotify
sudo pacman -S libnotify
```

## Development

This package uses Bun for local development.

```bash
bun install
bun run lint
bun run typecheck
bun test
```

The test suite uses Bun's built-in test runner and covers the platform-specific notification command builders and escaping helpers.

## License

MIT
