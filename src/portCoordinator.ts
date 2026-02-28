export interface PortLockInfo {
  port: string;
  owner: string;
  stage: string;
  acquiredAt: number;
}

interface AcquireLockResult {
  ok: boolean;
  lock?: PortLockInfo;
  heldBy?: PortLockInfo;
}

function normalizePort(port: string): string {
  return port.trim().toLowerCase();
}

export class PortOperationCoordinator {
  private readonly locks = new Map<string, PortLockInfo>();

  acquire(port: string, owner: string, stage: string): AcquireLockResult {
    const key = normalizePort(port);
    const existing = this.locks.get(key);
    if (existing && existing.owner !== owner) {
      return {
        ok: false,
        heldBy: existing
      };
    }

    const lock: PortLockInfo = {
      port,
      owner,
      stage,
      acquiredAt: Date.now()
    };

    this.locks.set(key, lock);
    return {
      ok: true,
      lock
    };
  }

  release(port: string, owner: string): boolean {
    const key = normalizePort(port);
    const existing = this.locks.get(key);
    if (!existing) {
      return false;
    }

    if (existing.owner !== owner) {
      return false;
    }

    this.locks.delete(key);
    return true;
  }

  get(port: string): PortLockInfo | null {
    const key = normalizePort(port);
    return this.locks.get(key) ?? null;
  }

  list(): PortLockInfo[] {
    return Array.from(this.locks.values());
  }
}
