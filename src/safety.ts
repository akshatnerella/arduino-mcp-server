import type { BoardReference, BoardPin } from "./boardReference.js";

export type SafetyStatus = "pass" | "pass_with_warnings" | "blocked";

export interface WiringSignal {
  pin: string;
  direction?: "input" | "output" | "bidirectional";
  signalType?: "digital" | "analog" | "i2c" | "spi" | "uart" | "power" | "ground" | "other";
  voltage?: number;
  currentMa?: number;
  notes?: string;
}

export interface PowerSpec {
  supplyVoltage?: number;
  totalCurrentMa?: number;
  supplyThrough?: "usb" | "vin" | "5v_pin" | "3v3_pin" | "gpio_pin" | "unknown";
}

export interface SafetyPreflightInput {
  board: BoardReference;
  wiring?: WiringSignal[];
  power?: PowerSpec;
}

export interface SafetyFinding {
  code: string;
  severity: "warning" | "error";
  message: string;
  pin?: string;
}

export interface SafetyPreflightResult {
  status: SafetyStatus;
  boardId: string;
  boardDisplayName: string;
  logicVoltage: number | null;
  pinCurrentLimitMa: number;
  totalCurrentLimitMa: number;
  findings: SafetyFinding[];
  reasonCodes: string[];
  nextActions: string[];
}

function parseVoltage(value: string): number | null {
  const match = value.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPinMap(board: BoardReference): Map<string, BoardPin> {
  const map = new Map<string, BoardPin>();
  for (const pin of board.digitalPins) {
    map.set(pin.name.trim().toUpperCase(), pin);
  }
  for (const pin of board.analogPins) {
    map.set(pin.name.trim().toUpperCase(), pin);
  }
  return map;
}

function inferPinCurrentLimit(board: BoardReference): number {
  if (board.id.includes("esp32")) {
    return 12;
  }
  return 20;
}

function inferTotalCurrentLimit(board: BoardReference): number {
  if (board.id.includes("mega")) {
    return 200;
  }
  if (board.id.includes("esp32")) {
    return 120;
  }
  return 100;
}

function listUartPins(board: BoardReference): Set<string> {
  const out = new Set<string>();
  for (const item of board.uart?.hardware ?? []) {
    for (const token of item.split(/[\\/]/)) {
      const normalized = token.trim().toUpperCase();
      if (normalized.length > 0) {
        out.add(normalized);
      }
    }
  }
  return out;
}

function addFinding(
  findings: SafetyFinding[],
  reasonCodes: Set<string>,
  finding: SafetyFinding,
  reasonCode: string
) {
  findings.push(finding);
  reasonCodes.add(reasonCode);
}

export function runSafetyPreflight(input: SafetyPreflightInput): SafetyPreflightResult {
  const findings: SafetyFinding[] = [];
  const reasonCodes = new Set<string>();
  const nextActions: string[] = [];

  const board = input.board;
  const wiring = input.wiring ?? [];
  const power = input.power;
  const logicVoltage = parseVoltage(board.logicVoltage);
  const pinCurrentLimitMa = inferPinCurrentLimit(board);
  const totalCurrentLimitMa = inferTotalCurrentLimit(board);

  const pinMap = buildPinMap(board);
  const uartPins = listUartPins(board);

  if (wiring.length === 0) {
    addFinding(
      findings,
      reasonCodes,
      {
        code: "WIRING_NOT_PROVIDED",
        severity: "warning",
        message: "No wiring signals were provided. Safety checks were limited."
      },
      "WIRING_INCOMPLETE"
    );
    nextActions.push("Provide wiring[] with pin, direction, voltage, and current for stronger safety validation.");
  }

  let sumCurrentMa = 0;
  for (const signal of wiring) {
    const normalizedPin = signal.pin.trim().toUpperCase();
    const pinDef = pinMap.get(normalizedPin);
    if (!pinDef) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "PIN_UNKNOWN",
          severity: "error",
          pin: normalizedPin,
          message: `Pin ${normalizedPin} is not known for board ${board.displayName}.`
        },
        "PIN_UNKNOWN"
      );
      continue;
    }

    const caps = new Set((pinDef.capabilities ?? []).map((cap) => cap.toUpperCase()));

    if (
      typeof signal.voltage === "number" &&
      logicVoltage !== null &&
      signal.signalType !== "ground" &&
      signal.signalType !== "power" &&
      signal.voltage > logicVoltage + 0.3
    ) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "VOLTAGE_EXCEEDS_LOGIC",
          severity: "error",
          pin: normalizedPin,
          message: `Signal voltage ${signal.voltage}V exceeds board logic voltage ${logicVoltage}V on ${normalizedPin}.`
        },
        "VOLTAGE_MISMATCH"
      );
    }

    if (typeof signal.currentMa === "number" && signal.currentMa > 0) {
      sumCurrentMa += signal.currentMa;
      if (signal.currentMa > pinCurrentLimitMa) {
        addFinding(
          findings,
          reasonCodes,
          {
            code: "CURRENT_EXCEEDS_PIN_LIMIT",
            severity: "error",
            pin: normalizedPin,
            message: `Signal current ${signal.currentMa}mA exceeds conservative per-pin limit ${pinCurrentLimitMa}mA.`
          },
          "CURRENT_LIMIT_EXCEEDED"
        );
      }
    }

    if (caps.has("INPUT_ONLY") && (signal.direction === "output" || signal.direction === "bidirectional")) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "INPUT_ONLY_PIN_DRIVE",
          severity: "error",
          pin: normalizedPin,
          message: `${normalizedPin} is input-only and should not be driven as output.`
        },
        "INPUT_ONLY_PIN"
      );
    }

    if (
      caps.has("BOOT_STRAP") &&
      (signal.direction === "output" || signal.direction === "bidirectional" || signal.signalType === "power")
    ) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "BOOT_STRAP_PIN_USED",
          severity: "warning",
          pin: normalizedPin,
          message: `${normalizedPin} is a boot/strap pin. External drive can break boot mode.`
        },
        "BOOT_STRAP_RISK"
      );
      nextActions.push(`Avoid driving ${normalizedPin} at boot time or add appropriate pull resistor strategy.`);
    }

    if (uartPins.has(normalizedPin) && signal.signalType !== "uart" && signal.signalType !== "ground") {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "UART_PIN_REUSED",
          severity: "warning",
          pin: normalizedPin,
          message: `${normalizedPin} is a hardware UART pin and may conflict with upload/serial monitor.`
        },
        "UART_CONFLICT"
      );
    }
  }

  if (sumCurrentMa > totalCurrentLimitMa) {
    addFinding(
      findings,
      reasonCodes,
      {
        code: "TOTAL_CURRENT_EXCEEDS_LIMIT",
        severity: "error",
        message: `Estimated signal current ${sumCurrentMa}mA exceeds conservative total IO limit ${totalCurrentLimitMa}mA.`
      },
      "TOTAL_CURRENT_EXCEEDED"
    );
    nextActions.push("Use external drivers/transistors or separate sensor power rails for high current loads.");
  }

  if (!power) {
    addFinding(
      findings,
      reasonCodes,
      {
        code: "POWER_NOT_PROVIDED",
        severity: "warning",
        message: "No power configuration was provided. Supply checks were limited."
      },
      "POWER_INCOMPLETE"
    );
    nextActions.push("Provide power.supplyVoltage and power.supplyThrough for stricter power checks.");
  } else {
    if (power.supplyThrough === "gpio_pin") {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "GPIO_POWER_SOURCE",
          severity: "error",
          message: "Supplying board power through a GPIO pin is unsafe."
        },
        "UNSAFE_POWER_SOURCE"
      );
    }

    if (
      typeof power.supplyVoltage === "number" &&
      power.supplyThrough === "3v3_pin" &&
      power.supplyVoltage > 3.6
    ) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "SUPPLY_EXCEEDS_3V3",
          severity: "error",
          message: `Supply voltage ${power.supplyVoltage}V is too high for 3.3V rail input.`
        },
        "SUPPLY_VOLTAGE_HIGH"
      );
    }

    if (
      typeof power.supplyVoltage === "number" &&
      power.supplyThrough === "5v_pin" &&
      power.supplyVoltage > 5.5
    ) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "SUPPLY_EXCEEDS_5V",
          severity: "error",
          message: `Supply voltage ${power.supplyVoltage}V is too high for 5V rail input.`
        },
        "SUPPLY_VOLTAGE_HIGH"
      );
    }

    if (typeof power.totalCurrentMa === "number" && power.totalCurrentMa > totalCurrentLimitMa) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "POWER_CURRENT_HIGH",
          severity: "warning",
          message: `Total current estimate ${power.totalCurrentMa}mA is high versus conservative board IO budget ${totalCurrentLimitMa}mA.`
        },
        "POWER_CURRENT_HIGH"
      );
    }
  }

  const hasErrors = findings.some((finding) => finding.severity === "error");
  const status: SafetyStatus = hasErrors
    ? "blocked"
    : findings.length > 0
      ? "pass_with_warnings"
      : "pass";

  if (status === "blocked") {
    nextActions.push("Resolve all error findings before upload or serial write operations.");
  }

  return {
    status,
    boardId: board.id,
    boardDisplayName: board.displayName,
    logicVoltage,
    pinCurrentLimitMa,
    totalCurrentLimitMa,
    findings,
    reasonCodes: Array.from(reasonCodes.values()),
    nextActions
  };
}
