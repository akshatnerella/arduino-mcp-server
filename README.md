# arduino-mcp-server
Arduino MCP server that wraps `arduino-cli` so AI agents can discover boards/ports, compile/upload sketches, read serial output, and query board pin references.

## Features
- MCP tools for:
  - listing connected boards and serial ports
  - listing supported boards
  - compiling sketches
  - uploading sketches
  - reading a serial snapshot (time-bounded monitor)
  - fetching `arduino-cli board details`
  - querying local board pin/reference metadata
- Structured JSON responses so agents can reason over output
- Optional sketch path sandboxing via `ARDUINO_SKETCH_ROOT`

## Requirements
- Node.js 20+
- `arduino-cli` installed and available on `PATH` (or set `ARDUINO_CLI_PATH`)

## Install
```bash
npm install
npm run build
```

## Run
```bash
npm start
```

For local development:

```bash
npm run dev
```

## Environment variables
- `ARDUINO_CLI_PATH`: path/command for Arduino CLI. Default: `arduino-cli`
- `ARDUINO_SKETCH_ROOT`: optional absolute path. When set, `sketchPath` inputs must resolve under this root.

## Example MCP client config (stdio)
Use your built `build/index.js` as the command target.

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["D:/Projects/arduino-mcp-server/build/index.js"],
      "env": {
        "ARDUINO_CLI_PATH": "arduino-cli",
        "ARDUINO_SKETCH_ROOT": "D:/Projects/arduino-sketches"
      }
    }
  }
}
```

## Board Reference Data
The server includes a starter board reference database at `data/board-reference.json` with common pin mappings.
You can expand this file or replace it with data from an external source later.

## MCP Capability Coverage
- Tools: compile/upload/monitor/board discovery and reference lookup
- Resource: `arduino://boards/reference` for board metadata
- Prompt: `arduino-setup-assistant` template for wiring/setup guidance