// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import { resolveOptions } from "../../src/options.js";

describe("resolveOptions", () => {
  it("applies defaults when given nothing", () => {
    const o = resolveOptions();
    expect(o.host).toBe("127.0.0.1");
    expect(o.port).toBe(6379);
    expect(o.db).toBe(0);
    expect(o.resp3).toBe(true);
    expect(o.maxRetries).toBe(1);
    expect(o.keepAlive).toBe(true);
    expect(o.tls).toBeUndefined();
    expect(o.pool.maxSize).toBe(10);
    expect(o.pool.idleTimeoutMs).toBe(30000);
    expect(o.pool.acquireTimeoutMs).toBe(o.connectTimeoutMs);
  });

  it("accepts a bare URL string", () => {
    const o = resolveOptions("hotkv://127.0.0.1:6402/2");
    expect(o.host).toBe("127.0.0.1");
    expect(o.port).toBe(6402);
    expect(o.db).toBe(2);
  });

  it("lets explicit fields override the URL", () => {
    const o = resolveOptions({ url: "hotkv://127.0.0.1:6402/2", db: 5, port: 7000 });
    expect(o.port).toBe(7000);
    expect(o.db).toBe(5);
  });

  it("sets no TLS servername for an IP address host (RFC 6066), and still for a name", () => {
    expect(resolveOptions({ host: "203.0.113.10", tls: true }).tls?.servername).toBeUndefined();
    expect(resolveOptions({ url: "hotkvs://[::1]:6379" }).tls?.servername).toBeUndefined();
    expect(resolveOptions({ host: "db.example.com", tls: true }).tls?.servername).toBe("db.example.com");
    expect(resolveOptions({ host: "203.0.113.10", tls: { servername: "db.example.com" } }).tls?.servername).toBe("db.example.com");
  });

  it("enables TLS from a hotkvs:// URL with a default servername", () => {
    const o = resolveOptions("hotkvs://db.example.com:6400");
    expect(o.tls).toBeDefined();
    expect(o.tls?.servername).toBe("db.example.com");
    expect(o.tls?.rejectUnauthorized).toBe(true);
  });

  it("accepts tls: true as shorthand for default TLS options", () => {
    const o = resolveOptions({ host: "db.example.com", tls: true });
    expect(o.tls?.servername).toBe("db.example.com");
  });

  it("passes through a detailed TLS options object, including insecure test overrides", () => {
    const o = resolveOptions({ host: "db.example.com", tls: { rejectUnauthorized: false, servername: "override" } });
    expect(o.tls?.rejectUnauthorized).toBe(false);
    expect(o.tls?.servername).toBe("override");
  });

  it("resolves pool options with independent defaults", () => {
    const o = resolveOptions({ pool: { maxSize: 3 } });
    expect(o.pool.maxSize).toBe(3);
    expect(o.pool.idleTimeoutMs).toBe(30000);
  });

  it("carries a unix socket path through untouched", () => {
    const o = resolveOptions({ path: "/tmp/hotkv.sock" });
    expect(o.path).toBe("/tmp/hotkv.sock");
  });
});
