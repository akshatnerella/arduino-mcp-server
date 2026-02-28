#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { findBoardReference, listBoardReferences } from "./boardReference.js";
import { resolveSketchPath, runArduinoCli, tryParseJson, type ArduinoCliConfig } from "./arduinoCli.js";

const arduinoConfig: ArduinoCliConfig = {
  cliPath: process.env.ARDUINO_CLI_PATH ?? "arduino-cli",
  sketchRoot: process.env.ARDUINO_SKETCH_ROOT
};

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
  command: z.string().optional(),
  data: z.unknown().optional(),
  raw: commandResultSchema.optional(),
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

const server = new McpServer({
  name: "arduino-mcp-server",
  version: "0.2.0"
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
          error: raw.ok ? undefined : "arduino-cli board list failed."
        },
        !raw.ok
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
          error: raw.ok ? undefined : "arduino-cli board listall failed."
        },
        !raw.ok
      );
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
          error: raw.ok ? undefined : "arduino-cli board list failed."
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
      warnings: z.enum(["none", "default", "more", "all"]).optional()
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ sketchPath, fqbn, exportBinaries, clean, buildPath, warnings }) => {
    try {
      const resolvedSketchPath = resolveSketchPath(sketchPath, arduinoConfig.sketchRoot);
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
            fqbn
          },
          raw,
          error: raw.ok ? undefined : "Sketch compilation failed."
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
      verify: z.boolean().optional().describe("Verify uploaded binary when supported.")
    },
    outputSchema: toolOutputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ sketchPath, port, fqbn, verify }) => {
    try {
      const resolvedSketchPath = resolveSketchPath(sketchPath, arduinoConfig.sketchRoot);
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
          command: "upload",
          data: {
            sketchPath: resolvedSketchPath,
            port,
            fqbn: fqbn ?? null
          },
          raw,
          error: raw.ok ? undefined : "Sketch upload failed."
        },
        !raw.ok
      );
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
          command: "monitor",
          data: {
            port,
            baudRate,
            durationMs: boundedDurationMs
          },
          note: raw.timedOut
            ? "Capture stopped at timeout (expected for snapshot mode)."
            : "Monitor exited before timeout.",
          raw,
          error: ok ? undefined : "Serial monitor failed."
        },
        !ok
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
          error: raw.ok ? undefined : "arduino-cli board details failed."
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("arduino-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
