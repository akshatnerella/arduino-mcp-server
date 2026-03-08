# arduino-mcp-server

[![npm version](https://img.shields.io/npm/v/arduino-mcp-server)](https://www.npmjs.com/package/arduino-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Give your AI assistant full control over Arduino — compile, upload, monitor serial, and verify wiring safety, all through natural language.**

Part of the [HardwareMCP](https://github.com/hardware-mcp) ecosystem — open-source MCP servers that bridge AI to physical hardware.

---

## What this does

AI assistants can control Jira, GitHub, and databases. They can't talk to a microcontroller — until now.

`arduino-mcp-server` wraps `arduino-cli` into an MCP server so your AI can:

- **Detect** connected boards and ports automatically
- **Compile and upload** sketches without touching the terminal
- **Monitor serial output** with stateful sessions (open, read, expect, write, close)
- **Run electrical safety checks** before sending commands to hardware
- **Manage dependencies** — cores, libraries, and CLI installation

---

## Quick Start

**Install:**
```bash
npm install -g arduino-mcp-server
```

**Add to Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "arduino": {
      "command": "npx",
      "args": ["-y", "arduino-mcp-server"],
      "env": {
        "ARDUINO_CLI_PATH": "arduino-cli",
        "ARDUINO_SKETCH_ROOT": "/path/to/your/sketches"
      }
    }
  }
}
```

Requires [arduino-cli](https://arduino.github.io/arduino-cli/) on your PATH, or let the server install it for you.

---

## What you can say

**Bootstrap from scratch:**
> "Check if Arduino CLI is installed and set everything up for an Arduino Uno."

**Compile and upload:**
> "Compile my Blink sketch and upload it to the Uno on COM6."

**Serial monitoring:**
> "Open serial on COM6 at 115200 and wait until the device prints READY."

**Safety-first workflows:**
> "Run a safety preflight for an Arduino Uno with 5V on pin 13 at 25mA before I send commands."

---

## Tools

| Tool | What it does |
|------|-------------|
| `arduino_cli_doctor` | Check Arduino CLI installation and version |
| `install_arduino_cli` | Guide through arduino-cli installation |
| `detect_hardware` | Detect connected boards and infer FQBNs |
| `list_connected_boards` | List all connected Arduino boards |
| `list_serial_ports` | List available serial ports |
| `ensure_core_installed` | Check/install board cores |
| `compile_sketch` | Compile a sketch for a target board |
| `upload_sketch` | Upload compiled sketch to a board |
| `upload_and_wait_ready` | Upload and wait for device ready signal |
| `serial_open_session` | Open a stateful serial session |
| `serial_read` | Read buffered serial data |
| `serial_expect` | Wait for a pattern in serial output |
| `serial_write` | Send data over serial |
| `serial_close_session` | Close a serial session |
| `serial_list_sessions` | List active serial sessions |
| `read_serial_snapshot` | Quick one-shot serial read |
| `safety_preflight` | Electrical safety check before hardware ops |
| `get_board_details` | Get pin/capability details for a board |
| `list_supported_boards` | List all boards arduino-cli supports |
| `list_board_reference` | Browse board pin reference |
| `search_board_reference` | Search board reference by keyword |

**Resources:**
- `arduino://boards/reference` — structured board pin/capability reference

**Prompts:**
- `arduino-cli-bootstrap-policy` — policy for arduino-cli setup behavior
- `arduino-setup-assistant` — guided Arduino environment setup

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ARDUINO_CLI_PATH` | `arduino-cli` | Path to arduino-cli binary |
| `ARDUINO_SKETCH_ROOT` | *(none)* | Restrict sketch paths to this directory |

---

## Development

```bash
git clone https://github.com/hardware-mcp/arduino-mcp-server
cd arduino-mcp-server
npm install
npm run typecheck
npm run build
npm run dev
```

---

## Part of HardwareMCP

This server is part of the [HardwareMCP](https://github.com/hardware-mcp) ecosystem — a collection of MCP servers that give AI assistants real control over physical hardware.

---

## License

MIT — see [LICENSE](LICENSE).

## Support

[Open an issue](https://github.com/hardware-mcp/arduino-mcp-server/issues)
