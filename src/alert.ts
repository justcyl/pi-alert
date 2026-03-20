import { platform } from "node:os"
import type { AgentEndEvent, ExtensionAPI } from "@mariozechner/pi-coding-agent"

const TITLE = "pi"
const FALLBACK_MESSAGE = "Agent finished its turn"
const NOTIFICATION_TIMEOUT_MS = 5_000

export type NotificationCommand = {
  command: string
  args: string[]
}

export type TerminalNotificationTransport = "osc777" | "osc99"

export type TerminalWriter = {
  isTTY?: boolean
  write(chunk: string): unknown
}

export type AlertSummaryInput = {
  elapsedMs: number | null
  writeCount: number
  writtenPaths: string[]
  readCount: number
  readPaths: string[]
  otherToolCalls: string[]
}

type PendingToolCall = {
  toolName: string
  path: string | null
}

type AlertRunState = {
  startedAt: number
  pendingToolCalls: Map<string, PendingToolCall>
  writeCount: number
  writtenPaths: Set<string>
  readCount: number
  readPaths: Set<string>
  otherToolCalls: string[]
}

export default function alertExtension(pi: ExtensionAPI) {
  let currentRun: AlertRunState | null = null

  pi.on("agent_start", () => {
    currentRun = createRunState(Date.now())
  })

  pi.on("tool_execution_start", (event) => {
    if (!currentRun) {
      return
    }

    currentRun.pendingToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      path: getPathArg(event.args),
    })
  })

  pi.on("tool_execution_end", (event) => {
    if (!currentRun) {
      return
    }

    const pendingToolCall = currentRun.pendingToolCalls.get(event.toolCallId)
    currentRun.pendingToolCalls.delete(event.toolCallId)

    if (event.isError) {
      return
    }

    recordCompletedToolExecution(currentRun, pendingToolCall?.toolName ?? event.toolName, pendingToolCall?.path ?? null)
  })

  pi.on("agent_end", async (event) => {
    const liveSummary = snapshotRunState(currentRun)
    const fallbackSummary = summarizeAgentEndMessages(event.messages)
    const message = buildAlertMessage(mergeAlertSummaries(liveSummary, fallbackSummary))

    currentRun = null
    await notifyBestAvailable(pi, TITLE, message)
  })
}

function createRunState(startedAt: number): AlertRunState {
  return {
    startedAt,
    pendingToolCalls: new Map<string, PendingToolCall>(),
    writeCount: 0,
    writtenPaths: new Set<string>(),
    readCount: 0,
    readPaths: new Set<string>(),
    otherToolCalls: [],
  }
}

function snapshotRunState(run: AlertRunState | null): AlertSummaryInput {
  return {
    elapsedMs: run ? Math.max(0, Date.now() - run.startedAt) : null,
    writeCount: run?.writeCount ?? 0,
    writtenPaths: run ? [...run.writtenPaths] : [],
    readCount: run?.readCount ?? 0,
    readPaths: run ? [...run.readPaths] : [],
    otherToolCalls: run ? [...run.otherToolCalls] : [],
  }
}

function recordCompletedToolExecution(run: AlertRunState, toolName: string, path: string | null): void {
  switch (toolName) {
    case "write":
    case "edit":
      run.writeCount += 1
      if (path) {
        run.writtenPaths.add(path)
      }
      return

    case "read":
      run.readCount += 1
      if (path) {
        run.readPaths.add(path)
      }
      return

    default:
      run.otherToolCalls.push(toolName)
      return
  }
}

export function summarizeAgentEndMessages(messages: AgentEndEvent["messages"]): AlertSummaryInput {
  const summary: AlertSummaryInput = {
    elapsedMs: null,
    writeCount: 0,
    writtenPaths: [],
    readCount: 0,
    readPaths: [],
    otherToolCalls: [],
  }

  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError) {
      continue
    }

    switch (message.toolName) {
      case "write":
      case "edit":
        summary.writeCount += 1
        break

      case "read":
        summary.readCount += 1
        break

      default:
        summary.otherToolCalls.push(message.toolName)
        break
    }
  }

  return summary
}

export function mergeAlertSummaries(primary: AlertSummaryInput, fallback: AlertSummaryInput): AlertSummaryInput {
  const hasPrimaryWrites = primary.writeCount > 0 || primary.writtenPaths.length > 0
  const hasPrimaryReads = primary.readCount > 0 || primary.readPaths.length > 0

  return {
    elapsedMs: primary.elapsedMs ?? fallback.elapsedMs,
    writeCount: hasPrimaryWrites ? primary.writeCount : fallback.writeCount,
    writtenPaths: hasPrimaryWrites ? primary.writtenPaths : fallback.writtenPaths,
    readCount: hasPrimaryReads ? primary.readCount : fallback.readCount,
    readPaths: hasPrimaryReads ? primary.readPaths : fallback.readPaths,
    otherToolCalls: primary.otherToolCalls.length > 0 ? primary.otherToolCalls : fallback.otherToolCalls,
  }
}

async function notifyBestAvailable(pi: ExtensionAPI, title: string, message: string): Promise<void> {
  if (sendTerminalNotification(title, message)) {
    return
  }

  await notifyCurrentPlatform(pi, title, message)
}

export function sendTerminalNotification(
  title: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  writer: TerminalWriter = process.stdout,
): boolean {
  const transport = detectTerminalNotificationTransport(env, writer.isTTY === true)
  if (!transport) {
    return false
  }

  const sequences = buildTerminalNotificationSequences(transport, title, message)
  for (const sequence of sequences) {
    writer.write(sequence)
  }

  return true
}

export function detectTerminalNotificationTransport(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): TerminalNotificationTransport | null {
  if (!isTTY) {
    return null
  }

  if (env.KITTY_WINDOW_ID) {
    return "osc99"
  }

  const termProgram = env.TERM_PROGRAM?.toLowerCase()
  if (termProgram === "ghostty" || termProgram === "iterm.app" || termProgram === "wezterm") {
    return "osc777"
  }

  const term = env.TERM?.toLowerCase() ?? ""
  if (term.includes("rxvt")) {
    return "osc777"
  }

  return null
}

export function buildTerminalNotificationSequences(
  transport: TerminalNotificationTransport,
  title: string,
  message: string,
): string[] {
  const safeTitle = sanitizeTerminalNotificationText(title)
  const safeMessage = sanitizeTerminalNotificationText(message)

  switch (transport) {
    case "osc777":
      return [buildOsc777Sequence(safeTitle, safeMessage)]

    case "osc99":
      return buildOsc99Sequences(safeTitle, safeMessage)
  }
}

export function buildOsc777Sequence(title: string, message: string): string {
  return `\x1b]777;notify;${title};${message}\x07`
}

export function buildOsc99Sequences(title: string, message: string): [string, string] {
  return [`\x1b]99;i=1:d=0;${title}\x1b\\`, `\x1b]99;i=1:p=body;${message}\x1b\\`]
}

export function sanitizeTerminalNotificationText(value: string): string {
  return value.replaceAll(/[\u0000-\u001f\u007f]+/g, " ").trim()
}

async function notifyCurrentPlatform(pi: ExtensionAPI, title: string, message: string): Promise<void> {
  const commands = buildNotificationCommands(platform(), title, message)
  await execFirstAvailable(pi, commands)
}

export function buildNotificationCommands(
  targetPlatform: NodeJS.Platform,
  title: string,
  message: string,
): NotificationCommand[] {
  switch (targetPlatform) {
    case "darwin":
      return [
        {
          command: "osascript",
          args: [
            "-e",
            `display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`,
          ],
        },
      ]

    case "linux":
      return [
        {
          command: "notify-send",
          args: ["--app-name=pi", `--expire-time=${NOTIFICATION_TIMEOUT_MS}`, title, message],
        },
      ]

    case "win32":
      return [
        {
          command: "powershell",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            buildWindowsNotificationScript(title, message),
          ],
        },
        {
          command: "pwsh",
          args: ["-NoProfile", "-NonInteractive", "-Command", buildWindowsNotificationScript(title, message)],
        },
      ]

    default:
      return []
  }
}

async function execFirstAvailable(pi: ExtensionAPI, commands: NotificationCommand[]): Promise<void> {
  for (const command of commands) {
    if (await tryCommand(pi, command)) {
      return
    }
  }
}

async function tryCommand(pi: ExtensionAPI, command: NotificationCommand): Promise<boolean> {
  try {
    const result = await pi.exec(command.command, command.args, { timeout: NOTIFICATION_TIMEOUT_MS })
    return result.code === 0
  } catch {
    return false
  }
}

function getPathArg(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null
  }

  const path = "path" in args ? args.path : undefined
  if (typeof path !== "string") {
    return null
  }

  return normalizeToolPath(path)
}

function normalizeToolPath(path: string): string | null {
  const normalizedPath = path.trim().replace(/^@/, "")
  return normalizedPath ? normalizedPath : null
}

export function buildAlertMessage(summary: AlertSummaryInput): string {
  const durationSuffix = summary.elapsedMs === null ? "" : ` in ${formatDuration(summary.elapsedMs)}`
  const writeFileCount = summary.writtenPaths.length > 0 ? summary.writtenPaths.length : summary.writeCount
  const readFileCount = summary.readPaths.length > 0 ? summary.readPaths.length : summary.readCount

  if (writeFileCount > 0) {
    return `${describeFileActivity("Updated", writeFileCount)}${durationSuffix}`
  }

  if (summary.otherToolCalls.length > 0) {
    return `${describeOtherToolActivity(summary.otherToolCalls)}${durationSuffix}`
  }

  if (readFileCount > 0) {
    return `${describeFileActivity("Read", readFileCount)}${durationSuffix}`
  }

  return durationSuffix ? `Finished${durationSuffix}` : FALLBACK_MESSAGE
}

function describeFileActivity(verb: string, count: number): string {
  return `${verb} ${count} ${count === 1 ? "file" : "files"}`
}

function describeOtherToolActivity(toolCalls: string[]): string {
  const formattedToolCalls = toolCalls.map(formatToolName)
  const uniqueToolCalls = [...new Set(formattedToolCalls)]

  if (toolCalls.length === 1) {
    return `Ran ${uniqueToolCalls[0]}`
  }

  if (uniqueToolCalls.length === 1) {
    return `Ran ${toolCalls.length} ${uniqueToolCalls[0]} calls`
  }

  const preview = uniqueToolCalls.slice(0, 2).join(", ")
  const overflow = uniqueToolCalls.length > 2 ? ", ..." : ""
  return `Ran ${toolCalls.length} tool calls (${preview}${overflow})`
}

function formatToolName(toolName: string): string {
  return toolName.replaceAll(/[-_]+/g, " ")
}

export function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`
  }

  const seconds = elapsedMs / 1_000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }

  const totalMinutes = Math.floor(seconds / 60)
  if (totalMinutes < 60) {
    const remainingSeconds = Math.round(seconds % 60)
    return `${totalMinutes}m ${remainingSeconds}s`
  }

  const hours = Math.floor(totalMinutes / 60)
  const remainingMinutes = totalMinutes % 60
  return `${hours}h ${remainingMinutes}m`
}

export function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

export function escapePowerShellString(value: string): string {
  return value.replaceAll("'", "''")
}

export function buildWindowsNotificationScript(title: string, message: string): string {
  const escapedTitle = escapePowerShellString(title)
  const escapedMessage = escapePowerShellString(message)

  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$notification = New-Object System.Windows.Forms.NotifyIcon",
    "$notification.Icon = [System.Drawing.SystemIcons]::Information",
    "$notification.Visible = $true",
    `$notification.ShowBalloonTip(3000, '${escapedTitle}', '${escapedMessage}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Milliseconds 4000",
    "$notification.Dispose()",
  ].join("; ")
}
