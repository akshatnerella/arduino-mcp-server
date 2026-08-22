import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findChargeIcReference, listChargeIcReferences } from "./batteryReference.js";

describe("findChargeIcReference", () => {
  test("finds a known board by exact id", () => {
    const entry = findChargeIcReference("seeed_xiao_esp32c3");
    assert.ok(entry);
    assert.equal(entry!.fastChargeCurrentMa, 380);
    assert.equal(entry!.trickleChargeCurrentMa, 40);
  });

  test("finds a known board case-insensitively via alias", () => {
    const entry = findChargeIcReference("XIAO ESP32S3 Sense");
    assert.ok(entry);
    assert.equal(entry!.boardId, "seeed_xiao_esp32s3_sense");
    assert.equal(entry!.fastChargeCurrentMa, 100);
  });

  test("returns null for an unknown board", () => {
    assert.equal(findChargeIcReference("some_random_board_id"), null);
  });

  test("returns null for an empty query", () => {
    assert.equal(findChargeIcReference("   "), null);
  });

  test("table is easily extensible: every seeded entry has the required fields", () => {
    const entries = listChargeIcReferences();
    assert.ok(entries.length >= 3, "expected at least the 3 seeded XIAO boards");
    for (const entry of entries) {
      assert.equal(typeof entry.boardId, "string");
      assert.ok(entry.boardId.length > 0);
      assert.ok(Array.isArray(entry.aliases));
      assert.equal(typeof entry.fastChargeCurrentMa, "number");
      assert.ok(entry.fastChargeCurrentMa > 0);
      assert.equal(typeof entry.trickleChargeCurrentMa, "number");
      assert.ok(entry.trickleChargeCurrentMa >= 0);
    }
  });
});
