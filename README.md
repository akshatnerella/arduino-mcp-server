# arduino-mcp-server
Arduino MCP server that wraps `arduino-cli` so AI agents can discover boards/ports, compile/upload sketches, read serial output, and query board pin references.

## Features
- MCP tools for:
  - listing connected boards and serial ports
  - detecting connected hardware with inferred FQBN and next commands
  - checking `arduino-cli` availability with OS-specific install guidance (`arduino_cli_doctor`)
  - auto-installing `arduino-cli` when missing (`install_arduino_cli`)
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

## Agent Workflow Contract
Use this workflow in AI agents:
1. Call `arduino_cli_doctor` first.
2. If `installed=false`, call `install_arduino_cli` with `{"method":"auto"}`.
3. If auto-install fails, use the returned OS-specific `installGuide`.
4. Set `ARDUINO_CLI_PATH` if the binary is not on `PATH`.
5. Re-run `arduino_cli_doctor` and continue only when `installed=true`.
6. Only then call `detect_hardware`, `compile_sketch`, `upload_sketch`, etc.

Do not attempt fallback hardware scans before `arduino-cli` is available.

When `detect_hardware` returns unresolved/non-standard board matches, the tool now includes
`requiresUserBoardConfirmation` and an `agentAction` question payload. Agents should ask the user
to confirm board model/FQBN before continuing.

## Install Arduino CLI Quickly
Official docs: https://docs.arduino.cc/arduino-cli/installation/

- Windows (recommended): `winget install ArduinoSA.CLI`
- macOS: `brew install arduino-cli`
- Linux: `brew install arduino-cli` or official install script

If needed, set `ARDUINO_CLI_PATH`:
- PowerShell (current session): `$env:ARDUINO_CLI_PATH='C:\\path\\to\\arduino-cli.exe'`
- Bash/Zsh (current session): `export ARDUINO_CLI_PATH=/absolute/path/to/arduino-cli`

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
- Prompts:
  - `arduino-cli-bootstrap-policy` for dependency/bootstrap behavior
  - `arduino-setup-assistant` for wiring/setup guidance
