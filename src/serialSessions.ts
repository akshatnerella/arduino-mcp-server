import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PortOperationCoordinator, type PortLockInfo } from "./portCoordinator.js";

export type SerialSessionState =
  | "OPENING"
  | "READY"
  | "RESETTING"
  | "DISCONNECTED"
  | "STALE"
  | "CLOSED";

export type SerialReadEncoding = "utf8" | "base64";

export interface SerialSessionOpenInput {
  cliPath: string;
  port: string;
  baudRate: number;
  ttlMs: number;
  maxBufferBytes: number;
}

export interface SerialSessionSummary {
  sessionId: string;
  port: string;
  baudRate: number;
  state: SerialSessionState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  totalBytesReceived: number;
  droppedBytes: number;
  bufferStartOffset: number;
  bufferEndOffset: number;
  lastError: string | null;
  lock: PortLockInfo | null;
}

interface SerialSession {
  id: string;
  owner: string;
  port: string;
  baudRate: number;
  ttlMs: number;
  maxBufferBytes: number;
  state: SerialSessionState;
  process: ChildProcessWithoutNullStreams;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  totalBytesReceived: number;
  droppedBytes: number;
  buffer: Buffer;
  stderrTail: string;
  closeRequested: boolean;
  lastError: string | null;
}

interface OpenResult {
  ok: boolean;
  session?: SerialSessionSummary;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  lockHeldBy?: PortLockInfo;
}

interface CloseResult {
  ok: boolean;
  session?: SerialSessionSummary;
  error?: string;
  errorCode?: string;
}

interface WriteResult {
  ok: boolean;
  session?: SerialSessionSummary;
  writtenBytes?: number;
  error?: string;
  errorCode?: string;
}

interface ReadResult {
  ok: boolean;
  session?: SerialSessionSummary;
  data?: string;
  encoding?: SerialReadEncoding;
  bytesRead?: number;
  startOffset?: number;
  nextOffset?: number;
  truncated?: boolean;
  error?: string;
  errorCode?: string;
}

interface ExpectResult {
  ok: boolean;
  session?: SerialSessionSummary;
  matched?: boolean;
  pattern?: string;
  matchIndex?: number;
  fromOffset?: number;
  timeoutMs?: number;
  error?: string;
  errorCode?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SerialSessionManager {
  private readonly sessions = new Map<string, SerialSession>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(private readonly coordinator: PortOperationCoordinator) {
    this.cleanupInterval = setInterval(() => {
      this.sweepExpiredSessions();
    }, 5_000);
    this.cleanupInterval.unref();
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) {
      session.closeRequested = true;
      session.process.kill();
      this.coordinator.release(session.port, session.owner);
    }
    this.sessions.clear();
  }

  async openSession(input: SerialSessionOpenInput): Promise<OpenResult> {
    const port = input.port.trim();
    const baudRate = Math.floor(input.baudRate);
    const ttlMs = Math.min(Math.max(input.ttlMs, 5_000), 10 * 60_000);
    const maxBufferBytes = Math.min(Math.max(input.maxBufferBytes, 4_096), 2 * 1024 * 1024);

    if (!port) {
      return {
        ok: false,
        errorCode: "INVALID_PORT",
        error: "Port is required."
      };
    }

    for (const existing of this.sessions.values()) {
      if (existing.port.toLowerCase() === port.toLowerCase() && existing.state !== "CLOSED") {
        return {
          ok: false,
          errorCode: "PORT_BUSY",
          error: `Port ${port} already has an active serial session (${existing.id}).`,
          retryable: true
        };
      }
    }

    const sessionId = randomUUID();
    const owner = `serial-session:${sessionId}`;
    const lock = this.coordinator.acquire(port, owner, "serial_open_session");
    if (!lock.ok) {
      return {
        ok: false,
        errorCode: "PORT_BUSY",
        error: `Port ${port} is busy.`,
        retryable: true,
        lockHeldBy: lock.heldBy
      };
    }

    const args = ["monitor", "-p", port, "-c", `baudrate=${baudRate}`];
    const child = spawn(input.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const now = Date.now();
    const session: SerialSession = {
      id: sessionId,
      owner,
      port,
      baudRate,
      ttlMs,
      maxBufferBytes,
      state: "OPENING",
      process: child,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
      totalBytesReceived: 0,
      droppedBytes: 0,
      buffer: Buffer.alloc(0),
      stderrTail: "",
      closeRequested: false,
      lastError: null
    };

    this.sessions.set(session.id, session);
    this.attachProcessHandlers(session);

    await sleep(500);
    const liveSession = this.sessions.get(session.id);
    if (!liveSession) {
      return {
        ok: false,
        errorCode: "SESSION_OPEN_FAILED",
        error: `Failed to open serial session on ${port}.`
      };
    }

    if (liveSession.state === "DISCONNECTED") {
      this.coordinator.release(liveSession.port, liveSession.owner);
      this.sessions.delete(liveSession.id);
      return {
        ok: false,
        errorCode: "SESSION_OPEN_FAILED",
        error: liveSession.lastError ?? `Serial session closed during open on ${port}.`,
        retryable: true
      };
    }

    if (liveSession.state === "OPENING") {
      liveSession.state = "READY";
      liveSession.updatedAt = Date.now();
    }

    return {
      ok: true,
      session: this.toSummary(liveSession)
    };
  }

  listSessions(): SerialSessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => this.toSummary(session));
  }

  getSessionSummary(sessionId: string): SerialSessionSummary | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return this.toSummary(session);
  }

  closeSession(sessionId: string): CloseResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_FOUND",
        error: `No serial session found for id ${sessionId}.`
      };
    }

    session.closeRequested = true;
    session.state = "CLOSED";
    session.updatedAt = Date.now();
    session.expiresAt = session.updatedAt;
    session.process.kill();
    this.coordinator.release(session.port, session.owner);
    this.sessions.delete(session.id);

    return {
      ok: true,
      session: this.toSummary(session)
    };
  }

  readSession(
    sessionId: string,
    fromOffset: number | null,
    maxBytes: number,
    encoding: SerialReadEncoding
  ): ReadResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_FOUND",
        error: `No serial session found for id ${sessionId}.`
      };
    }

    if (!this.isSessionReadable(session)) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_READY",
        error: `Session ${session.id} is not readable in state ${session.state}.`,
        session: this.toSummary(session)
      };
    }

    this.touch(session);

    const startOffset = session.totalBytesReceived - session.buffer.length;
    const desiredOffset = fromOffset === null ? startOffset : Math.max(0, Math.floor(fromOffset));
    const effectiveOffset = Math.max(desiredOffset, startOffset);
    const bytesLimit = Math.min(Math.max(Math.floor(maxBytes), 1), session.maxBufferBytes);
    const startIndex = effectiveOffset - startOffset;
    const window = session.buffer.subarray(startIndex, startIndex + bytesLimit);

    return {
      ok: true,
      session: this.toSummary(session),
      data: encoding === "base64" ? window.toString("base64") : window.toString("utf8"),
      encoding,
      bytesRead: window.length,
      startOffset: effectiveOffset,
      nextOffset: effectiveOffset + window.length,
      truncated: desiredOffset < startOffset
    };
  }

  async expectInSession(
    sessionId: string,
    pattern: string,
    timeoutMs: number,
    caseSensitive: boolean,
    fromOffset: number | null
  ): Promise<ExpectResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_FOUND",
        error: `No serial session found for id ${sessionId}.`
      };
    }

    if (!this.isSessionReadable(session)) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_READY",
        error: `Session ${session.id} is not readable in state ${session.state}.`,
        session: this.toSummary(session)
      };
    }

    const boundedTimeout = Math.min(Math.max(Math.floor(timeoutMs), 200), 120_000);
    const started = Date.now();
    const baseOffset =
      fromOffset === null ? session.totalBytesReceived : Math.max(0, Math.floor(fromOffset));
    const expectedPattern = caseSensitive ? pattern : pattern.toLowerCase();

    while (Date.now() - started <= boundedTimeout) {
      const current = this.sessions.get(sessionId);
      if (!current) {
        return {
          ok: false,
          errorCode: "SESSION_NOT_FOUND",
          error: `Session ${sessionId} disappeared before pattern was matched.`
        };
      }

      if (!this.isSessionReadable(current)) {
        return {
          ok: false,
          errorCode: "SESSION_NOT_READY",
          error: `Session ${current.id} became unreadable in state ${current.state}.`,
          session: this.toSummary(current)
        };
      }

      const startOffset = current.totalBytesReceived - current.buffer.length;
      const effectiveOffset = Math.max(baseOffset, startOffset);
      const view = current.buffer.subarray(effectiveOffset - startOffset);
      const text = view.toString("utf8");
      const haystack = caseSensitive ? text : text.toLowerCase();
      const idx = haystack.indexOf(expectedPattern);
      if (idx >= 0) {
        this.touch(current);
        return {
          ok: true,
          matched: true,
          pattern,
          matchIndex: effectiveOffset + idx,
          fromOffset: effectiveOffset,
          timeoutMs: boundedTimeout,
          session: this.toSummary(current)
        };
      }

      await sleep(100);
    }

    const timedOut = this.sessions.get(sessionId);
    if (timedOut) {
      this.touch(timedOut);
    }
    return {
      ok: false,
      matched: false,
      pattern,
      fromOffset: baseOffset,
      timeoutMs: boundedTimeout,
      errorCode: "EXPECT_TIMEOUT",
      error: `Pattern was not observed before timeout (${boundedTimeout}ms).`,
      session: timedOut ? this.toSummary(timedOut) : undefined
    };
  }

  writeSession(sessionId: string, payload: Buffer): WriteResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_FOUND",
        error: `No serial session found for id ${sessionId}.`
      };
    }

    if (!this.isSessionWritable(session)) {
      return {
        ok: false,
        errorCode: "SESSION_NOT_READY",
        error: `Session ${session.id} is not writable in state ${session.state}.`,
        session: this.toSummary(session)
      };
    }

    try {
      const wrote = session.process.stdin.write(payload);
      this.touch(session);
      return {
        ok: wrote,
        session: this.toSummary(session),
        writtenBytes: payload.length,
        error: wrote ? undefined : "Write backpressure: data accepted but stream is congested.",
        errorCode: wrote ? undefined : "WRITE_BACKPRESSURE"
      };
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : "Unknown serial write failure.";
      session.state = "DISCONNECTED";
      this.coordinator.release(session.port, session.owner);
      return {
        ok: false,
        errorCode: "SERIAL_WRITE_FAILED",
        error: session.lastError,
        session: this.toSummary(session)
      };
    }
  }

  private attachProcessHandlers(session: SerialSession) {
    session.process.stdout.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.appendBuffer(session, data);
      if (session.state === "OPENING") {
        session.state = "READY";
      }
      session.updatedAt = Date.now();
    });

    session.process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      session.stderrTail = `${session.stderrTail}${text}`.slice(-8_000);
      session.lastError = session.stderrTail.trim() || null;
      session.updatedAt = Date.now();
    });

    session.process.on("error", (error) => {
      session.lastError = error.message;
      session.state = "DISCONNECTED";
      session.updatedAt = Date.now();
      this.coordinator.release(session.port, session.owner);
    });

    session.process.on("close", () => {
      session.updatedAt = Date.now();
      if (!session.closeRequested && session.state !== "STALE") {
        session.state = "DISCONNECTED";
      }
      this.coordinator.release(session.port, session.owner);
    });
  }

  private appendBuffer(session: SerialSession, chunk: Buffer) {
    session.totalBytesReceived += chunk.length;

    if (chunk.length >= session.maxBufferBytes) {
      const kept = chunk.subarray(chunk.length - session.maxBufferBytes);
      session.droppedBytes += session.buffer.length + (chunk.length - kept.length);
      session.buffer = Buffer.from(kept);
      return;
    }

    const combinedLength = session.buffer.length + chunk.length;
    if (combinedLength > session.maxBufferBytes) {
      const drop = combinedLength - session.maxBufferBytes;
      session.droppedBytes += drop;
      session.buffer = Buffer.concat([session.buffer.subarray(drop), chunk]);
      return;
    }

    session.buffer = Buffer.concat([session.buffer, chunk]);
  }

  private touch(session: SerialSession) {
    const now = Date.now();
    session.updatedAt = now;
    session.expiresAt = now + session.ttlMs;
  }

  private isSessionReadable(session: SerialSession): boolean {
    return session.state === "OPENING" || session.state === "READY" || session.state === "RESETTING";
  }

  private isSessionWritable(session: SerialSession): boolean {
    return session.state === "READY" || session.state === "RESETTING";
  }

  private sweepExpiredSessions() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state === "CLOSED" || session.state === "DISCONNECTED") {
        this.sessions.delete(session.id);
        continue;
      }

      if (now <= session.expiresAt) {
        continue;
      }

      session.state = "STALE";
      session.lastError = "Session lease expired.";
      session.closeRequested = true;
      session.process.kill();
      this.coordinator.release(session.port, session.owner);
      this.sessions.delete(session.id);
    }
  }

  private toSummary(session: SerialSession): SerialSessionSummary {
    return {
      sessionId: session.id,
      port: session.port,
      baudRate: session.baudRate,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      totalBytesReceived: session.totalBytesReceived,
      droppedBytes: session.droppedBytes,
      bufferStartOffset: session.totalBytesReceived - session.buffer.length,
      bufferEndOffset: session.totalBytesReceived,
      lastError: session.lastError,
      lock: this.coordinator.get(session.port)
    };
  }
}
