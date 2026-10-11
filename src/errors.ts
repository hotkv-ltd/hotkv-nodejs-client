// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

/**
 * Base class for every error this client raises itself (as opposed to
 * errors relayed verbatim from the server, see ReplyError below).
 */
export class HotKVError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** A connection could not be established, or an established one dropped. */
export class ConnectionError extends HotKVError {
  constructor(message: string, cause?: unknown) {
    super(`hotkv: ${message}`);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** A connect, command or blocking-command deadline elapsed. */
export class TimeoutError extends HotKVError {
  constructor(message = "operation timed out") {
    super(`hotkv: ${message}`);
  }
}

/** The server sent bytes that do not form a valid RESP2/RESP3 reply. */
export class ProtocolError extends HotKVError {
  constructor(message: string) {
    super(`hotkv: protocol error: ${message}`);
  }
}

/** No pooled connection could be created or borrowed in time. */
export class PoolTimeoutError extends HotKVError {
  constructor(message = "timed out waiting for a pooled connection") {
    super(`hotkv: ${message}`);
  }
}

/** The pool has reached its configured maximum size. */
export class PoolExhaustedError extends HotKVError {
  constructor(message = "connection pool exhausted") {
    super(`hotkv: ${message}`);
  }
}

/** Raised by cluster routing when a command cannot be routed or redirects loop. */
export class ClusterError extends HotKVError {
  constructor(message: string) {
    super(`hotkv: cluster: ${message}`);
  }
}

/**
 * A server error reply (RESP `-` simple error or `!` bulk error), exactly as
 * received. `code` is the leading, case sensitive error prefix word (for
 * example "ERR", "WRONGTYPE", "NOAUTH", "MOVED", "NOLICENSE").
 */
export class ReplyError extends HotKVError {
  readonly code: string;
  readonly raw: string;

  constructor(raw: string) {
    super(`hotkv: ${raw}`);
    const spaceIdx = raw.indexOf(" ");
    this.code = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
    this.raw = raw;
  }
}

/**
 * `-NOLICENSE ...`: an enterprise or AI command was rejected because the
 * server's currently loaded license does not cover that feature. Distinct
 * from every other server error so callers (and tests) can detect it and
 * skip or degrade gracefully.
 */
export class NotLicensedError extends ReplyError {}

/** `-MOVED <slot> <host:port>`: the key's slot now lives on another node. */
export class MovedError extends ReplyError {
  readonly slot: number;
  readonly address: string;

  constructor(raw: string) {
    super(raw);
    const parts = raw.split(" ");
    this.slot = Number(parts[1] ?? Number.NaN);
    this.address = parts[2] ?? "";
  }
}

/** `-ASK <slot> <host:port>`: the key is being migrated; ASKING then retry once against that node. */
export class AskError extends ReplyError {
  readonly slot: number;
  readonly address: string;

  constructor(raw: string) {
    super(raw);
    const parts = raw.split(" ");
    this.slot = Number(parts[1] ?? Number.NaN);
    this.address = parts[2] ?? "";
  }
}

/** Builds the most specific ReplyError subtype for a raw `-`/`!` reply string. */
export function errorFromReply(raw: string): ReplyError {
  const spaceIdx = raw.indexOf(" ");
  const code = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
  switch (code) {
    case "NOLICENSE":
      return new NotLicensedError(raw);
    case "MOVED":
      return new MovedError(raw);
    case "ASK":
      return new AskError(raw);
    default:
      return new ReplyError(raw);
  }
}

// These predicates deliberately check shape (a string `code`/`raw` on an
// Error), not `instanceof ReplyError`. @hotkv/client/ai is a separate bundled
// entry point from hotkv's main entry, each with its own copy of this
// module's classes, so an error a HotKV client raised and a ReplyError
// class imported through "@hotkv/client/ai" are not `instanceof` compatible even
// though they came from the same package. A structural check (this is
// also exactly what the wire protocol itself distinguishes errors by) works no matter
// which entry point either side was imported from, and still works for a
// plain Error someone built with the same shape by hand.
function replyErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isReplyError(err: unknown): err is ReplyError {
  return replyErrorCode(err) !== undefined;
}

export function isNotLicensedError(err: unknown): err is NotLicensedError {
  return replyErrorCode(err) === "NOLICENSE";
}

export function isMovedError(err: unknown): err is MovedError {
  return replyErrorCode(err) === "MOVED";
}

export function isAskError(err: unknown): err is AskError {
  return replyErrorCode(err) === "ASK";
}

export function isWrongTypeError(err: unknown): boolean {
  return replyErrorCode(err) === "WRONGTYPE";
}

export function isNoAuthError(err: unknown): boolean {
  return replyErrorCode(err) === "NOAUTH";
}

export function isReadOnlyError(err: unknown): boolean {
  return replyErrorCode(err) === "READONLY";
}

export function isNoScriptError(err: unknown): boolean {
  return replyErrorCode(err) === "NOSCRIPT";
}
