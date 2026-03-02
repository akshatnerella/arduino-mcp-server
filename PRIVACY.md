# Privacy Policy

Last updated: March 1, 2026

## Scope
This policy applies to the Arduino MCP Server extension and repository:
- https://github.com/akshatnerella/arduino-mcp-server

## Data Handling
- The extension runs locally and interacts with local tools (`arduino-cli`) and local serial ports.
- The extension does not include built-in telemetry, analytics, ad tracking, or remote data exfiltration.
- Tool input and output can include local file paths, board metadata, compile logs, and serial data produced by your connected hardware.

## Network Use
- The server itself does not require a remote backend service.
- Some Arduino CLI operations may reach upstream package indexes or downloads when you explicitly invoke install/update actions (for example core install/update).

## Data Sharing
- No extension-specific user data is intentionally shared with third parties by this project.
- Any data handling by your MCP host application (for example model provider logs) is governed by that host application's own privacy terms.

## Storage and Retention
- Runtime data is processed in memory during tool execution.
- Files produced by `arduino-cli` (for example build artifacts) are managed by local tooling and filesystem settings on your machine.

## User Controls
- You control when tools are invoked and what inputs are provided.
- You can restrict sketch operations with `ARDUINO_SKETCH_ROOT`.
- You can review source code and disable/uninstall the extension at any time.

## Contact
For privacy or security questions, open an issue:
- https://github.com/akshatnerella/arduino-mcp-server/issues
