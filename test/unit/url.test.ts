// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import { HotKVError } from "../../src/errors.js";
import { parseConnectionURL } from "../../src/url.js";

describe("parseConnectionURL", () => {
  it("parses a plain hotkv:// URL", () => {
    const u = parseConnectionURL("hotkv://127.0.0.1:6402");
    expect(u).toMatchObject({ host: "127.0.0.1", port: 6402, tls: false });
    expect(u.username).toBeUndefined();
    expect(u.password).toBeUndefined();
    expect(u.db).toBeUndefined();
  });

  it("takes an IPv6 literal without its brackets", () => {
    expect(parseConnectionURL("hotkv://[::1]:6402")).toMatchObject({ host: "::1", port: 6402 });
    expect(parseConnectionURL("hotkvs://:pw@[2001:db8::7]/2")).toMatchObject({ host: "2001:db8::7", tls: true, password: "pw", db: 2 });
  });

  it("defaults the port to 6379", () => {
    expect(parseConnectionURL("hotkv://example.com").port).toBe(6379);
  });

  it("enables TLS for hotkvs://", () => {
    expect(parseConnectionURL("hotkvs://example.com:6400").tls).toBe(true);
  });

  it("accepts redis:// and rediss:// for drop-in migration", () => {
    expect(parseConnectionURL("redis://example.com:6379").tls).toBe(false);
    expect(parseConnectionURL("rediss://example.com:6379").tls).toBe(true);
  });

  it("parses user:pass@ credentials", () => {
    const u = parseConnectionURL("hotkv://alice:secret@example.com:6379");
    expect(u.username).toBe("alice");
    expect(u.password).toBe("secret");
  });

  it("treats a single userinfo component as the legacy password-only form", () => {
    const u = parseConnectionURL("hotkv://secret@example.com:6379");
    expect(u.password).toBe("secret");
    expect(u.username).toBeUndefined();
  });

  it("parses the database index from the path", () => {
    expect(parseConnectionURL("hotkv://example.com/3").db).toBe(3);
  });

  it("URL decodes credentials", () => {
    const u = parseConnectionURL("hotkv://us%20er:pa%40ss@example.com");
    expect(u.username).toBe("us er");
    expect(u.password).toBe("pa@ss");
  });

  it("rejects an unsupported scheme", () => {
    expect(() => parseConnectionURL("http://example.com")).toThrow(HotKVError);
  });

  it("rejects a garbage URL", () => {
    expect(() => parseConnectionURL("not a url")).toThrow(HotKVError);
  });

  it("rejects a non-numeric database path", () => {
    expect(() => parseConnectionURL("hotkv://example.com/notanumber")).toThrow(HotKVError);
  });
});
