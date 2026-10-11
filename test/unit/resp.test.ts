// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import { ReplyError } from "../../src/errors.js";
import { RespReader } from "../../src/resp/reader.js";
import type { Frame } from "../../src/resp/types.js";
import { encodeCommand, encodeCommands } from "../../src/resp/writer.js";

function parseAll(bytes: Buffer): Frame[] {
  const reader = new RespReader();
  reader.feed(bytes);
  return [...reader.next()];
}

function b(s: string): Buffer {
  return Buffer.from(s, "binary");
}

describe("RespReader: RESP2 types", () => {
  it("parses a simple string", () => {
    const [frame] = parseAll(b("+OK\r\n"));
    expect(frame?.value).toBe("OK");
    expect(frame?.kind).toBe("reply");
  });

  it("parses an error with its prefix", () => {
    const [frame] = parseAll(b("-ERR bad thing\r\n"));
    expect(frame?.value).toBeInstanceOf(ReplyError);
    const err = frame?.value as ReplyError;
    expect(err.code).toBe("ERR");
    expect(err.raw).toBe("ERR bad thing");
  });

  it("parses an integer", () => {
    const [frame] = parseAll(b(":1000\r\n"));
    expect(frame?.value).toBe(1000);
  });

  it("parses a negative integer", () => {
    const [frame] = parseAll(b(":-42\r\n"));
    expect(frame?.value).toBe(-42);
  });

  it("parses a bulk string as a Buffer", () => {
    const [frame] = parseAll(b("$5\r\nhello\r\n"));
    expect(Buffer.isBuffer(frame?.value)).toBe(true);
    expect((frame?.value as Buffer).toString()).toBe("hello");
  });

  it("parses an empty bulk string", () => {
    const [frame] = parseAll(b("$0\r\n\r\n"));
    expect((frame?.value as Buffer).length).toBe(0);
  });

  it("parses a null bulk string as null", () => {
    const [frame] = parseAll(b("$-1\r\n"));
    expect(frame?.value).toBeNull();
  });

  it("parses an array of bulk strings", () => {
    const [frame] = parseAll(b("*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n"));
    const arr = frame?.value as Buffer[];
    expect(arr.map((x) => x.toString())).toEqual(["foo", "bar"]);
  });

  it("parses a null array as null", () => {
    const [frame] = parseAll(b("*-1\r\n"));
    expect(frame?.value).toBeNull();
  });

  it("parses an empty array", () => {
    const [frame] = parseAll(b("*0\r\n"));
    expect(frame?.value).toEqual([]);
  });

  it("parses nested arrays", () => {
    const [frame] = parseAll(b("*2\r\n*2\r\n:1\r\n:2\r\n*2\r\n:3\r\n:4\r\n"));
    expect(frame?.value).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("keeps a nested error inside an array instead of throwing", () => {
    const [frame] = parseAll(b("*2\r\n+OK\r\n-ERR bad\r\n"));
    const arr = frame?.value as unknown[];
    expect(arr[0]).toBe("OK");
    expect(arr[1]).toBeInstanceOf(ReplyError);
  });

  it("is binary safe: a bulk string can contain raw CR, LF and NUL bytes", () => {
    const payload = Buffer.from([0x00, 0x0d, 0x0a, 0x01, 0xff]);
    const wire = Buffer.concat([Buffer.from(`$${payload.length}\r\n`), payload, Buffer.from("\r\n")]);
    const [frame] = parseAll(wire);
    expect(Buffer.compare(frame?.value as Buffer, payload)).toBe(0);
  });
});

describe("RespReader: RESP3 types", () => {
  it("parses null (_)", () => {
    const [frame] = parseAll(b("_\r\n"));
    expect(frame?.value).toBeNull();
  });

  it("parses booleans (#t / #f)", () => {
    expect(parseAll(b("#t\r\n"))[0]?.value).toBe(true);
    expect(parseAll(b("#f\r\n"))[0]?.value).toBe(false);
  });

  it("parses doubles, including inf/-inf/nan", () => {
    expect(parseAll(b(",3.14\r\n"))[0]?.value).toBeCloseTo(3.14);
    expect(parseAll(b(",inf\r\n"))[0]?.value).toBe(Infinity);
    expect(parseAll(b(",-inf\r\n"))[0]?.value).toBe(-Infinity);
    expect(Number.isNaN(parseAll(b(",nan\r\n"))[0]?.value)).toBe(true);
  });

  it("parses big numbers as bigint", () => {
    const [frame] = parseAll(b("(3492890328409238509324850943850943825024385\r\n"));
    expect(frame?.value).toBe(3492890328409238509324850943850943825024385n);
  });

  it("parses a bulk error (!) like a simple error", () => {
    const text = "SYNTAX invalid syntax";
    const [frame] = parseAll(b(`!${text.length}\r\n${text}\r\n`));
    expect(frame?.value).toBeInstanceOf(ReplyError);
    expect((frame?.value as ReplyError).code).toBe("SYNTAX");
  });

  it("parses a verbatim string, stripping the 3 letter format prefix", () => {
    const payload = "txt:Some string";
    const [frame] = parseAll(b(`=${payload.length}\r\n${payload}\r\n`));
    expect(frame?.value).toBe("Some string");
  });

  it("parses a map into a Map", () => {
    const [frame] = parseAll(b("%2\r\n+key1\r\n:1\r\n+key2\r\n:2\r\n"));
    const map = frame?.value as Map<unknown, unknown>;
    expect(map.get("key1")).toBe(1);
    expect(map.get("key2")).toBe(2);
  });

  it("parses a set like an array", () => {
    const [frame] = parseAll(b("~2\r\n+a\r\n+b\r\n"));
    expect(frame?.value).toEqual(["a", "b"]);
  });

  it("tags a push frame distinctly from a reply", () => {
    const [frame] = parseAll(b(">2\r\n+pubsub\r\n+message\r\n"));
    expect(frame?.kind).toBe("push");
    expect(frame?.value).toEqual(["pubsub", "message"]);
  });

  it("consumes an attribute prefix and returns the reply that follows it", () => {
    const [frame] = parseAll(b("|1\r\n+key\r\n+val\r\n+OK\r\n"));
    expect(frame?.value).toBe("OK");
  });
});

describe("RespReader: streaming across chunk boundaries", () => {
  it("yields nothing until a full reply has arrived", () => {
    const reader = new RespReader();
    reader.feed(b("$5\r\nhel"));
    expect([...reader.next()]).toEqual([]);
    reader.feed(b("lo\r\n"));
    const [frame] = [...reader.next()];
    expect((frame?.value as Buffer).toString()).toBe("hello");
  });

  it("resumes correctly no matter where the split falls, byte by byte", () => {
    const wire = b("*3\r\n$3\r\nfoo\r\n:42\r\n+OK\r\n");
    const reader = new RespReader();
    const frames: Frame[] = [];
    for (let i = 0; i < wire.length; i++) {
      reader.feed(wire.subarray(i, i + 1));
      frames.push(...reader.next());
    }
    expect(frames).toHaveLength(1);
    const arr = frames[0]?.value as unknown[];
    expect((arr[0] as Buffer).toString()).toBe("foo");
    expect(arr[1]).toBe(42);
    expect(arr[2]).toBe("OK");
  });

  it("parses several replies queued in a single feed, in order (pipelining)", () => {
    const reader = new RespReader();
    reader.feed(b("+OK\r\n+OK\r\n:5\r\n"));
    const frames = [...reader.next()];
    expect(frames.map((f) => f.value)).toEqual(["OK", "OK", 5]);
  });

  it("leaves a half delivered second reply buffered for the next feed", () => {
    const reader = new RespReader();
    reader.feed(b("+OK\r\n+PAR"));
    const frames = [...reader.next()];
    expect(frames.map((f) => f.value)).toEqual(["OK"]);
    reader.feed(b("TIAL\r\n"));
    expect([...reader.next()].map((f) => f.value)).toEqual(["PARTIAL"]);
  });
});

describe("encodeCommand", () => {
  it("encodes a command as a RESP multibulk array", () => {
    const wire = encodeCommand(["SET", "key", "value"]);
    expect(wire.toString()).toBe("*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n");
  });

  it("stringifies numeric arguments", () => {
    const wire = encodeCommand(["INCRBY", "key", 42]);
    expect(wire.toString()).toBe("*3\r\n$6\r\nINCRBY\r\n$3\r\nkey\r\n$2\r\n42\r\n");
  });

  it("is binary safe for Buffer arguments, using their byte length", () => {
    const value = Buffer.from([0x00, 0x01, 0xff]);
    const wire = encodeCommand(["SET", "key", value]);
    const reader = new RespReader();
    reader.feed(wire);
    const [frame] = [...reader.next()];
    const arr = frame?.value as Buffer[];
    expect(Buffer.compare(arr[2] as Buffer, value)).toBe(0);
  });

  it("uses UTF-8 byte length, not JS string length, for multibyte characters", () => {
    const wire = encodeCommand(["SET", "key", "café"]);
    // "café" is 4 JS chars but 5 UTF-8 bytes (é is 2 bytes).
    expect(wire.toString()).toContain("$5\r\ncafé\r\n");
  });

  it("encodeCommands concatenates several encoded commands back to back", () => {
    const wire = encodeCommands([
      ["GET", "a"],
      ["GET", "b"],
    ]);
    expect(wire.toString()).toBe("*2\r\n$3\r\nGET\r\n$1\r\na\r\n*2\r\n$3\r\nGET\r\n$1\r\nb\r\n");
  });
});
