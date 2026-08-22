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

## Safety preflight guardrails

`safety_preflight` (and the `safetyContext` passed to `upload_sketch`, `upload_and_wait_ready`, and `serial_write`) now also covers battery and ESP32-family pin footguns, driven by small, extensible data tables rather than hardcoded to any one board:

**Battery charge-rate (C-rate) check** — pass a `battery` object (`capacityMah`, `chargeCurrentMa`, `chemistry`) and the check computes `chargeCurrentMa / batteryCapacityMah` and flags it:
- **`BATTERY_CRATE_UNSAFE`** (hard, blocking) above 1C
- **`BATTERY_CRATE_CAUTION`** (soft, non-blocking) above 0.5C

Generic small LiPo cells are commonly rated for roughly a 0.5–1C safe charge current, so the message spells out the math, e.g. *"380mA into a 100mAh cell is a 3.8C rate — well above the ~0.5-1C safe range for typical small LiPo cells; verify your cell's actual rated charge current before proceeding."* If `chargeCurrentMa` is omitted, it's inferred from a small board → onboard-charge-IC lookup table (currently seeded with Seeed XIAO ESP32S3, XIAO ESP32S3 Sense, and XIAO ESP32C3 — see `data/battery-charge-ic-reference.json`, easy to extend with more boards). These are approximate, manufacturer-published figures — verify against the live datasheet/wiki for your exact board revision before trusting them in a production workflow.

**Battery polarity confirmation** — when `battery.connecting: true` (or any battery field is set) but `battery.polarityConfirmed` isn't explicitly `true`, the preflight blocks with `BATTERY_POLARITY_UNCONFIRMED` and a reminder to never assume BAT+/BAT- from wire color. On Seeed XIAO boards it cites the official convention: the negative pad is closest to the USB-C port, positive is farthest from it.

**ESP32-family pin safety** (table-driven per board via `data/board-reference.json`):
- **SPI-flash pins** (GPIO6-11 on classic ESP32 WROOM/WROVER modules) — hard error (`SPI_FLASH_PIN_USED`); wiring these prevents boot.
- **Boot-strapping pins** (GPIO0/2/12/15 on classic ESP32) — caution; usable at runtime but risky if externally held during boot/reset (existing check).
- **Input-only pins with no internal pull resistor** (GPIO34-39 on classic ESP32) — caution (`NO_INTERNAL_PULL_PIN`); add an external pull-up/pull-down if using them as buttons/switches.
- **Seeed XIAO ESP32S3** — modeled with its 11 usable GPIO (D0-D10), default I2C on D4/D5, and an informational note surfaced whenever D6/D7 are wired: they're hardware UART1 TX/RX by default, but enabling "USB CDC on Boot" frees them as plain GPIO.

Board data for all of the above lives in JSON, keyed by board id/FQBN, so more boards can be added without touching guardrail logic.

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
npm test
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
