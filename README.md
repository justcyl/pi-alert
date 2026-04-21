# pi-alert

A [pi](https://github.com/badlogic/pi-mono) extension that sends a macOS notification when the agent ends its turn.

## Install

```bash
pi install ./pi-alert
```

Or from GitHub after you publish your fork:

```bash
pi install git:github.com/<your-name>/pi-alert
```

## Usage

Install the extension and notifications will fire automatically whenever the agent finishes responding to a prompt.

Notifications use the project root directory in the title (for example `pi — pi-alert`) and include an activity summary with elapsed time in the body.

Alert text prioritizes the most useful activity summary from the completed run:

- updated files
- other tool calls
- read files
- generic completion fallback

Notification delivery directly uses the macOS fallback: `osascript` with a native notification and the `Glass` sound.

If the macOS notification command cannot be executed, `pi-alert` falls back to a terminal bell (`BEL`).

## Platform support

| Platform | Notification command |
|---|---|
| macOS | `osascript` |

This fork intentionally does not use terminal-native notification protocols. It always attempts the macOS notification path first.

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
