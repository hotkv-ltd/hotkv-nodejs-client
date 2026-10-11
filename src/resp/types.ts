// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { ReplyError } from "../errors.js";

/** One argument to a HotKV command: text, a number/bigint (stringified) or raw bytes. */
export type CommandArg = string | number | bigint | Buffer;

/**
 * A single command, as a command name followed by its arguments. Accepted
 * anywhere a raw command is sent (command(), pipelines, transactions).
 */
export type CommandArgs = readonly CommandArg[];

/**
 * A parsed RESP2/RESP3 reply. Bulk style payloads (bulk string, verbatim
 * string) decode to Buffer so binary values round trip exactly; the
 * decode helpers in ./decode convert to text for commands that expect it.
 * A ReplyError can appear nested inside an array (for example one failed
 * step inside MULTI/EXEC) without aborting the surrounding parse.
 */
export type RespValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | RespValue[]
  | Map<RespValue, RespValue>
  | ReplyError;

/** One decoded frame: a normal request/reply value, or an out of band RESP3 push (pub/sub, invalidation). */
export interface Frame {
  kind: "reply" | "push";
  value: RespValue;
}
