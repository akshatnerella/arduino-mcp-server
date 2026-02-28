import boardReferenceData from "../data/board-reference.json" with { type: "json" };

export interface BoardPin {
  name: string;
  capabilities?: string[];
}

export interface BoardReference {
  id: string;
  displayName: string;
  aliases: string[];
  fqbnCandidates: string[];
  mcu: string;
  logicVoltage: string;
  operatingVoltage: string;
  digitalPins: BoardPin[];
  analogPins: BoardPin[];
  pwmPins: string[];
  i2c?: {
    sda?: string;
    scl?: string;
  };
  spi?: {
    miso?: string;
    mosi?: string;
    sck?: string;
    ss?: string;
  };
  uart?: {
    hardware?: string[];
  };
  notes: string[];
  referenceLinks: string[];
}

interface BoardReferenceStore {
  version: string;
  boards: BoardReference[];
}

const store = boardReferenceData as BoardReferenceStore;

export function listBoardReferences(): BoardReference[] {
  return store.boards;
}

export function getBoardReferenceById(id: string): BoardReference | null {
  const normalized = id.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return store.boards.find((board) => board.id.toLowerCase() === normalized) ?? null;
}

export function findBoardReferenceByFqbn(fqbn: string): BoardReference | null {
  const normalized = fqbn.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    store.boards.find((board) =>
      board.fqbnCandidates.some((candidate) => candidate.toLowerCase() === normalized)
    ) ?? null
  );
}

export function findBoardReference(query: string): BoardReference[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return store.boards.filter((board) => {
    if (board.id.toLowerCase().includes(normalized)) {
      return true;
    }

    if (board.displayName.toLowerCase().includes(normalized)) {
      return true;
    }

    if (board.aliases.some((alias) => alias.toLowerCase().includes(normalized))) {
      return true;
    }

    if (board.fqbnCandidates.some((fqbn) => fqbn.toLowerCase().includes(normalized))) {
      return true;
    }

    return false;
  });
}
