// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { arr, num } from "../resp/decode.js";
import type { CommandArg } from "../resp/types.js";

export type BitOp = "AND" | "OR" | "XOR" | "NOT";

export interface BitFieldOp {
  /** "GET u8 0", "SET i16 #1 100", "INCRBY u8 0 10", spelled as three fields. */
  op: "GET" | "SET" | "INCRBY";
  type: string;
  offset: string | number;
  value?: number;
  overflow?: "WRAP" | "SAT" | "FAIL";
}

export interface BitmapCommands {
  /** SETBIT key offset 0|1: the previous bit value. */
  setBit(key: string, offset: number, value: 0 | 1): Promise<number>;
  /** GETBIT key offset. */
  getBit(key: string, offset: number): Promise<number>;
  /** BITCOUNT key [start end [BYTE|BIT]]. */
  bitCount(key: string, range?: { start: number; end: number; unit?: "BYTE" | "BIT" }): Promise<number>;
  /** BITPOS key bit [start [end [BYTE|BIT]]]. */
  bitPos(
    key: string,
    bit: 0 | 1,
    range?: { start: number; end?: number; unit?: "BYTE" | "BIT" },
  ): Promise<number>;
  /** BITOP AND|OR|XOR|NOT destination key [key ...]. */
  bitOp(op: BitOp, destination: string, ...keys: string[]): Promise<number>;
  /** BITFIELD key [GET|SET|INCRBY ...] [OVERFLOW WRAP|SAT|FAIL]: one result per sub operation. */
  bitField(key: string, ops: BitFieldOp[]): Promise<number[]>;
}

export function installBitmapCommands(proto: object): void {
  Object.assign(proto, {
    async setBit(this: Executor, key: string, offset: number, value: 0 | 1) {
      return num(await this.execute(["SETBIT", key, offset, value]));
    },
    async getBit(this: Executor, key: string, offset: number) {
      return num(await this.execute(["GETBIT", key, offset]));
    },
    async bitCount(this: Executor, key: string, range?: { start: number; end: number; unit?: "BYTE" | "BIT" }) {
      const args: CommandArg[] = ["BITCOUNT", key];
      if (range) {
        args.push(range.start, range.end);
        if (range.unit) args.push(range.unit);
      }
      return num(await this.execute(args));
    },
    async bitPos(this: Executor, key: string, bit: 0 | 1, range?: { start: number; end?: number; unit?: "BYTE" | "BIT" }) {
      const args: CommandArg[] = ["BITPOS", key, bit];
      if (range) {
        args.push(range.start);
        if (range.end !== undefined) args.push(range.end);
        if (range.unit) args.push(range.unit);
      }
      return num(await this.execute(args));
    },
    async bitOp(this: Executor, op: BitOp, destination: string, ...keys: string[]) {
      return num(await this.execute(["BITOP", op, destination, ...keys]));
    },
    async bitField(this: Executor, key: string, ops: BitFieldOp[]) {
      const args: CommandArg[] = ["BITFIELD", key];
      for (const o of ops) {
        if (o.overflow) args.push("OVERFLOW", o.overflow);
        if (o.op === "SET") args.push("SET", o.type, o.offset, o.value ?? 0);
        else if (o.op === "INCRBY") args.push("INCRBY", o.type, o.offset, o.value ?? 0);
        else args.push("GET", o.type, o.offset);
      }
      return arr(await this.execute(args)).map(num);
    },
  });
}
