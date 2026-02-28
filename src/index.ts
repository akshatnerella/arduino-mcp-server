import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { findBoardReference, listBoardReferences } from "./boardReference.js";
import { resolveSketchPath, runArduinoCli, tryParseJson, type ArduinoCliConfig } from "./arduinoCli.js";

type JsonObject = Record<string, unknown>;

const arduinoConfig: ArduinoCliConfig = {
  cliPath: process.env.ARDUINO_CLI_PATH ?? "arduino-cli",
  sketchRoot: process.env.ARDUINO_SKETCH_ROOT
};

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_connected_boards",
    description: "List connected boards and ports detected by arduino-cli.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "list_supported_boards",
    description: "List installable/supported boards from arduino-cli board index.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: {
          type: "string",
          description: "Optional case-insensitive filter over board name/FQBN."
        }
      }
    }
  },
  {
    name: "list_serial_ports",
    description: "List serial ports and any detected board metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "compile_sketch",
    description: "Compile an Arduino sketch with arduino-cli.",
    inputSchema: {
      type: "object",
      required: ["sketchPath", "fqbn"],
      additionalProperties: false,
      properties: {
        sketchPath: {
          type: "string",
          description: "Path to the sketch directory or .ino file."
        },
        fqbn: {
          type: "string",
          description: "Board FQBN, e.g. arduino:avr:uno."
        },
        exportBinaries: {
          type: "boolean",
          description: "If true, export binaries to the sketch folder."
        },
        clean: {
          type: "boolean",
          description: "If true, clean build cache before compiling."
        },
        buildPath: {
          type: "string",
          description: "Optional build output directory."
        },
        warnings: {
          type: "string",
          enum: ["none", "default", "more", "all"],
          description: "Compiler warnings level."
        }
      }
    }
  },
  {
    name: "upload_sketch",
    description: "Upload a sketch to a connected board with arduino-cli.",
    inputSchema: {
      type: "object",
      required: ["sketchPath", "port"],
      additionalProperties: false,
      properties: {
        sketchPath: {
          type: "string",
          description: "Path to the sketch directory or .ino file."
        },
        port: {
          type: "string",
          description: "Serial port path, e.g. COM6 or /dev/ttyACM0."
        },
        fqbn: {
          type: "string",
          description: "Optional FQBN (recommended when board is not auto-detected)."
        },
        verify: {
          type: "boolean",
          description: "If true, verify uploaded binary when supported."
        }
      }
    }
  },
  {
    name: "read_serial_snapshot",
    description:
      "Read serial output for a fixed duration. Runs arduino-cli monitor and stops after timeout.",
    inputSchema: {
      type: "object",
      required: ["port"],
      additionalProperties: false,
      properties: {
        port: {
          type: "string",
          description: "Serial port path, e.g. COM6 or /dev/ttyACM0."
        },
        baudRate: {
          type: "number",
          description: "Baud rate, default 9600."
        },
        durationMs: {
          type: "number",
          description: "Capture duration in milliseconds, default 4000."
        }
      }
    }
  },
  {
    name: "get_board_details",
    description: "Get detailed board metadata from arduino-cli for a specific FQBN.",
    inputSchema: {
      type: "object",
      required: ["fqbn"],
      additionalProperties: false,
      properties: {
        fqbn: {
          type: "string",
          description: "Board FQBN, e.g. arduino:avr:uno."
        }
      }
    }
  },
  {
    name: "list_board_reference",
    description: "List local board reference entries with pin/spec metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "search_board_reference",
    description: "Search local board reference by board name, alias, id, or FQBN.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string"
        }
      }
    }
  }
];

function asObject(args: unknown): JsonObject {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  return args as JsonObject;
}

function getString(args: JsonObject, key: string, required = false): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (required) {
    throw new Error(`Missing required string parameter "${key}".`);
  }
  return undefined;
}

function getBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function getNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ok(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toolError(message: string, details?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            error: message,
            details
          },
          null,
          2
        )
      }
    ]
  };
}

async function handleToolCall(request: CallToolRequest) {
  const name = request.params.name;
  const args = asObject(request.params.arguments);

  try {
    switch (name) {
      case "list_connected_boards": {
        const result = await runArduinoCli(arduinoConfig, ["board", "list", "--format", "json"]);
        const parsed = tryParseJson<unknown>(result.stdout);
        return ok({
          ok: result.ok,
          command: "board list",
          parsed,
          raw: result
        });
      }

      case "list_supported_boards": {
        const search = getString(args, "search");
        const result = await runArduinoCli(arduinoConfig, ["board", "listall", "--format", "json"], 120_000);
        const parsed = tryParseJson<unknown[]>(result.stdout);

        let filtered = parsed;
        if (search && Array.isArray(parsed)) {
          const q = search.toLowerCase();
          filtered = parsed.filter((entry) => JSON.stringify(entry).toLowerCase().includes(q));
        }

        return ok({
          ok: result.ok,
          command: "board listall",
          count: Array.isArray(filtered) ? filtered.length : undefined,
          parsed: filtered,
          raw: result
        });
      }

      case "list_serial_ports": {
        const result = await runArduinoCli(arduinoConfig, ["board", "list", "--format", "json"]);
        const parsed = tryParseJson<unknown>(result.stdout);
        return ok({
          ok: result.ok,
          command: "board list",
          parsed,
          raw: result
        });
      }

      case "compile_sketch": {
        const sketchPath = resolveSketchPath(getString(args, "sketchPath", true)!, arduinoConfig.sketchRoot);
        const fqbn = getString(args, "fqbn", true)!;
        const buildPathRaw = getString(args, "buildPath");
        const warnings = getString(args, "warnings");

        const cliArgs = ["compile", sketchPath, "--fqbn", fqbn];
        if (buildPathRaw) {
          cliArgs.push("--build-path", resolveSketchPath(buildPathRaw, arduinoConfig.sketchRoot));
        }
        if (getBoolean(args, "exportBinaries")) {
          cliArgs.push("--export-binaries");
        }
        if (getBoolean(args, "clean")) {
          cliArgs.push("--clean");
        }
        if (warnings) {
          cliArgs.push("--warnings", warnings);
        }

        const result = await runArduinoCli(arduinoConfig, cliArgs, 300_000);
        return ok({
          ok: result.ok,
          command: "compile",
          sketchPath,
          fqbn,
          raw: result
        });
      }

      case "upload_sketch": {
        const sketchPath = resolveSketchPath(getString(args, "sketchPath", true)!, arduinoConfig.sketchRoot);
        const port = getString(args, "port", true)!;
        const fqbn = getString(args, "fqbn");

        const cliArgs = ["upload", sketchPath, "-p", port];
        if (fqbn) {
          cliArgs.push("--fqbn", fqbn);
        }
        if (getBoolean(args, "verify")) {
          cliArgs.push("--verify");
        }

        const result = await runArduinoCli(arduinoConfig, cliArgs, 300_000);
        return ok({
          ok: result.ok,
          command: "upload",
          sketchPath,
          port,
          fqbn,
          raw: result
        });
      }

      case "read_serial_snapshot": {
        const port = getString(args, "port", true)!;
        const baudRate = getNumber(args, "baudRate") ?? 9600;
        const durationMs = Math.min(Math.max(getNumber(args, "durationMs") ?? 4000, 500), 60_000);
        const result = await runArduinoCli(
          arduinoConfig,
          ["monitor", "-p", port, "-c", `baudrate=${Math.floor(baudRate)}`],
          durationMs
        );

        return ok({
          ok: result.ok || result.timedOut,
          command: "monitor",
          port,
          baudRate,
          durationMs,
          note: result.timedOut
            ? "Capture stopped at duration timeout (expected behavior)."
            : "Monitor exited before timeout.",
          raw: result
        });
      }

      case "get_board_details": {
        const fqbn = getString(args, "fqbn", true)!;
        const result = await runArduinoCli(arduinoConfig, ["board", "details", "--fqbn", fqbn, "--format", "json"]);
        const parsed = tryParseJson<unknown>(result.stdout);
        return ok({
          ok: result.ok,
          command: "board details",
          fqbn,
          parsed,
          raw: result
        });
      }

      case "list_board_reference": {
        const boards = listBoardReferences();
        return ok({
          ok: true,
          count: boards.length,
          boards
        });
      }

      case "search_board_reference": {
        const query = getString(args, "query", true)!;
        const boards = findBoardReference(query);
        return ok({
          ok: true,
          query,
          count: boards.length,
          boards
        });
      }

      default:
        return toolError(`Unknown tool "${name}".`);
    }
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Unhandled error.", error);
  }
}

async function main() {
  const server = new Server(
    {
      name: "arduino-mcp-server",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, handleToolCall);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start arduino-mcp-server:", error);
  process.exit(1);
});
