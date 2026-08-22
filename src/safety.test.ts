import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeChargeCRate, runSafetyPreflight, type BatterySpec } from "./safety.js";
import { getBoardReferenceById } from "./boardReference.js";

function requireBoard(id: string) {
  const board = getBoardReferenceById(id);
  assert.ok(board, `expected board reference for id "${id}" to exist`);
  return board!;
}

describe("computeChargeCRate", () => {
  test("computes a simple ratio", () => {
    // 1C for a 100mAh cell is 100mA.
    assert.equal(computeChargeCRate(100, 100), 1);
  });

  test("computes the worked example from the guardrail docs (380mA into 100mAh)", () => {
    assert.equal(Math.round(computeChargeCRate(100, 380) * 100) / 100, 3.8);
  });

  test("computes a safe sub-0.5C rate", () => {
    assert.equal(computeChargeCRate(200, 50), 0.25);
  });

  test("throws on non-positive battery capacity", () => {
    assert.throws(() => computeChargeCRate(0, 100));
    assert.throws(() => computeChargeCRate(-10, 100));
  });

  test("throws on negative charge current", () => {
    assert.throws(() => computeChargeCRate(100, -5));
  });
});

describe("safety preflight - battery C-rate guardrail", () => {
  const board = requireBoard("seeed_xiao_esp32s3");

  test("safe case: well under 0.5C produces no battery C-rate finding", () => {
    const battery: BatterySpec = { capacityMah: 500, chargeCurrentMa: 50, polarityConfirmed: true };
    const result = runSafetyPreflight({ board, battery });
    const crateFindings = result.findings.filter(
      (f) => f.code === "BATTERY_CRATE_UNSAFE" || f.code === "BATTERY_CRATE_CAUTION"
    );
    assert.equal(crateFindings.length, 0);
    assert.equal(result.battery?.cRate, 0.1);
  });

  test("soft caution case: between 0.5C and 1C is a non-blocking warning", () => {
    const battery: BatterySpec = { capacityMah: 200, chargeCurrentMa: 150, polarityConfirmed: true };
    const result = runSafetyPreflight({ board, battery });
    const finding = result.findings.find((f) => f.code === "BATTERY_CRATE_CAUTION");
    assert.ok(finding, "expected a BATTERY_CRATE_CAUTION finding");
    assert.equal(finding!.severity, "warning");
    assert.notEqual(result.status, "blocked");
  });

  test("unsafe case: 380mA into a 100mAh cell is flagged as a hard, blocking warning", () => {
    const battery: BatterySpec = { capacityMah: 100, chargeCurrentMa: 380, polarityConfirmed: true };
    const result = runSafetyPreflight({ board, battery });
    const finding = result.findings.find((f) => f.code === "BATTERY_CRATE_UNSAFE");
    assert.ok(finding, "expected a BATTERY_CRATE_UNSAFE finding");
    assert.equal(finding!.severity, "error");
    assert.match(finding!.message, /3\.8C/);
    assert.equal(result.status, "blocked");
  });

  test("falls back to the board's known onboard charge IC current when chargeCurrentMa is omitted", () => {
    const xiaoC3 = requireBoard("seeed_xiao_esp32c3");
    const battery: BatterySpec = { capacityMah: 100, polarityConfirmed: true };
    const result = runSafetyPreflight({ board: xiaoC3, battery });
    assert.equal(result.battery?.chargeCurrentSource, "board_charge_ic");
    assert.equal(result.battery?.chargeCurrentMa, 380);
    const finding = result.findings.find((f) => f.code === "BATTERY_CRATE_UNSAFE");
    assert.ok(finding, "expected board-derived charge current to still trigger the unsafe C-rate finding");
  });

  test("no finding when capacity/charge current are not provided at all", () => {
    const result = runSafetyPreflight({ board });
    assert.equal(result.battery, null);
  });
});

describe("safety preflight - battery polarity confirmation guardrail", () => {
  const board = requireBoard("seeed_xiao_esp32s3");

  test("unsafe case: battery-connection step without confirmation blocks and names XIAO polarity convention", () => {
    const battery: BatterySpec = { connecting: true };
    const result = runSafetyPreflight({ board, battery });
    const finding = result.findings.find((f) => f.code === "BATTERY_POLARITY_UNCONFIRMED");
    assert.ok(finding, "expected a BATTERY_POLARITY_UNCONFIRMED finding");
    assert.equal(finding!.severity, "error");
    assert.match(finding!.message, /closest to the USB-C port/);
    assert.equal(result.status, "blocked");
  });

  test("safe case: explicit polarityConfirmed=true does not block", () => {
    const battery: BatterySpec = { connecting: true, polarityConfirmed: true };
    const result = runSafetyPreflight({ board, battery });
    const finding = result.findings.find((f) => f.code === "BATTERY_POLARITY_UNCONFIRMED");
    assert.equal(finding, undefined);
  });

  test("non-XIAO boards get generic polarity guidance, not the XIAO-specific pad convention", () => {
    const uno = requireBoard("arduino_uno_r3");
    const result = runSafetyPreflight({ board: uno, battery: { connecting: true } });
    const finding = result.findings.find((f) => f.code === "BATTERY_POLARITY_UNCONFIRMED");
    assert.ok(finding);
    assert.doesNotMatch(finding!.message, /closest to the USB-C port/);
  });
});

describe("safety preflight - SPI flash pin guardrail (classic ESP32)", () => {
  const board = requireBoard("esp32_dev_module");

  test("unsafe case: wiring to a SPI-flash-connected pin (GPIO6) is a hard error", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "GPIO6", direction: "output", signalType: "digital" }]
    });
    const finding = result.findings.find((f) => f.code === "SPI_FLASH_PIN_USED");
    assert.ok(finding, "expected a SPI_FLASH_PIN_USED finding");
    assert.equal(finding!.severity, "error");
    assert.equal(result.status, "blocked");
  });

  test("safe case: an ordinary GPIO pin (GPIO4) is not flagged as SPI flash conflict", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "GPIO4", direction: "output", signalType: "digital" }]
    });
    const finding = result.findings.find((f) => f.code === "SPI_FLASH_PIN_USED");
    assert.equal(finding, undefined);
  });
});

describe("safety preflight - input-only, no-internal-pull guardrail (classic ESP32)", () => {
  const board = requireBoard("esp32_dev_module");

  test("caution case: GPIO34 as a digital input surfaces a non-blocking pull-resistor warning", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "GPIO34", direction: "input", signalType: "digital" }]
    });
    const finding = result.findings.find((f) => f.code === "NO_INTERNAL_PULL_PIN");
    assert.ok(finding, "expected a NO_INTERNAL_PULL_PIN finding");
    assert.equal(finding!.severity, "warning");
    assert.notEqual(result.status, "blocked");
  });

  test("safe case: a pin with internal pull support (GPIO4) is not flagged", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "GPIO4", direction: "input", signalType: "digital" }]
    });
    const finding = result.findings.find((f) => f.code === "NO_INTERNAL_PULL_PIN");
    assert.equal(finding, undefined);
  });
});

describe("safety preflight - XIAO ESP32S3 UART/GPIO repurposing note", () => {
  const board = requireBoard("seeed_xiao_esp32s3");

  test("using D6 (default UART TX) surfaces the USB CDC on Boot conditional note", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "D6", direction: "output", signalType: "digital" }]
    });
    const finding = result.findings.find((f) => f.code === "UART_PIN_REUSED");
    assert.ok(finding, "expected a UART_PIN_REUSED finding for D6");
    assert.match(finding!.message, /USB CDC on Boot/);
  });

  test("using D6 declared as uart signalType does not trigger the reuse warning", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "D6", direction: "output", signalType: "uart" }]
    });
    const finding = result.findings.find((f) => f.code === "UART_PIN_REUSED");
    assert.equal(finding, undefined);
  });

  test("an ordinary GPIO (D0) does not surface the UART conditional note", () => {
    const result = runSafetyPreflight({
      board,
      wiring: [{ pin: "D0", direction: "output", signalType: "digital" }]
    });
    const finding = result.findings.find((f) => f.code === "UART_PIN_REUSED");
    assert.equal(finding, undefined);
  });
});
