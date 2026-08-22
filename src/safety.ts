import type { BoardReference, BoardPin } from "./boardReference.js";
import { findChargeIcReference } from "./batteryReference.js";

export type SafetyStatus = "pass" | "pass_with_warnings" | "blocked";

/**
 * A LiPo/Li-ion charge rate above 1C is treated as a hard warning (blocking):
 * generic small LiPo cells are commonly rated for roughly 0.5-1C safe charge
 * current, and charging materially above that risks cell swelling, venting,
 * or fire. Anything above 0.5C but at/below 1C is a softer caution: still
 * worth double-checking the cell's actual rating, but within the range many
 * small cells tolerate.
 */
export const LIPO_CRATE_HARD_WARNING_THRESHOLD = 1;
export const LIPO_CRATE_SOFT_CAUTION_THRESHOLD = 0.5;

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

export interface BatterySpec {
  /** Rated capacity of the connected cell, in mAh. */
  capacityMah?: number;
  /**
   * Charge current the battery will actually see, in mA. If omitted and the
   * board has a known onboard charge IC (see batteryReference.ts), the
   * board's published fast-charge current is used as a default so the
   * C-rate check still runs -- override this when using a different/external
   * charger.
   */
  chargeCurrentMa?: number;
  chemistry?: "lipo" | "li-ion" | "other";
  /** Set true when this preflight covers a battery-connection or first-power-on step. */
  connecting?: boolean;
  /**
   * Explicit confirmation that BAT+/BAT- polarity was verified against the
   * board's documentation (never assume from wire color). Required before
   * a battery-connection step can pass cleanly.
   */
  polarityConfirmed?: boolean;
}

export interface SafetyPreflightInput {
  board: BoardReference;
  wiring?: WiringSignal[];
  power?: PowerSpec;
  battery?: BatterySpec;
}

export interface BatteryAssessment {
  capacityMah: number | null;
  chargeCurrentMa: number | null;
  chargeCurrentSource: "user_supplied" | "board_charge_ic" | null;
  cRate: number | null;
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
  battery: BatteryAssessment | null;
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

/**
 * Compute a LiPo/Li-ion charge C-rate: chargeCurrentMa / batteryCapacityMah.
 * A cell's "1C" charge current numerically equals its capacity in mAh (e.g.
 * 1C for a 100mAh cell is 100mA); charging above 1C exceeds what generic
 * small LiPo cells are typically rated for.
 */
export function computeChargeCRate(batteryCapacityMah: number, chargeCurrentMa: number): number {
  if (!Number.isFinite(batteryCapacityMah) || batteryCapacityMah <= 0) {
    throw new Error("batteryCapacityMah must be a finite number greater than 0");
  }
  if (!Number.isFinite(chargeCurrentMa) || chargeCurrentMa < 0) {
    throw new Error("chargeCurrentMa must be a finite number greater than or equal to 0");
  }
  return chargeCurrentMa / batteryCapacityMah;
}

function assessBattery(
  battery: BatterySpec | undefined,
  board: BoardReference,
  findings: SafetyFinding[],
  reasonCodes: Set<string>,
  nextActions: string[]
): BatteryAssessment | null {
  if (!battery) {
    return null;
  }

  const isBatteryStep =
    battery.connecting === true || battery.capacityMah !== undefined || battery.chargeCurrentMa !== undefined;

  if (isBatteryStep && battery.polarityConfirmed !== true) {
    const isXiao = board.id.toLowerCase().startsWith("seeed_xiao");
    const polarityGuidance = isXiao
      ? "On Seeed XIAO boards, per official docs, the negative (BAT-) terminal is the pad closest to the USB-C port and the positive (BAT+) terminal is the pad farthest from it."
      : "Confirm BAT+/BAT- against the board's official pinout/silkscreen.";
    addFinding(
      findings,
      reasonCodes,
      {
        code: "BATTERY_POLARITY_UNCONFIRMED",
        severity: "error",
        message: `A battery-connection step was requested but polarity has not been explicitly confirmed. Never assume BAT+/BAT- from wire color alone. ${polarityGuidance} Set battery.polarityConfirmed=true only after verifying this against the board's documentation, not from memory or wire color.`
      },
      "BATTERY_POLARITY_UNCONFIRMED"
    );
    nextActions.push(
      "Verify BAT+/BAT- polarity against the board's official documentation before connecting the battery, then re-run with battery.polarityConfirmed=true."
    );
  }

  let chargeCurrentMa = battery.chargeCurrentMa;
  let chargeCurrentSource: BatteryAssessment["chargeCurrentSource"] = null;

  if (chargeCurrentMa !== undefined) {
    chargeCurrentSource = "user_supplied";
  } else {
    const chargeIc = findChargeIcReference(board.id);
    if (chargeIc) {
      chargeCurrentMa = chargeIc.fastChargeCurrentMa;
      chargeCurrentSource = "board_charge_ic";
    }
  }

  let cRate: number | null = null;

  if (battery.capacityMah !== undefined && battery.capacityMah > 0 && chargeCurrentMa !== undefined) {
    cRate = computeChargeCRate(battery.capacityMah, chargeCurrentMa);
    const sourceNote =
      chargeCurrentSource === "board_charge_ic"
        ? ` (assumed from ${board.displayName}'s known onboard charge IC fast-charge current -- verify against the datasheet, or pass battery.chargeCurrentMa explicitly if using a different charger)`
        : "";
    const rounded = Math.round(cRate * 100) / 100;

    if (cRate > LIPO_CRATE_HARD_WARNING_THRESHOLD) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "BATTERY_CRATE_UNSAFE",
          severity: "error",
          message: `${chargeCurrentMa}mA into a ${battery.capacityMah}mAh cell is a ${rounded}C charge rate${sourceNote} -- well above the ~0.5-1C safe range for typical small LiPo cells; verify your cell's actual rated charge current before proceeding.`
        },
        "BATTERY_CRATE_UNSAFE"
      );
      nextActions.push(
        "Check the LiPo cell's printed/datasheet max charge current or C-rating before charging; most small single-cell pouch cells are not rated for this."
      );
    } else if (cRate > LIPO_CRATE_SOFT_CAUTION_THRESHOLD) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "BATTERY_CRATE_CAUTION",
          severity: "warning",
          message: `${chargeCurrentMa}mA into a ${battery.capacityMah}mAh cell is a ${rounded}C charge rate${sourceNote} -- inside the upper half of the ~0.5-1C safe range for typical small LiPo cells; verify your cell's actual rated charge current before relying on this long-term.`
        },
        "BATTERY_CRATE_CAUTION"
      );
    }
  } else if (battery.capacityMah !== undefined && chargeCurrentMa === undefined) {
    addFinding(
      findings,
      reasonCodes,
      {
        code: "BATTERY_CHARGE_CURRENT_UNKNOWN",
        severity: "warning",
        message: `Battery capacity (${battery.capacityMah}mAh) was provided but the charge current is unknown for board ${board.displayName}. C-rate could not be validated -- supply battery.chargeCurrentMa or check the board's charge IC datasheet.`
      },
      "BATTERY_INFO_INCOMPLETE"
    );
  }

  return {
    capacityMah: battery.capacityMah ?? null,
    chargeCurrentMa: chargeCurrentMa ?? null,
    chargeCurrentSource,
    cRate
  };
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
      const conditionalNote = board.uart?.conditionalNote ? ` ${board.uart.conditionalNote}` : "";
      addFinding(
        findings,
        reasonCodes,
        {
          code: "UART_PIN_REUSED",
          severity: "warning",
          pin: normalizedPin,
          message: `${normalizedPin} is a hardware UART pin and may conflict with upload/serial monitor.${conditionalNote}`
        },
        "UART_CONFLICT"
      );
    }

    if (caps.has("SPI_FLASH")) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "SPI_FLASH_PIN_USED",
          severity: "error",
          pin: normalizedPin,
          message: `${normalizedPin} is connected internally to the module's SPI flash chip. Wiring anything external to it prevents the board from booting.`
        },
        "SPI_FLASH_PIN_CONFLICT"
      );
      nextActions.push(`Do not wire external devices to ${normalizedPin}; it is reserved for the onboard SPI flash chip.`);
    }

    if (caps.has("NO_INTERNAL_PULL")) {
      addFinding(
        findings,
        reasonCodes,
        {
          code: "NO_INTERNAL_PULL_PIN",
          severity: "warning",
          pin: normalizedPin,
          message: `${normalizedPin} has no internal pull-up/pull-down resistor. If used as a button/switch input it will float without an external pull resistor.`
        },
        "NO_INTERNAL_PULL_RISK"
      );
      nextActions.push(`Add an external pull resistor for ${normalizedPin} if using it as a digital input (e.g., button/switch).`);
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

  const battery = assessBattery(input.battery, board, findings, reasonCodes, nextActions);

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
    nextActions,
    battery
  };
}
