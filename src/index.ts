#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  findBoardReference,
  findBoardReferenceByFqbn,
  listBoardReferences,
  type BoardReference
} from "./boardReference.js";
import {
  resolveSketchPath,
  runArduinoCli,
  runCommand,
  tryParseJson,
  type ArduinoCliConfig,
  type CommandResult
} from "./arduinoCli.js";
import { PortOperationCoordinator } from "./portCoordinator.js";
import { SerialSessionManager } from "./serialSessions.js";
import { runSafetyPreflight, type PowerSpec, type WiringSignal } from "./safety.js";

const cliPathFromEnv = process.env.ARDUINO_CLI_PATH?.trim();
const sketchRootFromEnv = process.env.ARDUINO_SKETCH_ROOT?.trim();

const arduinoConfig: ArduinoCliConfig = {
  cliPath: cliPathFromEnv && cliPathFromEnv.length > 0 ? cliPathFromEnv : "arduino-cli",
  sketchRoot: sketchRootFromEnv && sketchRootFromEnv.length > 0 ? sketchRootFromEnv : undefined
};

const portCoordinator = new PortOperationCoordinator();
const serialSessionManager = new SerialSessionManager(portCoordinator);

const commandResultSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  args: z.array(z.string()),
  code: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  durationMs: z.number()
});

const toolOutputShape = {
  ok: z.boolean(),
  status: z.enum(["ok", "warning", "error"]).optional(),
  command: z.string().optional(),
  data: z.unknown().optional(),
  raw: commandResultSchema.optional(),
  rawTail: z
    .object({
      stdout: z.string().optional(),
      stderr: z.string().optional()
    })
    .optional(),
  stage: z.string().optional(),
  errorCode: z.string().optional(),
  retryable: z.boolean().optional(),
  reasonCodes: z.array(z.string()).optional(),
  nextActions: z.array(z.string()).optional(),
  note: z.string().optional(),
  error: z.string().optional()
};

const toolOutputSchema = z.object(toolOutputShape);
type ToolOutput = z.infer<typeof toolOutputSchema>;

function toToolResult(payload: ToolOutput, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function toUnhandledError(error: unknown) {
  return toToolResult(
    {
      ok: false,
      error: error instanceof Error ? error.message : "Unhandled tool error."
    },
    true
  );
}

interface InstallGuide {
  docsUrl: string;
  recommended: string[];
  alternatives: string[];
  notes?: string[];
}

interface EnvVarGuide {
  windowsPowerShell: {
    temporary: string;
    persistentCurrentUser: string;
  };
  macOrLinuxBash: {
    temporary: string;
    persistentProfile: string;
  };
}

function getArduinoCliInstallGuide(platform: NodeJS.Platform): InstallGuide {
  const docsUrl = "https://docs.arduino.cc/arduino-cli/installation/";

  if (platform === "win32") {
    return {
      docsUrl,
      recommended: [
        "winget install ArduinoSA.CLI",
        "Download the official Windows x64 Arduino CLI package (.exe or .msi) from the installation page.",
        "Install and ensure `arduino-cli` is on PATH, or set `ARDUINO_CLI_PATH` to the binary location."
      ],
      alternatives: [
        "choco install arduino-cli",
        "Use Git Bash and run the official install script: curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh"
      ],
      notes: [
        "The install script requires `sh`, which is not present in default Windows PowerShell."
      ]
    };
  }

  if (platform === "darwin") {
    return {
      docsUrl,
      recommended: ["brew update", "brew install arduino-cli"],
      alternatives: [
        "curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh"
      ]
    };
  }

  if (platform === "linux") {
    return {
      docsUrl,
      recommended: ["brew update", "brew install arduino-cli"],
      alternatives: [
        "curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh"
      ],
      notes: [
        "On Linux, either Homebrew or the official install script works. Ensure the installed binary path is on PATH."
      ]
    };
  }

  return {
    docsUrl,
    recommended: [
      "Use the official Arduino CLI installation page to download the matching platform binary."
    ],
    alternatives: [],
    notes: ["Set `ARDUINO_CLI_PATH` if the binary is not available on PATH."]
  };
}

function getEnvVarGuide(): EnvVarGuide {
  return {
    windowsPowerShell: {
      temporary: "$env:ARDUINO_CLI_PATH='C:\\path\\to\\arduino-cli.exe'",
      persistentCurrentUser:
        "[Environment]::SetEnvironmentVariable('ARDUINO_CLI_PATH','C:\\path\\to\\arduino-cli.exe','User')"
    },
    macOrLinuxBash: {
      temporary: "export ARDUINO_CLI_PATH=/absolute/path/to/arduino-cli",
      persistentProfile: "echo 'export ARDUINO_CLI_PATH=/absolute/path/to/arduino-cli' >> ~/.bashrc"
    }
  };
}

function parseArduinoCliVersion(rawOutput: string): string | null {
  const match = rawOutput.match(/\b(\d+\.\d+\.\d+(?:[-+.\w]*)?)\b/);
  return match ? match[1] : null;
}

function isLikelyMissingCli(raw: CommandResult): boolean {
  if (raw.ok) {
    return false;
  }
  const combined = `${raw.stderr}\n${raw.stdout}`.toLowerCase();
  return (
    raw.code === null &&
    (combined.includes("enoent") ||
      combined.includes("not recognized") ||
      combined.includes("no such file") ||
      combined.includes("cannot find"))
  );
}

function withCliHint(baseMessage: string, raw: CommandResult): string {
  if (!isLikelyMissingCli(raw)) {
    return baseMessage;
  }

  return `${baseMessage} Arduino CLI appears missing. Run \`arduino_cli_doctor\`, then \`install_arduino_cli\` (method=auto), set \`ARDUINO_CLI_PATH\` if needed, then retry. Do not use fallback hardware scans before CLI is installed.`;
}

type InstallMethod = "auto" | "winget" | "choco" | "brew" | "script";

interface InstallStrategy {
  method: Exclude<InstallMethod, "auto">;
  command: string;
  args: string[];
  requires?: string;
}

interface InstallAttempt {
  method: string;
  command: string;
  args: string[];
  skipped?: boolean;
  skipReason?: string;
  result?: CommandResult;
}

function summarizeCommandResult(result: CommandResult) {
  return {
    ok: result.ok,
    command: result.command,
    args: result.args,
    code: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutTail: result.stdout.trim().slice(-5000),
    stderrTail: result.stderr.trim().slice(-5000)
  };
}

async function isCommandAvailable(commandName: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(checker, [commandName], 10_000);
  return result.ok;
}

function buildInstallStrategies(platform: NodeJS.Platform, method: InstallMethod): InstallStrategy[] {
  const all: InstallStrategy[] = [];

  if (platform === "win32") {
    all.push({
      method: "winget",
      command: "winget",
      args: ["install", "--id", "ArduinoSA.CLI", "-e", "--accept-source-agreements", "--accept-package-agreements"],
      requires: "winget"
    });
    all.push({
      method: "choco",
      command: "choco",
      args: ["install", "arduino-cli", "-y"],
      requires: "choco"
    });
  } else if (platform === "darwin" || platform === "linux") {
    all.push({
      method: "brew",
      command: "brew",
      args: ["install", "arduino-cli"],
      requires: "brew"
    });
    all.push({
      method: "script",
      command: "sh",
      args: ["-c", "curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh"],
      requires: "sh"
    });
  }

  if (method === "auto") {
    return all;
  }
  return all.filter((strategy) => strategy.method === method);
}

async function findArduinoCliExecutable(): Promise<string | null> {
  const directCandidates = [arduinoConfig.cliPath, "arduino-cli"];
  for (const candidate of directCandidates) {
    const res = await runCommand(candidate, ["version"], 10_000);
    if (res.ok) {
      return candidate;
    }
  }

  const locator = process.platform === "win32" ? "where" : "which";
  const located = await runCommand(locator, ["arduino-cli"], 10_000);
  if (located.ok) {
    const firstPath = located.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstPath) {
      return firstPath;
    }
  }

  const candidates: string[] = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "arduino-cli.exe"));
    }
    if (process.env.ProgramData) {
      candidates.push(path.join(process.env.ProgramData, "chocolatey", "bin", "arduino-cli.exe"));
    }
    candidates.push("C:\\Program Files\\Arduino CLI\\arduino-cli.exe");
  } else {
    candidates.push("/usr/local/bin/arduino-cli");
    candidates.push("/opt/homebrew/bin/arduino-cli");
    candidates.push("/home/linuxbrew/.linuxbrew/bin/arduino-cli");
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, "bin", "arduino-cli"));
    }
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const res = await runCommand(candidate, ["version"], 10_000);
    if (res.ok) {
      return candidate;
    }
  }

  return null;
}

function fqbnToCoreId(fqbn: string): string | null {
  const parts = fqbn.split(":").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) {
    return null;
  }
  return `${parts[0]}:${parts[1]}`;
}

function extractCoreIdFromEntry(entry: JsonRecord): string | null {
  const direct = asString(entry.id) ?? asString(entry.ID) ?? asString(entry.core_id) ?? asString(entry.core);
  if (direct) {
    return direct;
  }

  const pkg = asString(entry.package);
  const arch = asString(entry.architecture);
  if (pkg && arch) {
    return `${pkg}:${arch}`;
  }

  return null;
}

function extractInstalledCoreIds(payload: unknown): Set<string> {
  const out = new Set<string>();

  const collect = (value: unknown) => {
    const records = asArray(value).map(asRecord).filter((r): r is JsonRecord => r !== null);
    for (const record of records) {
      const coreId = extractCoreIdFromEntry(record);
      if (coreId) {
        out.add(coreId);
      }
    }
  };

  if (Array.isArray(payload)) {
    collect(payload);
    return out;
  }

  const root = asRecord(payload);
  if (!root) {
    return out;
  }

  collect(root.installed);
  collect(root.platforms);
  collect(root.cores);
  collect(root.data);

  if (out.size === 0) {
    collect([root]);
  }

  return out;
}

interface EnsureCoreResult {
  ok: boolean;
  coreId: string;
  installed: boolean;
  alreadyInstalled: boolean;
  autoInstallRequested: boolean;
  autoInstallAttempted: boolean;
  listBeforeRaw?: CommandResult;
  updateIndexRaw?: CommandResult;
  installRaw?: CommandResult;
  listAfterRaw?: CommandResult;
  error?: string;
}

async function ensureCoreInstalled(coreId: string, autoInstall = true): Promise<EnsureCoreResult> {
  const listBeforeRaw = await runArduinoCli(arduinoConfig, ["core", "list", "--format", "json"], 120_000);
  if (!listBeforeRaw.ok) {
    return {
      ok: false,
      coreId,
      installed: false,
      alreadyInstalled: false,
      autoInstallRequested: autoInstall,
      autoInstallAttempted: false,
      listBeforeRaw,
      error: "Failed to list installed Arduino cores."
    };
  }

  const beforeParsed = tryParseJson<unknown>(listBeforeRaw.stdout);
  const installedBefore = extractInstalledCoreIds(beforeParsed).has(coreId);
  if (installedBefore) {
    return {
      ok: true,
      coreId,
      installed: true,
      alreadyInstalled: true,
      autoInstallRequested: autoInstall,
      autoInstallAttempted: false,
      listBeforeRaw
    };
  }

  if (!autoInstall) {
    return {
      ok: false,
      coreId,
      installed: false,
      alreadyInstalled: false,
      autoInstallRequested: false,
      autoInstallAttempted: false,
      listBeforeRaw,
      error: `Required core "${coreId}" is not installed.`
    };
  }

  const updateIndexRaw = await runArduinoCli(arduinoConfig, ["core", "update-index"], 240_000);
  const installRaw = await runArduinoCli(arduinoConfig, ["core", "install", coreId], 600_000);
  const listAfterRaw = await runArduinoCli(arduinoConfig, ["core", "list", "--format", "json"], 120_000);

  const afterParsed = tryParseJson<unknown>(listAfterRaw.stdout);
  const installedAfter = listAfterRaw.ok && extractInstalledCoreIds(afterParsed).has(coreId);
  const ok = installRaw.ok && installedAfter;

  return {
    ok,
    coreId,
    installed: installedAfter,
    alreadyInstalled: false,
    autoInstallRequested: true,
    autoInstallAttempted: true,
    listBeforeRaw,
    updateIndexRaw,
    installRaw,
    listAfterRaw,
    error: ok ? undefined : `Failed to install core "${coreId}".`
  };
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface DetectedBoardCandidate {
  name?: string;
  fqbn?: string;
}

interface NormalizedPortEntry {
  address?: string;
  protocol?: string;
  label?: string;
  hardwareId?: string;
  properties: JsonRecord[];
  detectedBoardCandidates: DetectedBoardCandidate[];
}

function normalizeBoardListEntries(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
  }

  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const detectedPorts = asArray(root.detected_ports);
  if (detectedPorts.length > 0) {
    return detectedPorts.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
  }

  const ports = asArray(root.ports);
  if (ports.length > 0) {
    return ports.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
  }

  return [];
}

function normalizePortEntry(entry: JsonRecord): NormalizedPortEntry {
  const port = asRecord(entry.port) ?? entry;

  const candidates: DetectedBoardCandidate[] = [];
  const matchingBoards = asArray(entry.matching_boards);
  const listedBoards = asArray(entry.boards);
  const allBoards = [...matchingBoards, ...listedBoards];

  for (const rawBoard of allBoards) {
    const board = asRecord(rawBoard);
    if (!board) {
      continue;
    }
    const name = asString(board.name);
    const fqbn = asString(board.fqbn);
    if (name || fqbn) {
      candidates.push({ name, fqbn });
    }
  }

  const entryFqbn = asString(entry.fqbn);
  const entryName = asString(entry.name);
  if (entryFqbn || entryName) {
    candidates.push({ name: entryName, fqbn: entryFqbn });
  }

  const dedupedCandidates: DetectedBoardCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.fqbn ?? ""}|${candidate.name ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedCandidates.push(candidate);
  }

  const properties = asArray(port.properties)
    .map(asRecord)
    .filter((prop): prop is JsonRecord => prop !== null);

  return {
    address: asString(port.address) ?? asString(entry.address),
    protocol: asString(port.protocol) ?? asString(entry.protocol),
    label: asString(port.label) ?? asString(entry.label),
    hardwareId: asString(port.hardware_id) ?? asString(entry.hardware_id),
    properties,
    detectedBoardCandidates: dedupedCandidates
  };
}

interface SafetyContextInput {
  board?: string;
  fqbn?: string;
  wiring?: WiringSignal[];
  power?: PowerSpec;
}

interface ResolvedBoardForSafety {
  board: BoardReference | null;
  source: "board" | "fqbn" | "port_inference" | "none";
  confidenceType: "measured" | "inferred" | "heuristic";
  note?: string;
}

async function inferBoardReferenceFromPort(port: string): Promise<BoardReference | null> {
  const raw = await runArduinoCli(arduinoConfig, ["board", "list", "--format", "json"]);
  if (!raw.ok) {
    return null;
  }

  const parsed = tryParseJson<unknown>(raw.stdout);
  const entries = normalizeBoardListEntries(parsed).map(normalizePortEntry);
  const target = entries.find(
    (entry) => entry.address && entry.address.trim().toLowerCase() === port.trim().toLowerCase()
  );
  if (!target) {
    return null;
  }

  for (const candidate of target.detectedBoardCandidates) {
    if (candidate.fqbn) {
      const byFqbn = findBoardReferenceByFqbn(candidate.fqbn);
      if (byFqbn) {
        return byFqbn;
      }
    }
    if (candidate.name) {
      const byName = findBoardReference(candidate.name);
      if (byName.length > 0) {
        return byName[0];
      }
    }
  }

  return null;
}

async function resolveBoardForSafety(context: SafetyContextInput, fallbackPort?: string): Promise<ResolvedBoardForSafety> {
  if (context.board) {
    const byBoard = findBoardReference(context.board);
    if (byBoard.length > 0) {
      return {
        board: byBoard[0],
        source: "board",
        confidenceType: "heuristic"
      };
    }
  }

  const effectiveFqbn = context.fqbn;
  if (effectiveFqbn) {
    const byFqbn = findBoardReferenceByFqbn(effectiveFqbn);
    if (byFqbn) {
      return {
        board: byFqbn,
        source: "fqbn",
        confidenceType: "measured"
      };
    }
  }

  if (fallbackPort) {
    const byPort = await inferBoardReferenceFromPort(fallbackPort);
    if (byPort) {
      return {
        board: byPort,
        source: "port_inference",
        confidenceType: "inferred",
        note: "Board inferred from arduino-cli detected port metadata."
      };
    }
  }

  return {
    board: null,
    source: "none",
    confidenceType: "heuristic"
  };
}

function toPortBusyResult(port: string, stage: string, heldBy: ReturnType<PortOperationCoordinator["get"]>) {
  return toToolResult(
    {
      ok: false,
      status: "error",
      command: stage,
      stage,
      errorCode: "PORT_BUSY",
      retryable: true,
      reasonCodes: ["PORT_BUSY"],
      error: `Port ${port} is busy.`,
      data: {
        port,
        lock: heldBy
      },
      nextActions: [
        "Close any active serial sessions using serial_close_session.",
        "Retry after current operation on this port completes."
      ]
    },
    true
  );
}

function acquirePortLockOrError(port: string, owner: string, stage: string) {
  const lockResult = portCoordinator.acquire(port, owner, stage);
  if (!lockResult.ok) {
    return {
      ok: false as const,
      toolResult: toPortBusyResult(port, stage, lockResult.heldBy ?? null)
    };
  }
  return {
    ok: true as const
  };
}

async function runSafetyGate(
  context: SafetyContextInput,
  fallbackPort: string | undefined,
  unsafeSkipPreflight: boolean
) {
  if (unsafeSkipPreflight) {
    return {
      ok: true,
      skipped: true,
      reasonCodes: ["SAFETY_PREFLIGHT_SKIPPED"]
    };
  }

  const resolved = await resolveBoardForSafety(context, fallbackPort);
  if (!resolved.board) {
    return {
      ok: false,
      errorCode: "BOARD_UNKNOWN",
      reasonCodes: ["BOARD_UNKNOWN"],
      error:
        "Safety preflight could not resolve board reference. Provide safetyContext.board, safetyContext.fqbn, or upload fqbn."
    };
  }

  const safety = runSafetyPreflight({
    board: resolved.board,
    wiring: context.wiring,
    power: context.power
  });

  if (safety.status === "blocked") {
    return {
      ok: false,
      errorCode: "SAFETY_PREFLIGHT_BLOCKED",
      reasonCodes: safety.reasonCodes,
      error: "Safety preflight blocked this operation due to electrical risk findings.",
      safety,
      confidenceType: resolved.confidenceType,
      source: resolved.source,
      note: resolved.note
    };
  }

  return {
    ok: true,
    skipped: false,
    safety,
    confidenceType: resolved.confidenceType,
    source: resolved.source,
    note: resolved.note
  };
}

const server = new McpServer({
  name: "arduino-mcp-server",
  version: "0.2.5"
});

server.registerTool(
  "list_connected_boards",
  {
    title: "List Connected Boards",
    description: "List connected boards and serial ports detected by arduino-cli.",
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const raw = await runArduinoCli(arduinoConfig, ["board", "list", "--format", "json"]);
      const parsed = tryParseJson<unknown>(raw.stdout);
      return toToolResult(
        {
          ok: raw.ok,
          command: "board list",
          data: parsed,
          raw,
          error: raw.ok ? undefined : withCliHint("arduino-cli board list failed.", raw)
        },
        !raw.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "arduino_cli_doctor",
  {
    title: "Arduino CLI Doctor",
    description:
      "Check whether arduino-cli is available and return OS-specific installation instructions if missing.",
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const raw = await runArduinoCli(arduinoConfig, ["version"], 15_000);
      const guide = getArduinoCliInstallGuide(process.platform);
      const envVarGuide = getEnvVarGuide();
      const rawVersionOutput = raw.stdout.trim() || raw.stderr.trim() || null;
      const parsedVersion = rawVersionOutput ? parseArduinoCliVersion(rawVersionOutput) : null;
      const installed = raw.ok;

      return toToolResult({
        ok: installed,
        command: "version",
        data: {
          cliPath: arduinoConfig.cliPath,
          platform: process.platform,
          arch: process.arch,
          requiredDependency: {
            name: "arduino-cli",
            required: true,
            installed
          },
          installed,
          version: installed ? parsedVersion : null,
          rawVersionOutput,
          installGuide: guide,
          envVarGuide,
          agentRequiredWorkflow: installed
            ? [
                "Proceed with detect_hardware.",
                "Use compile_sketch and upload_sketch for build/deploy."
              ]
            : [
                "Stop workflows that depend on arduino-cli.",
                "Call install_arduino_cli (method=auto).",
                "If install tool fails, install arduino-cli using installGuide.",
                "If binary is not on PATH, set ARDUINO_CLI_PATH using envVarGuide.",
                "Restart the MCP server session if environment changed.",
                "Re-run arduino_cli_doctor and require installed=true.",
                "Then run detect_hardware."
              ],
          strictPolicy: {
            noFallbackHardwareScanWithoutCli: true,
            reason:
              "Board/FQBN resolution and Arduino workflows must come from arduino-cli for reliable behavior."
          },
          postInstallChecks: [
            "arduino-cli version",
            "arduino-cli core update-index",
            "arduino-cli board list --format json"
          ],
          nextRecommendedToolCall: "detect_hardware"
        },
        raw,
        note: installed
          ? "Arduino CLI is available."
          : "Arduino CLI is not available. Install it, set ARDUINO_CLI_PATH if needed, and re-run this tool.",
        error: installed ? undefined : withCliHint("arduino-cli version check failed.", raw)
      });
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "install_arduino_cli",
  {
    title: "Install Arduino CLI",
    description:
      "Attempt to install arduino-cli for the current OS using available package managers, then verify and configure CLI path.",
    inputSchema: {
      method: z
        .enum(["auto", "winget", "choco", "brew", "script"])
        .optional()
        .describe("Install method. Default `auto` tries OS-relevant methods in order."),
      setCliPathInProcess: z
        .boolean()
        .optional()
        .describe("If true (default), set ARDUINO_CLI_PATH in this MCP process after install.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async ({ method = "auto", setCliPathInProcess = true }) => {
    try {
      const selectedMethod = method as InstallMethod;
      const strategies = buildInstallStrategies(process.platform, selectedMethod);
      if (strategies.length === 0) {
        return toToolResult(
          {
            ok: false,
            command: "install_arduino_cli",
            data: {
              platform: process.platform,
              selectedMethod
            },
            error: "No supported install strategy for this platform/method."
          },
          true
        );
      }

      const attempts: InstallAttempt[] = [];
      let lastResult: CommandResult | undefined;
      let installAttempted = false;

      for (const strategy of strategies) {
        if (strategy.requires) {
          const available = await isCommandAvailable(strategy.requires);
          if (!available) {
            attempts.push({
              method: strategy.method,
              command: strategy.command,
              args: strategy.args,
              skipped: true,
              skipReason: `Required command not found: ${strategy.requires}`
            });
            continue;
          }
        }

        installAttempted = true;
        const result = await runCommand(strategy.command, strategy.args, 600_000);
        attempts.push({
          method: strategy.method,
          command: strategy.command,
          args: strategy.args,
          result
        });
        lastResult = result;

        if (result.ok) {
          break;
        }
      }

      const resolvedCliPath = await findArduinoCliExecutable();
      if (resolvedCliPath && setCliPathInProcess) {
        arduinoConfig.cliPath = resolvedCliPath;
        process.env.ARDUINO_CLI_PATH = resolvedCliPath;
      }

      const verify = await runArduinoCli(arduinoConfig, ["version"], 20_000);
      const installed = verify.ok;
      const versionOutput = verify.stdout.trim() || verify.stderr.trim() || null;
      const parsedVersion = versionOutput ? parseArduinoCliVersion(versionOutput) : null;

      const attemptSummaries = attempts.map((attempt) => ({
        method: attempt.method,
        command: attempt.command,
        args: attempt.args,
        skipped: attempt.skipped ?? false,
        skipReason: attempt.skipReason,
        result: attempt.result ? summarizeCommandResult(attempt.result) : undefined
      }));

      return toToolResult(
        {
          ok: installed,
          command: "install_arduino_cli",
          data: {
            platform: process.platform,
            selectedMethod,
            installAttempted,
            attempts: attemptSummaries,
            resolvedCliPath,
            cliPathInUse: arduinoConfig.cliPath,
            setCliPathInProcess,
            installed,
            version: installed ? parsedVersion : null,
            versionOutput
          },
          raw: verify,
          note: installed
            ? "Arduino CLI installation verified. You can run detect_hardware now."
            : "Installation was not verified. Review attempts and run arduino_cli_doctor.",
          error:
            installed || !lastResult
              ? undefined
              : withCliHint(
                  "Failed to install or verify arduino-cli automatically.",
                  verify.ok ? lastResult : verify
                )
        },
        !installed
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "list_supported_boards",
  {
    title: "List Supported Boards",
    description: "List supported/installable boards from the local arduino-cli index.",
    inputSchema: {
      search: z.string().optional().describe("Optional case-insensitive filter for name/FQBN.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ search }) => {
    try {
      const raw = await runArduinoCli(arduinoConfig, ["board", "listall", "--format", "json"], 120_000);
      const parsed = tryParseJson<unknown[]>(raw.stdout);

      let filtered: unknown = parsed;
      if (search && Array.isArray(parsed)) {
        const q = search.toLowerCase();
        filtered = parsed.filter((entry) => JSON.stringify(entry).toLowerCase().includes(q));
      }

      return toToolResult(
        {
          ok: raw.ok,
          command: "board listall",
          data: {
            search: search ?? null,
            count: Array.isArray(filtered) ? filtered.length : null,
            boards: filtered
          },
          raw,
          error: raw.ok ? undefined : withCliHint("arduino-cli board listall failed.", raw)
        },
        !raw.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "ensure_core_installed",
  {
    title: "Ensure Core Installed",
    description:
      "Ensure the Arduino core required by a board FQBN is installed. Can auto-install via `arduino-cli core install`.",
    inputSchema: {
      fqbn: z.string().optional().describe("Board FQBN, e.g. arduino:avr:uno."),
      coreId: z.string().optional().describe("Core ID, e.g. arduino:avr."),
      autoInstall: z.boolean().optional().describe("If true (default), install missing core automatically.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ fqbn, coreId, autoInstall = true }) => {
    try {
      const resolvedCoreId = coreId ?? (fqbn ? fqbnToCoreId(fqbn) : null);
      if (!resolvedCoreId) {
        return toToolResult(
          {
            ok: false,
            command: "ensure_core_installed",
            data: {
              fqbn: fqbn ?? null,
              coreId: coreId ?? null
            },
            error: "Provide either a valid `coreId` or `fqbn`."
          },
          true
        );
      }

      const ensure = await ensureCoreInstalled(resolvedCoreId, autoInstall);
      const primaryRaw = ensure.installRaw ?? ensure.listBeforeRaw;
      const primaryErrorRaw = ensure.installRaw ?? ensure.listBeforeRaw ?? ensure.listAfterRaw;

      return toToolResult(
        {
          ok: ensure.ok,
          command: "ensure core",
          data: {
            fqbn: fqbn ?? null,
            coreId: ensure.coreId,
            installed: ensure.installed,
            alreadyInstalled: ensure.alreadyInstalled,
            autoInstallRequested: ensure.autoInstallRequested,
            autoInstallAttempted: ensure.autoInstallAttempted,
            commands: {
              listBefore: ensure.listBeforeRaw ? summarizeCommandResult(ensure.listBeforeRaw) : null,
              updateIndex: ensure.updateIndexRaw ? summarizeCommandResult(ensure.updateIndexRaw) : null,
              install: ensure.installRaw ? summarizeCommandResult(ensure.installRaw) : null,
              listAfter: ensure.listAfterRaw ? summarizeCommandResult(ensure.listAfterRaw) : null
            }
          },
          raw: primaryRaw,
          error:
            ensure.ok || !primaryErrorRaw
              ? undefined
              : withCliHint(ensure.error ?? "Failed to ensure required core installation.", primaryErrorRaw)
        },
        !ensure.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "detect_hardware",
  {
    title: "Detect Hardware",
    description:
      "Detect connected Arduino-compatible hardware, infer board/FQBN candidates, and generate next compile/upload commands.",
    inputSchema: {
      port: z.string().optional().describe("Optional exact port filter, e.g. COM6 or /dev/ttyACM0."),
      includeBoardDetails: z
        .boolean()
        .optional()
        .describe("If true, query `arduino-cli board details` for selected FQBN candidates.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ port, includeBoardDetails = false }) => {
    try {
      const raw = await runArduinoCli(arduinoConfig, ["board", "list", "--format", "json"]);
      const parsed = tryParseJson<unknown>(raw.stdout);

      if (!raw.ok) {
      return toToolResult(
        {
          ok: false,
          command: "board list",
          raw,
          error: withCliHint("arduino-cli board list failed.", raw)
        },
        true
      );
      }

      const entries = normalizeBoardListEntries(parsed);
      const normalized = entries.map(normalizePortEntry);

      const filtered = port
        ? normalized.filter(
            (entry) => entry.address && entry.address.toLowerCase() === port.trim().toLowerCase()
          )
        : normalized;

      const boardDetailsCache = new Map<string, unknown>();

      const ports = [];
      for (const entry of filtered) {
        const selectedCandidateWithFqbn = entry.detectedBoardCandidates.find((candidate) => candidate.fqbn);
        const selectedBoardName = selectedCandidateWithFqbn?.name ?? entry.detectedBoardCandidates[0]?.name;
        const selectedFqbn = selectedCandidateWithFqbn?.fqbn;

        const referenceQuery = selectedFqbn ?? selectedBoardName;
        const referenceMatches = referenceQuery ? findBoardReference(referenceQuery) : [];
        const referenceSuggestions = referenceMatches.map((match) => ({
          id: match.id,
          displayName: match.displayName,
          fqbnCandidates: match.fqbnCandidates
        }));

        const inferredFqbn = selectedFqbn ?? referenceMatches[0]?.fqbnCandidates?.[0];
        const hasKnownReference = referenceSuggestions.length > 0;
        const requiresUserBoardConfirmation = !inferredFqbn || !hasKnownReference;

        let boardDetails: unknown = undefined;
        if (includeBoardDetails && inferredFqbn) {
          if (boardDetailsCache.has(inferredFqbn)) {
            boardDetails = boardDetailsCache.get(inferredFqbn);
          } else {
            const detailsRaw = await runArduinoCli(
              arduinoConfig,
              ["board", "details", "--fqbn", inferredFqbn, "--format", "json"],
              120_000
            );
            const detailsParsed = tryParseJson<unknown>(detailsRaw.stdout);
            boardDetails = detailsRaw.ok
              ? { ok: true, details: detailsParsed }
              : {
                  ok: false,
                  error: detailsRaw.stderr || "Failed to fetch board details."
                };
            boardDetailsCache.set(inferredFqbn, boardDetails);
          }
        }

        const address = entry.address ?? null;
        const detectedHints = entry.detectedBoardCandidates
          .map((candidate) => candidate.fqbn ?? candidate.name)
          .filter((value): value is string => Boolean(value));

        ports.push({
          address,
          protocol: entry.protocol ?? null,
          label: entry.label ?? null,
          hardwareId: entry.hardwareId ?? null,
          properties: entry.properties,
          detectedBoardCandidates: entry.detectedBoardCandidates,
          selectedBoardName: selectedBoardName ?? null,
          selectedFqbn: inferredFqbn ?? null,
          detectionConfidence: requiresUserBoardConfirmation ? "low" : "high",
          requiresUserBoardConfirmation,
          referenceSuggestions,
          boardDetails,
          agentAction: requiresUserBoardConfirmation
            ? {
                type: "ask_user",
                reason: !inferredFqbn
                  ? "Board type could not be inferred from detected port data."
                  : "Board seems non-standard or not in local standard board references.",
                question:
                  address
                    ? `I detected a device on ${address}. Which board model are you using (for example: Arduino Uno R3, Nano, Mega 2560, ESP32 Dev Module)?`
                    : "I detected a serial device but cannot identify the board model. Which board are you using?",
                requestedFields: ["boardModel", "fqbnIfKnown"],
                hintsFromDetection: detectedHints,
                ifUserUnsureThen: [
                  "Try unplug/replug and run detect_hardware again to isolate the target port.",
                  "Run list_supported_boards with a search string based on likely board family.",
                  "Attempt upload with a likely FQBN and check for a successful handshake."
                ]
              }
            : {
                type: "continue",
                reason: "Board and FQBN have sufficient confidence for compile/upload workflow."
              },
          nextCommands:
            address && inferredFqbn
              ? {
                  compile: `arduino-cli compile --fqbn ${inferredFqbn} <sketchPath>`,
                  upload: `arduino-cli upload -p ${address} --fqbn ${inferredFqbn} <sketchPath>`
                }
              : null,
          nextToolCalls:
            address && inferredFqbn
              ? {
                  compile_sketch: {
                    sketchPath: "<sketchPath>",
                    fqbn: inferredFqbn,
                    autoInstallCore: true
                  },
                  upload_sketch: {
                    sketchPath: "<sketchPath>",
                    port: address,
                    fqbn: inferredFqbn,
                    autoInstallCore: true
                  }
                }
              : null
        });
      }

      const summary = {
        requestedPort: port ?? null,
        includeBoardDetails,
        totalDetectedPorts: ports.length,
        portsWithBoardCandidate: ports.filter(
          (entry) => Array.isArray(entry.detectedBoardCandidates) && entry.detectedBoardCandidates.length > 0
        ).length,
        portsReadyForCompileUpload: ports.filter((entry) => entry.address && entry.selectedFqbn).length,
        unresolvedPorts: ports.filter((entry) => entry.requiresUserBoardConfirmation).length,
        requiresUserInput: ports.some((entry) => entry.requiresUserBoardConfirmation),
        nextAgentStep: ports.some((entry) => entry.requiresUserBoardConfirmation)
          ? "Ask user to confirm board model/FQBN for unresolved ports before compile/upload."
          : "Proceed to compile_sketch and upload_sketch."
      };

      return toToolResult({
        ok: true,
        command: includeBoardDetails ? "board list + board details" : "board list",
        data: {
          summary,
          ports
        },
        raw
      });
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "list_serial_ports",
  {
    title: "List Serial Ports",
    description:
      "List serial ports and any detected board metadata using arduino-cli. Works on Windows/macOS/Linux.",
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const raw = await runArduinoCli(arduinoConfig, ["board", "list", "--format", "json"]);
      const parsed = tryParseJson<unknown>(raw.stdout);
      return toToolResult(
        {
          ok: raw.ok,
          command: "board list",
          data: parsed,
          raw,
          error: raw.ok ? undefined : withCliHint("arduino-cli board list failed.", raw)
        },
        !raw.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "compile_sketch",
  {
    title: "Compile Sketch",
    description: "Compile an Arduino sketch with a specific board FQBN.",
    inputSchema: {
      sketchPath: z.string().describe("Path to sketch folder or .ino file."),
      fqbn: z.string().describe("Board FQBN, e.g. arduino:avr:uno."),
      exportBinaries: z.boolean().optional().describe("If true, export binaries into sketch folder."),
      clean: z.boolean().optional().describe("If true, clean build cache before compile."),
      buildPath: z.string().optional().describe("Optional build output directory."),
      warnings: z.enum(["none", "default", "more", "all"]).optional(),
      autoInstallCore: z
        .boolean()
        .optional()
        .describe("If true (default), auto-install missing board core before compile.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ sketchPath, fqbn, exportBinaries, clean, buildPath, warnings, autoInstallCore = true }) => {
    try {
      const resolvedSketchPath = resolveSketchPath(sketchPath, arduinoConfig.sketchRoot);
      const coreId = fqbnToCoreId(fqbn);
      const coreEnsure = coreId ? await ensureCoreInstalled(coreId, autoInstallCore) : null;
      if (coreEnsure && !coreEnsure.ok) {
        const rawForError = coreEnsure.installRaw ?? coreEnsure.listBeforeRaw ?? coreEnsure.listAfterRaw;
        return toToolResult(
          {
            ok: false,
            command: "compile",
            data: {
              sketchPath: resolvedSketchPath,
              fqbn,
              coreId,
              autoInstallCore,
              coreEnsure: {
                installed: coreEnsure.installed,
                alreadyInstalled: coreEnsure.alreadyInstalled,
                autoInstallAttempted: coreEnsure.autoInstallAttempted
              }
            },
            raw: rawForError,
            error:
              rawForError
                ? withCliHint(
                    coreEnsure.error ?? `Required core "${coreId}" is not installed and could not be ensured.`,
                    rawForError
                  )
                : coreEnsure.error ?? `Required core "${coreId}" is not installed and could not be ensured.`
          },
          true
        );
      }

      const args = ["compile", resolvedSketchPath, "--fqbn", fqbn];

      if (buildPath) {
        args.push("--build-path", resolveSketchPath(buildPath, arduinoConfig.sketchRoot));
      }
      if (exportBinaries) {
        args.push("--export-binaries");
      }
      if (clean) {
        args.push("--clean");
      }
      if (warnings) {
        args.push("--warnings", warnings);
      }

      const raw = await runArduinoCli(arduinoConfig, args, 300_000);
      return toToolResult(
        {
          ok: raw.ok,
          command: "compile",
          data: {
            sketchPath: resolvedSketchPath,
            fqbn,
            coreId,
            coreEnsure: coreEnsure
              ? {
                  installed: coreEnsure.installed,
                  alreadyInstalled: coreEnsure.alreadyInstalled,
                  autoInstallAttempted: coreEnsure.autoInstallAttempted
                }
              : null
          },
          raw,
          error: raw.ok ? undefined : withCliHint("Sketch compilation failed.", raw)
        },
        !raw.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "upload_sketch",
  {
    title: "Upload Sketch",
    description: "Upload a compiled sketch to a connected board/port.",
    inputSchema: {
      sketchPath: z.string().describe("Path to sketch folder or .ino file."),
      port: z.string().describe("Serial port path, e.g. COM6 or /dev/ttyACM0."),
      fqbn: z.string().optional().describe("Optional board FQBN when auto-detect is insufficient."),
      verify: z.boolean().optional().describe("Verify uploaded binary when supported."),
      autoInstallCore: z
        .boolean()
        .optional()
        .describe("If true (default), auto-install missing board core when fqbn is provided."),
      unsafeSkipPreflight: z
        .boolean()
        .optional()
        .describe("If true, bypasses safety_preflight checks. Use only when user explicitly accepts risk."),
      safetyContext: z
        .object({
          board: z.string().optional().describe("Board name/id for safety checks."),
          fqbn: z.string().optional().describe("Board FQBN for safety checks."),
          wiring: z
            .array(
              z.object({
                pin: z.string(),
                direction: z.enum(["input", "output", "bidirectional"]).optional(),
                signalType: z.enum(["digital", "analog", "i2c", "spi", "uart", "power", "ground", "other"]).optional(),
                voltage: z.number().optional(),
                currentMa: z.number().optional(),
                notes: z.string().optional()
              })
            )
            .optional(),
          power: z
            .object({
              supplyVoltage: z.number().optional(),
              totalCurrentMa: z.number().optional(),
              supplyThrough: z.enum(["usb", "vin", "5v_pin", "3v3_pin", "gpio_pin", "unknown"]).optional()
            })
            .optional()
        })
        .optional()
        .describe("Optional electrical context for preflight checks.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({
    sketchPath,
    port,
    fqbn,
    verify,
    autoInstallCore = true,
    unsafeSkipPreflight = false,
    safetyContext
  }) => {
    try {
      const lockOwner = `upload_sketch:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const lock = acquirePortLockOrError(port, lockOwner, "upload_sketch");
      if (!lock.ok) {
        return lock.toolResult;
      }

      try {
        const safetyGate = await runSafetyGate(
          {
            board: safetyContext?.board,
            fqbn: safetyContext?.fqbn ?? fqbn,
            wiring: safetyContext?.wiring,
            power: safetyContext?.power
          },
          port,
          unsafeSkipPreflight
        );

        if (!safetyGate.ok) {
          return toToolResult(
            {
              ok: false,
              status: "error",
              command: "upload",
              stage: "preflight",
              errorCode: safetyGate.errorCode,
              reasonCodes: safetyGate.reasonCodes,
              error: safetyGate.error,
              data: {
                port,
                fqbn: fqbn ?? null,
                safetyContext: safetyContext ?? null,
                safetyResult: "safety" in safetyGate ? safetyGate.safety : null,
                confidenceType: "confidenceType" in safetyGate ? safetyGate.confidenceType : null,
                source: "source" in safetyGate ? safetyGate.source : null
              },
              nextActions: [
                "Run safety_preflight with board/fqbn and wiring/power details to resolve findings.",
                "Only use unsafeSkipPreflight=true when user explicitly accepts electrical risk."
              ]
            },
            true
          );
        }

        const resolvedSketchPath = resolveSketchPath(sketchPath, arduinoConfig.sketchRoot);
        const coreId = fqbn ? fqbnToCoreId(fqbn) : null;
        const coreEnsure = coreId ? await ensureCoreInstalled(coreId, autoInstallCore) : null;
        if (coreEnsure && !coreEnsure.ok) {
          const rawForError = coreEnsure.installRaw ?? coreEnsure.listBeforeRaw ?? coreEnsure.listAfterRaw;
          return toToolResult(
            {
              ok: false,
              status: "error",
              command: "upload",
              stage: "core_install",
              errorCode: "CORE_INSTALL_FAILED",
              data: {
                sketchPath: resolvedSketchPath,
                port,
                fqbn: fqbn ?? null,
                coreId,
                autoInstallCore,
                coreEnsure: {
                  installed: coreEnsure.installed,
                  alreadyInstalled: coreEnsure.alreadyInstalled,
                  autoInstallAttempted: coreEnsure.autoInstallAttempted
                }
              },
              raw: rawForError,
              error:
                rawForError
                  ? withCliHint(
                      coreEnsure.error ?? `Required core "${coreId}" is not installed and could not be ensured.`,
                      rawForError
                    )
                  : coreEnsure.error ?? `Required core "${coreId}" is not installed and could not be ensured.`
            },
            true
          );
        }

        const args = ["upload", resolvedSketchPath, "-p", port];
        if (fqbn) {
          args.push("--fqbn", fqbn);
        }
        if (verify) {
          args.push("--verify");
        }

        const raw = await runArduinoCli(arduinoConfig, args, 300_000);
        return toToolResult(
          {
            ok: raw.ok,
            status: raw.ok
              ? safetyGate.skipped
                ? "warning"
                : safetyGate.safety?.status === "pass_with_warnings"
                  ? "warning"
                  : "ok"
              : "error",
            command: "upload",
            stage: "upload",
            errorCode: raw.ok ? undefined : "UPLOAD_FAILED",
            reasonCodes: safetyGate.skipped
              ? ["SAFETY_PREFLIGHT_SKIPPED"]
              : safetyGate.safety?.reasonCodes ?? undefined,
            data: {
              sketchPath: resolvedSketchPath,
              port,
              fqbn: fqbn ?? null,
              coreId,
              safety: safetyGate.skipped
                ? {
                    skipped: true
                  }
                : {
                    source: safetyGate.source,
                    confidenceType: safetyGate.confidenceType,
                    preflight: safetyGate.safety
                  },
              coreEnsure: coreEnsure
                ? {
                    installed: coreEnsure.installed,
                    alreadyInstalled: coreEnsure.alreadyInstalled,
                    autoInstallAttempted: coreEnsure.autoInstallAttempted
                  }
                : null
            },
            nextActions: raw.ok
              ? ["Use serial_open_session or read_serial_snapshot to verify runtime logs."]
              : ["Verify board port/FQBN and retry upload.", "Run detect_hardware if port mapping changed."],
            raw,
            error: raw.ok ? undefined : withCliHint("Sketch upload failed.", raw)
          },
          !raw.ok
        );
      } finally {
        portCoordinator.release(port, lockOwner);
      }
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "upload_and_wait_ready",
  {
    title: "Upload And Wait Ready",
    description:
      "Upload a sketch and wait for a serial readiness pattern, handling post-upload reset/re-enumeration windows.",
    inputSchema: {
      sketchPath: z.string().describe("Path to sketch folder or .ino file."),
      port: z.string().describe("Serial port path, e.g. COM6 or /dev/ttyACM0."),
      fqbn: z.string().optional().describe("Optional board FQBN when auto-detect is insufficient."),
      verify: z.boolean().optional().describe("Verify uploaded binary when supported."),
      autoInstallCore: z
        .boolean()
        .optional()
        .describe("If true (default), auto-install missing board core when fqbn is provided."),
      readyPattern: z.string().optional().describe("Optional serial text pattern to wait for after upload."),
      readyTimeoutMs: z
        .number()
        .int()
        .min(500)
        .max(120_000)
        .optional()
        .describe("How long to wait for readyPattern."),
      readyBaudRate: z.number().int().positive().optional().describe("Baud rate for readiness check. Default 115200."),
      readyCaseSensitive: z.boolean().optional().describe("If true, readiness matching is case-sensitive."),
      unsafeSkipPreflight: z
        .boolean()
        .optional()
        .describe("If true, bypasses safety_preflight checks. Use only when user explicitly accepts risk."),
      safetyContext: z
        .object({
          board: z.string().optional(),
          fqbn: z.string().optional(),
          wiring: z
            .array(
              z.object({
                pin: z.string(),
                direction: z.enum(["input", "output", "bidirectional"]).optional(),
                signalType: z.enum(["digital", "analog", "i2c", "spi", "uart", "power", "ground", "other"]).optional(),
                voltage: z.number().optional(),
                currentMa: z.number().optional(),
                notes: z.string().optional()
              })
            )
            .optional(),
          power: z
            .object({
              supplyVoltage: z.number().optional(),
              totalCurrentMa: z.number().optional(),
              supplyThrough: z.enum(["usb", "vin", "5v_pin", "3v3_pin", "gpio_pin", "unknown"]).optional()
            })
            .optional()
        })
        .optional()
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({
    sketchPath,
    port,
    fqbn,
    verify,
    autoInstallCore = true,
    readyPattern,
    readyTimeoutMs = 20_000,
    readyBaudRate = 115200,
    readyCaseSensitive = false,
    unsafeSkipPreflight = false,
    safetyContext
  }) => {
    try {
      const lockOwner = `upload_and_wait_ready:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const lock = acquirePortLockOrError(port, lockOwner, "upload_and_wait_ready");
      if (!lock.ok) {
        return lock.toolResult;
      }

      try {
        const safetyGate = await runSafetyGate(
          {
            board: safetyContext?.board,
            fqbn: safetyContext?.fqbn ?? fqbn,
            wiring: safetyContext?.wiring,
            power: safetyContext?.power
          },
          port,
          unsafeSkipPreflight
        );

        if (!safetyGate.ok) {
          return toToolResult(
            {
              ok: false,
              status: "error",
              command: "upload_and_wait_ready",
              stage: "preflight",
              errorCode: safetyGate.errorCode,
              reasonCodes: safetyGate.reasonCodes,
              error: safetyGate.error
            },
            true
          );
        }

        const resolvedSketchPath = resolveSketchPath(sketchPath, arduinoConfig.sketchRoot);
        const coreId = fqbn ? fqbnToCoreId(fqbn) : null;
        const coreEnsure = coreId ? await ensureCoreInstalled(coreId, autoInstallCore) : null;
        if (coreEnsure && !coreEnsure.ok) {
          const rawForError = coreEnsure.installRaw ?? coreEnsure.listBeforeRaw ?? coreEnsure.listAfterRaw;
          return toToolResult(
            {
              ok: false,
              status: "error",
              command: "upload_and_wait_ready",
              stage: "core_install",
              errorCode: "CORE_INSTALL_FAILED",
              raw: rawForError,
              error:
                rawForError
                  ? withCliHint(
                      coreEnsure.error ?? `Required core "${coreId}" is not installed and could not be ensured.`,
                      rawForError
                    )
                  : coreEnsure.error ?? `Required core "${coreId}" is not installed and could not be ensured.`
            },
            true
          );
        }

        const uploadArgs = ["upload", resolvedSketchPath, "-p", port];
        if (fqbn) {
          uploadArgs.push("--fqbn", fqbn);
        }
        if (verify) {
          uploadArgs.push("--verify");
        }

        const uploadRaw = await runArduinoCli(arduinoConfig, uploadArgs, 300_000);
        if (!uploadRaw.ok) {
          return toToolResult(
            {
              ok: false,
              status: "error",
              command: "upload_and_wait_ready",
              stage: "upload",
              errorCode: "UPLOAD_FAILED",
              raw: uploadRaw,
              error: withCliHint("Sketch upload failed.", uploadRaw)
            },
            true
          );
        }

        let readyMatched = true;
        let readyRaw: CommandResult | null = null;
        if (readyPattern && readyPattern.trim().length > 0) {
          readyRaw = await runArduinoCli(
            arduinoConfig,
            ["monitor", "-p", port, "-c", `baudrate=${Math.floor(readyBaudRate)}`],
            Math.min(Math.max(readyTimeoutMs, 500), 120_000)
          );

          const serialText = `${readyRaw.stdout}\n${readyRaw.stderr}`;
          const needle = readyCaseSensitive ? readyPattern : readyPattern.toLowerCase();
          const haystack = readyCaseSensitive ? serialText : serialText.toLowerCase();
          readyMatched = haystack.includes(needle);
        }

        return toToolResult(
          {
            ok: readyMatched,
            status: readyMatched ? "ok" : "error",
            command: "upload_and_wait_ready",
            stage: readyPattern ? "wait_ready" : "upload",
            errorCode: readyMatched ? undefined : "READY_PATTERN_TIMEOUT",
            reasonCodes: safetyGate.skipped
              ? ["SAFETY_PREFLIGHT_SKIPPED"]
              : safetyGate.safety?.reasonCodes ?? undefined,
            data: {
              sketchPath: resolvedSketchPath,
              port,
              fqbn: fqbn ?? null,
              readyPattern: readyPattern ?? null,
              readyMatched,
              safety: safetyGate.skipped
                ? { skipped: true }
                : {
                    source: safetyGate.source,
                    confidenceType: safetyGate.confidenceType,
                    preflight: safetyGate.safety
                  }
            },
            rawTail: {
              stdout: readyRaw ? readyRaw.stdout.slice(-2000) : uploadRaw.stdout.slice(-2000),
              stderr: readyRaw ? readyRaw.stderr.slice(-2000) : uploadRaw.stderr.slice(-2000)
            },
            error: readyMatched
              ? undefined
              : "Upload succeeded but readiness pattern was not observed before timeout."
          },
          !readyMatched
        );
      } finally {
        portCoordinator.release(port, lockOwner);
      }
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "read_serial_snapshot",
  {
    title: "Read Serial Snapshot",
    description: "Capture serial output for a bounded duration from a given port.",
    inputSchema: {
      port: z.string().describe("Serial port path, e.g. COM6 or /dev/ttyACM0."),
      baudRate: z.number().int().positive().optional().describe("Baud rate. Default: 9600."),
      durationMs: z.number().int().min(500).max(60_000).optional().describe("Capture duration in ms.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ port, baudRate = 9600, durationMs = 4000 }) => {
    try {
      const lockOwner = `read_serial_snapshot:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const lock = acquirePortLockOrError(port, lockOwner, "read_serial_snapshot");
      if (!lock.ok) {
        return lock.toolResult;
      }

      try {
        const boundedDurationMs = Math.min(Math.max(durationMs, 500), 60_000);
        const raw = await runArduinoCli(
          arduinoConfig,
          ["monitor", "-p", port, "-c", `baudrate=${Math.floor(baudRate)}`],
          boundedDurationMs
        );

        const ok = raw.ok || raw.timedOut;
        return toToolResult(
          {
            ok,
            status: ok ? "ok" : "error",
            command: "monitor",
            stage: "serial_monitor_snapshot",
            errorCode: ok ? undefined : "SERIAL_MONITOR_FAILED",
            data: {
              port,
              baudRate,
              durationMs: boundedDurationMs
            },
            note: raw.timedOut
              ? "Capture stopped at timeout (expected for snapshot mode)."
              : "Monitor exited before timeout.",
            raw,
            error: ok ? undefined : withCliHint("Serial monitor failed.", raw)
          },
          !ok
        );
      } finally {
        portCoordinator.release(port, lockOwner);
      }
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "safety_preflight",
  {
    title: "Safety Preflight",
    description:
      "Run electrical preflight checks (voltage/current/pin risks) before upload or serial write operations.",
    inputSchema: {
      board: z.string().optional().describe("Board name/id (preferred when known)."),
      fqbn: z.string().optional().describe("Board FQBN when known."),
      port: z.string().optional().describe("Optional port for automatic board inference."),
      wiring: z
        .array(
          z.object({
            pin: z.string(),
            direction: z.enum(["input", "output", "bidirectional"]).optional(),
            signalType: z.enum(["digital", "analog", "i2c", "spi", "uart", "power", "ground", "other"]).optional(),
            voltage: z.number().optional(),
            currentMa: z.number().optional(),
            notes: z.string().optional()
          })
        )
        .optional(),
      power: z
        .object({
          supplyVoltage: z.number().optional(),
          totalCurrentMa: z.number().optional(),
          supplyThrough: z.enum(["usb", "vin", "5v_pin", "3v3_pin", "gpio_pin", "unknown"]).optional()
        })
        .optional()
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ board, fqbn, port, wiring, power }) => {
    try {
      const resolved = await resolveBoardForSafety(
        {
          board,
          fqbn,
          wiring,
          power
        },
        port
      );
      if (!resolved.board) {
        return toToolResult(
          {
            ok: false,
            status: "error",
            command: "safety_preflight",
            stage: "resolve_board",
            errorCode: "BOARD_UNKNOWN",
            reasonCodes: ["BOARD_UNKNOWN"],
            error:
              "Could not resolve board reference for safety checks. Provide board or fqbn, or pass port for inference.",
            data: {
              board: board ?? null,
              fqbn: fqbn ?? null,
              port: port ?? null
            },
            nextActions: [
              "Run detect_hardware and pass selected board/fqbn.",
              "Use search_board_reference to find a matching board id."
            ]
          },
          true
        );
      }

      const preflight = runSafetyPreflight({
        board: resolved.board,
        wiring,
        power
      });

      return toToolResult(
        {
          ok: preflight.status !== "blocked",
          status:
            preflight.status === "blocked"
              ? "error"
              : preflight.status === "pass_with_warnings"
                ? "warning"
                : "ok",
          command: "safety_preflight",
          stage: "electrical_preflight",
          errorCode: preflight.status === "blocked" ? "SAFETY_PREFLIGHT_BLOCKED" : undefined,
          reasonCodes: preflight.reasonCodes,
          data: {
            source: resolved.source,
            confidenceType: resolved.confidenceType,
            note: resolved.note ?? null,
            preflight
          },
          nextActions: preflight.nextActions,
          error:
            preflight.status === "blocked"
              ? "Safety preflight blocked operation due to electrical risk findings."
              : undefined
        },
        preflight.status === "blocked"
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "serial_open_session",
  {
    title: "Serial Open Session",
    description: "Open a stateful serial monitor session with port lock ownership.",
    inputSchema: {
      port: z.string().describe("Serial port path, e.g. COM6 or /dev/ttyACM0."),
      baudRate: z.number().int().positive().optional().describe("Baud rate. Default: 9600."),
      ttlMs: z.number().int().min(5_000).max(600_000).optional().describe("Session lease TTL in ms."),
      maxBufferBytes: z
        .number()
        .int()
        .min(4096)
        .max(2_097_152)
        .optional()
        .describe("Max in-memory receive buffer.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ port, baudRate = 9600, ttlMs = 120_000, maxBufferBytes = 262_144 }) => {
    try {
      const result = await serialSessionManager.openSession({
        cliPath: arduinoConfig.cliPath,
        port,
        baudRate,
        ttlMs,
        maxBufferBytes
      });
      return toToolResult(
        {
          ok: result.ok,
          status: result.ok ? "ok" : "error",
          command: "serial_open_session",
          stage: "serial_session_open",
          errorCode: result.errorCode,
          retryable: result.retryable,
          reasonCodes: result.errorCode ? [result.errorCode] : undefined,
          data: {
            session: result.session ?? null,
            lockHeldBy: result.lockHeldBy ?? null
          },
          error: result.error
        },
        !result.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "serial_list_sessions",
  {
    title: "Serial List Sessions",
    description: "List active serial sessions and current port lock state.",
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const sessions = serialSessionManager.listSessions();
      return toToolResult({
        ok: true,
        status: "ok",
        command: "serial_list_sessions",
        data: {
          count: sessions.length,
          sessions,
          locks: portCoordinator.list()
        }
      });
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "serial_read",
  {
    title: "Serial Read",
    description: "Read buffered bytes from an open serial session.",
    inputSchema: {
      sessionId: z.string(),
      fromOffset: z.number().int().min(0).optional().describe("Read offset cursor. Defaults to current buffer start."),
      maxBytes: z.number().int().min(1).max(1_048_576).optional().describe("Maximum bytes to return."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Output encoding. Default: utf8.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ sessionId, fromOffset, maxBytes = 8192, encoding = "utf8" }) => {
    try {
      const result = serialSessionManager.readSession(sessionId, fromOffset ?? null, maxBytes, encoding);
      return toToolResult(
        {
          ok: result.ok,
          status: result.ok ? "ok" : "error",
          command: "serial_read",
          stage: "serial_session_read",
          errorCode: result.errorCode,
          reasonCodes: result.errorCode ? [result.errorCode] : undefined,
          data: result.ok
            ? {
                session: result.session,
                chunk: {
                  data: result.data,
                  encoding: result.encoding,
                  bytesRead: result.bytesRead,
                  startOffset: result.startOffset,
                  nextOffset: result.nextOffset,
                  truncated: result.truncated
                }
              }
            : {
                session: result.session ?? null
              },
          error: result.error
        },
        !result.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "serial_expect",
  {
    title: "Serial Expect",
    description: "Wait for a string pattern in a serial session buffer with timeout.",
    inputSchema: {
      sessionId: z.string(),
      pattern: z.string().min(1),
      timeoutMs: z.number().int().min(200).max(120_000).optional(),
      caseSensitive: z.boolean().optional(),
      fromOffset: z.number().int().min(0).optional().describe("Optional explicit cursor offset.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ sessionId, pattern, timeoutMs = 10_000, caseSensitive = false, fromOffset }) => {
    try {
      const result = await serialSessionManager.expectInSession(
        sessionId,
        pattern,
        timeoutMs,
        caseSensitive,
        fromOffset ?? null
      );
      return toToolResult(
        {
          ok: result.ok,
          status: result.ok ? "ok" : "error",
          command: "serial_expect",
          stage: "serial_session_expect",
          errorCode: result.errorCode,
          reasonCodes: result.errorCode ? [result.errorCode] : undefined,
          data: {
            session: result.session ?? null,
            matched: result.matched ?? false,
            pattern: result.pattern ?? pattern,
            matchIndex: result.matchIndex ?? null,
            fromOffset: result.fromOffset ?? null,
            timeoutMs: result.timeoutMs ?? timeoutMs
          },
          error: result.error
        },
        !result.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "serial_write",
  {
    title: "Serial Write",
    description: "Write bytes to an open serial session. Safety preflight is enforced unless explicitly skipped.",
    inputSchema: {
      sessionId: z.string(),
      data: z.string().describe("Payload to send."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Payload encoding. Default: utf8."),
      lineEnding: z.enum(["none", "lf", "crlf"]).optional().describe("Optional line ending append."),
      unsafeSkipPreflight: z
        .boolean()
        .optional()
        .describe("If true, bypasses safety_preflight checks. Use only with explicit user acceptance."),
      safetyContext: z
        .object({
          board: z.string().optional(),
          fqbn: z.string().optional(),
          wiring: z
            .array(
              z.object({
                pin: z.string(),
                direction: z.enum(["input", "output", "bidirectional"]).optional(),
                signalType: z.enum(["digital", "analog", "i2c", "spi", "uart", "power", "ground", "other"]).optional(),
                voltage: z.number().optional(),
                currentMa: z.number().optional(),
                notes: z.string().optional()
              })
            )
            .optional(),
          power: z
            .object({
              supplyVoltage: z.number().optional(),
              totalCurrentMa: z.number().optional(),
              supplyThrough: z.enum(["usb", "vin", "5v_pin", "3v3_pin", "gpio_pin", "unknown"]).optional()
            })
            .optional()
        })
        .optional()
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ sessionId, data, encoding = "utf8", lineEnding = "none", unsafeSkipPreflight = false, safetyContext }) => {
    try {
      const session = serialSessionManager.getSessionSummary(sessionId);
      if (!session) {
        return toToolResult(
          {
            ok: false,
            status: "error",
            command: "serial_write",
            stage: "resolve_session",
            errorCode: "SESSION_NOT_FOUND",
            reasonCodes: ["SESSION_NOT_FOUND"],
            error: `No serial session found for id ${sessionId}.`
          },
          true
        );
      }

      const safetyGate = await runSafetyGate(
        {
          board: safetyContext?.board,
          fqbn: safetyContext?.fqbn,
          wiring: safetyContext?.wiring,
          power: safetyContext?.power
        },
        session.port,
        unsafeSkipPreflight
      );

      if (!safetyGate.ok) {
        return toToolResult(
          {
            ok: false,
            status: "error",
            command: "serial_write",
            stage: "preflight",
            errorCode: safetyGate.errorCode,
            reasonCodes: safetyGate.reasonCodes,
            error: safetyGate.error,
            data: {
              session,
              safetyContext: safetyContext ?? null
            },
            nextActions: [
              "Run safety_preflight with board/fqbn and wiring/power details.",
              "Use unsafeSkipPreflight=true only with explicit user risk acceptance."
            ]
          },
          true
        );
      }

      let payload: Buffer;
      try {
        payload = encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
      } catch (error) {
        return toToolResult(
          {
            ok: false,
            status: "error",
            command: "serial_write",
            stage: "decode_payload",
            errorCode: "INVALID_PAYLOAD_ENCODING",
            reasonCodes: ["INVALID_PAYLOAD_ENCODING"],
            error: error instanceof Error ? error.message : "Failed to decode payload."
          },
          true
        );
      }

      if (lineEnding === "lf") {
        payload = Buffer.concat([payload, Buffer.from("\n")]);
      } else if (lineEnding === "crlf") {
        payload = Buffer.concat([payload, Buffer.from("\r\n")]);
      }

      const result = serialSessionManager.writeSession(sessionId, payload);
      return toToolResult(
        {
          ok: result.ok,
          status: result.ok
            ? safetyGate.skipped
              ? "warning"
              : safetyGate.safety?.status === "pass_with_warnings"
                ? "warning"
                : "ok"
            : "error",
          command: "serial_write",
          stage: "serial_session_write",
          errorCode: result.errorCode,
          reasonCodes: safetyGate.skipped
            ? ["SAFETY_PREFLIGHT_SKIPPED"]
            : safetyGate.safety?.reasonCodes ?? undefined,
          data: {
            session: result.session ?? session,
            writtenBytes: result.writtenBytes ?? 0,
            safety: safetyGate.skipped
              ? { skipped: true }
              : {
                  source: safetyGate.source,
                  confidenceType: safetyGate.confidenceType,
                  preflight: safetyGate.safety
                }
          },
          error: result.error
        },
        !result.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "serial_close_session",
  {
    title: "Serial Close Session",
    description: "Close a serial session and release its port lock.",
    inputSchema: {
      sessionId: z.string()
    },
    outputSchema: toolOutputShape,
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ sessionId }) => {
    try {
      const result = serialSessionManager.closeSession(sessionId);
      return toToolResult(
        {
          ok: result.ok,
          status: result.ok ? "ok" : "error",
          command: "serial_close_session",
          stage: "serial_session_close",
          errorCode: result.errorCode,
          reasonCodes: result.errorCode ? [result.errorCode] : undefined,
          data: {
            session: result.session ?? null
          },
          error: result.error
        },
        !result.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "get_board_details",
  {
    title: "Get Board Details",
    description: "Get detailed board metadata from arduino-cli for a specific FQBN.",
    inputSchema: {
      fqbn: z.string().describe("Board FQBN, e.g. arduino:avr:uno.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ fqbn }) => {
    try {
      const raw = await runArduinoCli(arduinoConfig, ["board", "details", "--fqbn", fqbn, "--format", "json"]);
      const parsed = tryParseJson<unknown>(raw.stdout);
      return toToolResult(
        {
          ok: raw.ok,
          command: "board details",
          data: {
            fqbn,
            details: parsed
          },
          raw,
          error: raw.ok ? undefined : withCliHint("arduino-cli board details failed.", raw)
        },
        !raw.ok
      );
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "list_board_reference",
  {
    title: "List Board Reference",
    description: "List local board reference entries with pin/spec metadata.",
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const boards = listBoardReferences();
      return toToolResult({
        ok: true,
        data: {
          count: boards.length,
          boards
        }
      });
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerTool(
  "search_board_reference",
  {
    title: "Search Board Reference",
    description: "Search local board reference by board name, alias, id, or FQBN.",
    inputSchema: {
      query: z.string().min(1)
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ query }) => {
    try {
      const boards = findBoardReference(query);
      return toToolResult({
        ok: true,
        data: {
          query,
          count: boards.length,
          boards
        }
      });
    } catch (error) {
      return toUnhandledError(error);
    }
  }
);

server.registerResource(
  "arduino-board-reference",
  "arduino://boards/reference",
  {
    title: "Arduino Board Reference",
    description: "Static board pin/reference metadata for supported boards in this server.",
    mimeType: "application/json"
  },
  async (uri) => {
    const boards = listBoardReferences();
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(
            {
              version: "2026-02-28",
              count: boards.length,
              boards
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.registerPrompt(
  "arduino-cli-bootstrap-policy",
  {
    title: "Arduino CLI Bootstrap Policy",
    description: "Strict setup policy for agents when Arduino CLI is missing.",
    argsSchema: {
      platform: z.string().optional().describe("Optional platform hint, e.g. win32, darwin, linux.")
    }
  },
  async ({ platform }) => {
    const detectedPlatform = platform?.trim() || process.platform;
    const guide = getArduinoCliInstallGuide(process.platform);
    const envVarGuide = getEnvVarGuide();

    return {
      description: "Agent policy for bootstrapping Arduino CLI dependency.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Follow this strict policy:",
              "1) Run arduino_cli_doctor first.",
              "2) If installed=false, run install_arduino_cli with method=auto.",
              "3) If install_arduino_cli fails, then use manual install instructions.",
              "4) If binary is not on PATH, set ARDUINO_CLI_PATH.",
              "5) Re-run arduino_cli_doctor until installed=true.",
              "6) Only then run detect_hardware/compile/upload.",
              "7) Do not run fallback non-arduino-cli hardware scans.",
              "",
              `Platform hint: ${detectedPlatform}`,
              `Install guide: ${JSON.stringify(guide, null, 2)}`,
              `Env var guide: ${JSON.stringify(envVarGuide, null, 2)}`
            ].join("\n")
          }
        }
      ]
    };
  }
);

server.registerPrompt(
  "arduino-setup-assistant",
  {
    title: "Arduino Setup Assistant",
    description: "Prompt template for wiring/setup guidance based on board + sensor.",
    argsSchema: {
      board: z.string().describe("Board model, e.g. Arduino Uno R3."),
      sensor: z.string().describe("Sensor/module model, e.g. HC-SR04 or DHT22."),
      userGoal: z.string().optional().describe("What the user wants to achieve with the setup.")
    }
  },
  async ({ board, sensor, userGoal }) => {
    return {
      description: "Generate safe wiring + upload guidance for the user setup.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I have board: ${board}`,
              `I have sensor/module: ${sensor}`,
              userGoal ? `Goal: ${userGoal}` : "Goal: basic sensor readout.",
              "Provide:",
              "1) Required wiring connections with exact pin mapping.",
              "2) Voltage safety notes (3.3V vs 5V).",
              "3) Minimal Arduino sketch.",
              "4) Compile and upload steps using arduino-cli."
            ].join("\n")
          }
        }
      ]
    };
  }
);

async function main() {
  process.on("SIGINT", () => {
    serialSessionManager.dispose();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    serialSessionManager.dispose();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("arduino-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
