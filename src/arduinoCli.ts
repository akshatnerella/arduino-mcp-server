import { spawn } from "node:child_process";
import path from "node:path";

export interface CommandResult {
  ok: boolean;
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ArduinoCliConfig {
  cliPath: string;
  sketchRoot?: string;
}

export function resolveSketchPath(inputPath: string, sketchRoot?: string): string {
  const resolved = path.resolve(inputPath);

  if (!sketchRoot) {
    return resolved;
  }

  const root = path.resolve(sketchRoot);
  const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;

  if (normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return resolved;
  }

  throw new Error(`Path "${resolved}" is outside ARDUINO_SKETCH_ROOT "${root}".`);
}

export async function runArduinoCli(
  config: ArduinoCliConfig,
  args: string[],
  timeoutMs = 60_000
): Promise<CommandResult> {
  return runCommand(config.cliPath, args, timeoutMs);
}

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 60_000
): Promise<CommandResult> {
  const started = Date.now();

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - started;
      resolve({
        ok: false,
        command,
        args,
        code: null,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        timedOut: false,
        durationMs
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      resolve({
        ok: code === 0 && !timedOut,
        command,
        args,
        code,
        stdout,
        stderr,
        timedOut,
        durationMs
      });
    });
  });
}

export function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
