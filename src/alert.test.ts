import { describe, expect, test } from "bun:test"
import {
  buildAlertMessage,
  buildAlertTitle,
  buildNotificationCommands,
  escapeAppleScriptString,
  formatDuration,
  mergeAlertSummaries,
  sendTerminalBell,
  summarizeAgentEndMessages,
} from "./alert"

describe("terminal bell fallback", () => {
  test("rings the terminal bell as a last-resort fallback", () => {
    const writes: string[] = []
    const writer = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(sendTerminalBell(writer)).toBeTrue()
    expect(writes).toEqual(["\x07"])
  })

  test("does not ring the terminal bell when stdout is not a tty", () => {
    const writes: string[] = []
    const writer = {
      isTTY: false,
      write(chunk: string) {
        writes.push(chunk)
      },
    }

    expect(sendTerminalBell(writer)).toBeFalse()
    expect(writes).toEqual([])
  })
})

describe("escapeAppleScriptString", () => {
  test("escapes backslashes and double quotes", () => {
    expect(escapeAppleScriptString('say "hi" \\ now')).toBe('say \\"hi\\" \\\\ now')
  })
})

describe("buildAlertTitle", () => {
  test("formats the title with the project root directory name", () => {
    expect(buildAlertTitle("/Users/max/dev/pi-alert")).toBe("pi — pi-alert")
    expect(buildAlertTitle("/Users/max/dev/pi-alert/")).toBe("pi — pi-alert")
    expect(buildAlertTitle(undefined)).toBe("pi")
  })
})

describe("formatDuration", () => {
  test("formats milliseconds, seconds, minutes, and hours", () => {
    expect(formatDuration(850)).toBe("850ms")
    expect(formatDuration(1_250)).toBe("1s")
    expect(formatDuration(14_900)).toBe("14s")
    expect(formatDuration(65_000)).toBe("1m 5s")
    expect(formatDuration(3_600_000)).toBe("1h 0m")
    expect(formatDuration(3_990_000)).toBe("1h 6m")
  })
})

describe("buildAlertMessage", () => {
  test("prioritizes updated files over every other activity", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 1_250,
        writeCount: 2,
        writtenPaths: ["src/alert.ts"],
        readCount: 4,
        readPaths: ["README.md", "package.json"],
        otherToolCalls: ["bash", "grep"],
      }),
    ).toBe("Updated 1 file in 1s")
  })

  test("summarizes other tool calls when nothing was written", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 4_200,
        writeCount: 0,
        writtenPaths: [],
        readCount: 2,
        readPaths: ["README.md"],
        otherToolCalls: ["bash", "grep", "bash"],
      }),
    ).toBe("Ran 3 tool calls (bash, grep) in 4s")
  })

  test("summarizes read activity when it is the highest priority action", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 800,
        writeCount: 0,
        writtenPaths: [],
        readCount: 2,
        readPaths: ["README.md", "package.json"],
        otherToolCalls: [],
      }),
    ).toBe("Read 2 files in 800ms")
  })

  test("falls back to a generic completion message", () => {
    expect(
      buildAlertMessage({
        elapsedMs: 950,
        writeCount: 0,
        writtenPaths: [],
        readCount: 0,
        readPaths: [],
        otherToolCalls: [],
      }),
    ).toBe("Finished in 950ms")
  })
})

describe("summarizeAgentEndMessages", () => {
  test("counts successful tool results by priority bucket", () => {
    const summary = summarizeAgentEndMessages([
      { role: "toolResult", toolCallId: "1", toolName: "read", content: [], isError: false, timestamp: 1 },
      { role: "toolResult", toolCallId: "2", toolName: "edit", content: [], isError: false, timestamp: 2 },
      { role: "toolResult", toolCallId: "3", toolName: "bash", content: [], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "4", toolName: "write", content: [], isError: true, timestamp: 4 },
    ])

    expect(summary).toEqual({
      elapsedMs: null,
      writeCount: 1,
      writtenPaths: [],
      readCount: 1,
      readPaths: [],
      otherToolCalls: ["bash"],
    })
  })
})

describe("mergeAlertSummaries", () => {
  test("uses fallback counts only when live data is missing", () => {
    expect(
      mergeAlertSummaries(
        {
          elapsedMs: 1_500,
          writeCount: 1,
          writtenPaths: ["src/alert.ts"],
          readCount: 0,
          readPaths: [],
          otherToolCalls: [],
        },
        {
          elapsedMs: null,
          writeCount: 2,
          writtenPaths: [],
          readCount: 3,
          readPaths: [],
          otherToolCalls: ["bash"],
        },
      ),
    ).toEqual({
      elapsedMs: 1_500,
      writeCount: 1,
      writtenPaths: ["src/alert.ts"],
      readCount: 3,
      readPaths: [],
      otherToolCalls: ["bash"],
    })
  })
})

describe("buildNotificationCommands", () => {
  test("builds a macOS notification command", () => {
    expect(buildNotificationCommands("darwin", "pi", 'hello "world"')).toEqual([
      {
        command: "osascript",
        args: ["-e", 'display notification "hello \\"world\\"" with title "pi" sound name "Glass"'],
      },
    ])
  })

  test("returns no commands for non-macOS platforms", () => {
    expect(buildNotificationCommands("linux", "pi", "done")).toEqual([])
    expect(buildNotificationCommands("win32", "pi", "done")).toEqual([])
    expect(buildNotificationCommands("aix", "pi", "done")).toEqual([])
  })
})
