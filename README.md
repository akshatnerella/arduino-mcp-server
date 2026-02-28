# Arduino MCP Server

Arduino MCP server for `arduino-cli` workflows: dependency checks/install, hardware detection, compile/upload, serial monitoring, and board reference lookup.

## Quick Start
Install globally:

```bash
npm install -g arduino-mcp-server
```

Add to your AI agent MCP config.

Claude Desktop (`claude_desktop_config.json`):

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

Codex MCP config:

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

## Features
- `arduino_cli_doctor` and `install_arduino_cli` for dependency bootstrap
- `detect_hardware` with board/FQBN inference and user-confirmation guidance
- `ensure_core_installed` with automatic core setup from FQBN
- `compile_sketch` and `upload_sketch` with optional auto core install
- Serial monitoring and board/port listing tools
- Local board reference resource and setup prompts

## Requirements
- Node.js 20+
- `arduino-cli` available on `PATH` (or let the server install it via tools)

## Configuration
- `ARDUINO_CLI_PATH`: Arduino CLI command/path (default: `arduino-cli`)
- `ARDUINO_SKETCH_ROOT`: optional absolute root for sketch operations

## MCP Surface
Tools:
- `arduino_cli_doctor`
- `install_arduino_cli`
- `detect_hardware`
- `ensure_core_installed`
- `compile_sketch`
- `upload_sketch`
- `read_serial_snapshot`
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
