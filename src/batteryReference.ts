import chargeIcData from "../data/battery-charge-ic-reference.json" with { type: "json" };

/**
 * A single board's known onboard LiPo charge-IC current figures.
 *
 * This table is intentionally small and data-driven so more boards can be
 * added without touching any logic in safety.ts -- just append an entry to
 * data/battery-charge-ic-reference.json.
 */
export interface ChargeIcReference {
  boardId: string;
  aliases: string[];
  /** Fast-charge current in mA, as published by the board/module vendor. */
  fastChargeCurrentMa: number;
  /** Trickle/pre-charge current in mA for a deeply discharged cell. */
  trickleChargeCurrentMa: number;
  referenceLink?: string;
}

interface ChargeIcReferenceStore {
  version: string;
  source: string;
  boards: ChargeIcReference[];
}

const store = chargeIcData as ChargeIcReferenceStore;

export function listChargeIcReferences(): ChargeIcReference[] {
  return store.boards;
}

export function getChargeIcReferenceSource(): string {
  return store.source;
}

/**
 * Look up known onboard charge-IC current figures for a board by id or alias.
 * Returns null when the board has no known onboard charge IC in this table
 * (e.g., boards with no battery charging circuitry, or boards not yet added).
 */
export function findChargeIcReference(boardIdOrAlias: string): ChargeIcReference | null {
  const normalized = boardIdOrAlias.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    store.boards.find((entry) => {
      if (entry.boardId.toLowerCase() === normalized) {
        return true;
      }
      return entry.aliases.some((alias) => alias.toLowerCase() === normalized);
    }) ?? null
  );
}
