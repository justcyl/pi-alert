import { basename } from "node:path"
import type { AgentEndEvent, ExtensionAPI } from "@mariozechner/pi-coding-agent"

const APP_NAME = "pi"
const FALLBACK_MESSAGE = "Agent finished its turn"
const NOTIFICATION_TIMEOUT_MS = 5_000

export type NotificationCommand = {
  command: string
  args: string[]
}

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

  pi.on("agent_end", async (event, ctx) => {
    const liveSummary = snapshotRunState(currentRun)
    const fallbackSummary = summarizeAgentEndMessages(event.messages)
    const message = buildAlertMessage(mergeAlertSummaries(liveSummary, fallbackSummary))
    const title = buildAlertTitle(ctx.cwd)

    currentRun = null
    await notifyBestAvailable(pi, title, message)
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
  if (await notifyMacOS(pi, title, message)) {
    return
  }

  sendTerminalBell(process.stdout)
}

async function notifyMacOS(pi: ExtensionAPI, title: string, message: string): Promise<boolean> {
  return execFirstAvailable(pi, buildNotificationCommands("darwin", title, message))
}

export function sendTerminalBell(writer: TerminalWriter = process.stdout): boolean {
  if (writer.isTTY !== true) {
    return false
  }

  writer.write("\x07")
  return true
}

export function buildNotificationCommands(
  targetPlatform: NodeJS.Platform,
  title: string,
  message: string,
): NotificationCommand[] {
  if (targetPlatform !== "darwin") {
    return []
  }

  return [
    {
      command: "osascript",
      args: [
        "-e",
        `display notification "${escapeAppleScriptString(message)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`,
      ],
    },
  ]
}

async function execFirstAvailable(pi: ExtensionAPI, commands: NotificationCommand[]): Promise<boolean> {
  for (const command of commands) {
    if (await tryCommand(pi, command)) {
      return true
    }
  }

  return false
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

export function buildAlertTitle(cwd: string | null | undefined): string {
  if (!cwd) {
    return APP_NAME
  }

  const normalizedCwd = cwd.replace(/[\\/]+$/, "") || cwd
  const rootDir = basename(normalizedCwd)
  return rootDir ? `${APP_NAME} — ${rootDir}` : APP_NAME
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
    return `${Math.floor(seconds)}s`
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
