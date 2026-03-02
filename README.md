# Arduino MCP Server

Arduino MCP server for `arduino-cli` workflows: dependency checks/install, hardware detection, compile/upload, serial monitoring, board reference lookup, and safety preflight checks.

This repository includes:
- `server.json` for MCP Registry metadata.
- `manifest.json` for Claude Desktop MCP bundle (`.mcpb`) packaging.

## Description
Use this server to automate Arduino setup and development tasks from an MCP client while keeping operations local to your machine.

## Features
- Arduino CLI dependency diagnosis and guided installation
- Board/port detection with FQBN inference
- Core installation checks and optional auto-install
- Sketch compile/upload workflows
- Upload-and-wait serial readiness flow
- Stateful serial sessions (`open`, `read`, `expect`, `write`, `close`)
- Electrical safety preflight checks
- Board reference resource and setup prompts

## Requirements
- Node.js 20+
- `arduino-cli` on `PATH`, or install/configure it through provided tools

## Installation
Install from npm:

```bash
npm install -g arduino-mcp-server
```

Add to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "arduino": {
      "command": "npx",
      "args": ["-y", "arduino-mcp-server"],
      "env": {
        "ARDUINO_CLI_PATH": "arduino-cli",
        "ARDUINO_SKETCH_ROOT": "D:/Projects/arduino-sketches"
      }
    }
  }
}
```

## Configuration
- `ARDUINO_CLI_PATH`: Arduino CLI command/path (default: `arduino-cli`)
- `ARDUINO_SKETCH_ROOT`: optional absolute root restricting sketch compile/upload paths

## Usage Examples
Example 1: Bootstrap missing Arduino CLI

User prompt:
```text
Check if Arduino CLI is installed and install it automatically if missing.
```

Expected tool sequence:
1. `arduino_cli_doctor`
2. `install_arduino_cli` (when missing)
3. `arduino_cli_doctor` (re-check)

Example 2: Compile and upload a sketch

User prompt:
```text
Compile D:/Projects/arduino-sketches/Blink for arduino:avr:uno and upload it to COM6.
```

Expected tool sequence:
1. `compile_sketch` with sketch path + fqbn
2. `upload_sketch` with sketch path + fqbn + port

Example 3: Open serial monitor session and wait for ready text

User prompt:
```text
Open serial on COM6 at 115200 and wait until the device prints READY.
```

Expected tool sequence:
1. `serial_open_session`
2. `serial_expect`
3. `serial_read` (optional for additional output)
4. `serial_close_session` (when done)

Example 4: Safety preflight before writing to device

User prompt:
```text
Before sending commands over serial, run a safety preflight for an Arduino Uno with my wiring details.
```

Expected tool sequence:
1. `safety_preflight`
2. `serial_write` only if preflight does not block

## MCP Surface
Tools:
- `arduino_cli_doctor`
- `install_arduino_cli`
- `detect_hardware`
- `ensure_core_installed`
- `compile_sketch`
- `upload_sketch`
- `upload_and_wait_ready`
- `read_serial_snapshot`
- `safety_preflight`
- `serial_open_session`
- `serial_list_sessions`
- `serial_read`
- `serial_expect`
- `serial_write`
- `serial_close_session`
- `list_connected_boards`
- `list_supported_boards`
- `list_serial_ports`
- `get_board_details`
- `list_board_reference`
- `search_board_reference`

Resources:
- `arduino://boards/reference`

Prompts:
- `arduino-cli-bootstrap-policy`
- `arduino-setup-assistant`

## MCP Bundle (MCPB)
Build and package:

```bash
npm run build
npm run mcpb:validate
npm run mcpb:pack
```

Notes:
- `manifest.json` is consumed by `mcpb`.
- `.mcpbignore` excludes dev/reference files from bundle packaging.
- Bundle output is written as `<name>.mcpb` in the current directory by default.

## Privacy Policy
- Policy URL: https://github.com/akshatnerella/arduino-mcp-server/blob/main/PRIVACY.md
- Local copy: [PRIVACY.md](PRIVACY.md)

Summary:
- No built-in telemetry or analytics.
- Operations are local unless you explicitly invoke tooling that downloads dependencies.
- Data handling by your MCP host application is governed by that host's policies.

## Support
- GitHub Issues: https://github.com/akshatnerella/arduino-mcp-server/issues

## Development
```bash
git clone https://github.com/akshatnerella/arduino-mcp-server
cd arduino-mcp-server
npm install
npm run typecheck
npm run build
npm run dev
```

## Release
- PRs into `main` must come from `release/*` branches.
- PRs must include exactly one bump label: `patch`, `minor`, or `major`.

## License
MIT, see [LICENSE](LICENSE).