// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { formatNumberArg } from "../internal/numbers.js";
import type { CommandArg, CommandArgs } from "./types.js";

const CRLF = Buffer.from("\r\n", "ascii");

function argBuffer(arg: CommandArg): Buffer {
  if (Buffer.isBuffer(arg)) return arg;
  if (typeof arg === "string") return Buffer.from(arg, "utf8");
  // A number is sent as plain decimal text, never in exponent form (1e-7, 1e+21).
  if (typeof arg === "number") return Buffer.from(formatNumberArg(arg), "ascii");
  return Buffer.from(String(arg), "utf8");
}

/**
 * Encodes one command as a RESP array of bulk strings: the wire format for
 * every client request in both RESP2 and RESP3 (only replies differ between
 * the two protocol versions).
 */
export function encodeCommand(args: CommandArgs): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, "ascii")];
  for (const arg of args) {
    const buf = argBuffer(arg);
    parts.push(Buffer.from(`$${buf.length}\r\n`, "ascii"), buf, CRLF);
  }
  return Buffer.concat(parts);
}

/** Encodes several commands back to back, for a single pipelined socket write. */
export function encodeCommands(batch: readonly CommandArgs[]): Buffer {
  return Buffer.concat(batch.map(encodeCommand));
}
