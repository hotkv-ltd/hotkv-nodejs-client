// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { errorFromReply, ProtocolError } from "../errors.js";
import type { Frame, RespValue } from "./types.js";

const CR = 0x0d;
const LF = 0x0a;

// Type bytes, RESP2.
const T_SIMPLE = 0x2b; // +
const T_ERROR = 0x2d; // -
const T_INTEGER = 0x3a; // :
const T_BULK = 0x24; // $
const T_ARRAY = 0x2a; // *
// Type bytes, RESP3 additions.
const T_NULL = 0x5f; // _
const T_BOOL = 0x23; // #
const T_DOUBLE = 0x2c; // ,
const T_BIGNUM = 0x28; // (
const T_BULK_ERROR = 0x21; // !
const T_VERBATIM = 0x3d; // =
const T_MAP = 0x25; // %
const T_SET = 0x7e; // ~
const T_PUSH = 0x3e; // >
const T_ATTRIBUTE = 0x7c; // |

/** Thrown internally to unwind a parse attempt that ran off the end of the buffered bytes. */
class NeedMoreData extends Error {}
const NEED_MORE = new NeedMoreData();

/**
 * Incremental RESP2/RESP3 reply parser. Feed it bytes as they arrive on a
 * socket, then drain every complete top level frame currently available
 * with next(). Correctly resumes a reply split across any number of chunk
 * boundaries, including mid length-prefix or mid payload: an interrupted
 * parse attempt rewinds to where that frame started and waits for feed().
 */
export class RespReader {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;

  feed(chunk: Buffer): void {
    if (this.pos > 0) {
      this.buf = this.buf.subarray(this.pos);
      this.pos = 0;
    }
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  /** True if some bytes are buffered but not yet consumed into a full frame. */
  get hasPending(): boolean {
    return this.buf.length - this.pos > 0;
  }

  *next(): Generator<Frame> {
    for (;;) {
      const start = this.pos;
      let frame: Frame;
      try {
        frame = this.readFrame();
      } catch (err) {
        if (err instanceof NeedMoreData) {
          this.pos = start;
          return;
        }
        throw err;
      }
      yield frame;
    }
  }

  private readFrame(): Frame {
    let type = this.byte();
    while (type === T_ATTRIBUTE) {
      // Attribute reply: a side channel map that precedes the real reply.
      // No command this SDK issues requests attributes; consume and discard.
      this.mapBody();
      type = this.byte();
    }
    const value = this.readValueOfType(type);
    return { kind: type === T_PUSH ? "push" : "reply", value };
  }

  private readValue(): RespValue {
    return this.readValueOfType(this.byte());
  }

  private readValueOfType(type: number): RespValue {
    switch (type) {
      case T_SIMPLE:
        return this.line();
      case T_ERROR:
        return errorFromReply(this.line());
      case T_INTEGER:
        return this.integer(this.line());
      case T_BULK:
        return this.bulkBytes();
      case T_ARRAY:
        return this.array();
      case T_NULL:
        this.crlf();
        return null;
      case T_BOOL:
        return this.boolean();
      case T_DOUBLE:
        return this.double(this.line());
      case T_BIGNUM:
        return this.bigNumber(this.line());
      case T_BULK_ERROR:
        return errorFromReply(this.bulkText());
      case T_VERBATIM:
        return this.verbatim();
      case T_MAP:
        return this.mapBody();
      case T_SET:
        return this.array();
      case T_PUSH:
        return this.array();
      default:
        throw new ProtocolError(
          `unexpected reply type byte 0x${type.toString(16).padStart(2, "0")}`,
        );
    }
  }

  private boolean(): boolean {
    const c = this.byte();
    this.crlf();
    if (c === 0x74) return true; // 't'
    if (c === 0x66) return false; // 'f'
    throw new ProtocolError(`invalid boolean byte 0x${c.toString(16)}`);
  }

  private verbatim(): string {
    const text = this.bulkText();
    // Wire format is a 3 byte format tag then ':' then the payload, e.g. "txt:Some string".
    return text.length >= 4 && text.charAt(3) === ":" ? text.slice(4) : text;
  }

  private array(): RespValue[] | null {
    const n = this.integer(this.line());
    if (n < 0) return null;
    const out: RespValue[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.readValue();
    return out;
  }

  private mapBody(): Map<RespValue, RespValue> {
    const n = this.integer(this.line());
    const out = new Map<RespValue, RespValue>();
    for (let i = 0; i < n; i++) {
      const key = this.readValue();
      const val = this.readValue();
      out.set(key, val);
    }
    return out;
  }

  private bulkText(): string {
    const buf = this.bulkBytes();
    if (buf === null) throw new ProtocolError("unexpected null bulk payload");
    return buf.toString("utf8");
  }

  private bulkBytes(): Buffer | null {
    const n = this.integer(this.line());
    if (n < 0) return null;
    if (this.buf.length - this.pos < n + 2) throw NEED_MORE;
    const data = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    this.crlf();
    return data;
  }

  private integer(line: string): number {
    if (line.length === 0 || !/^-?\d+$/.test(line)) {
      throw new ProtocolError(`invalid integer: ${JSON.stringify(line)}`);
    }
    const n = Number(line);
    if (!Number.isFinite(n)) throw new ProtocolError(`invalid integer: ${JSON.stringify(line)}`);
    return n;
  }

  private double(line: string): number {
    switch (line) {
      case "inf":
      case "+inf":
        return Infinity;
      case "-inf":
        return -Infinity;
      case "nan":
        return NaN;
      default: {
        const n = Number(line);
        if (Number.isNaN(n)) throw new ProtocolError(`invalid double: ${JSON.stringify(line)}`);
        return n;
      }
    }
  }

  private bigNumber(line: string): bigint {
    try {
      return BigInt(line);
    } catch {
      throw new ProtocolError(`invalid big number: ${JSON.stringify(line)}`);
    }
  }

  private byte(): number {
    if (this.pos >= this.buf.length) throw NEED_MORE;
    return this.buf[this.pos++] as number;
  }

  private line(): string {
    const idx = this.buf.indexOf(CR, this.pos);
    if (idx === -1 || idx + 1 >= this.buf.length) throw NEED_MORE;
    if (this.buf[idx + 1] !== LF) {
      throw new ProtocolError("expected LF after CR");
    }
    const text = this.buf.toString("utf8", this.pos, idx);
    this.pos = idx + 2;
    return text;
  }

  private crlf(): void {
    if (this.buf.length - this.pos < 2) throw NEED_MORE;
    if (this.buf[this.pos] !== CR || this.buf[this.pos + 1] !== LF) {
      throw new ProtocolError("expected trailing CRLF");
    }
    this.pos += 2;
  }
}
