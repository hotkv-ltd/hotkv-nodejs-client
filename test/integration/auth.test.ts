// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// AUTH against a server started with a password (`hotkv --requirepass ...`).
// Set HOTKV_TEST_AUTH_URL to its URL with the password, for example
// hotkv://:the-password@127.0.0.1:6379. Skipped without it.

import { describe, expect, it } from "vitest";
import { HotKV } from "../../src/client.js";
import { ReplyError } from "../../src/errors.js";

const AUTH_URL = process.env.HOTKV_TEST_AUTH_URL;

describe.skipIf(!AUTH_URL)("AUTH against a password-protected server", () => {
  const url = AUTH_URL ?? "";
  const withoutPassword = url.replace(/\/\/[^@]*@/, "//");
  const withPassword = (password: string): string => url.replace(/\/\/[^@]*@/, `//:${encodeURIComponent(password)}@`);

  it("the right password in the URL authenticates every pooled connection", async () => {
    const client = new HotKV(url);
    try {
      expect(await client.ping()).toBe("PONG");
      const key = `auth-test:${process.pid}:${Date.now()}`;
      await client.set(key, "v");
      const results = await Promise.all(Array.from({ length: 20 }, () => client.get(key)));
      expect(new Set(results)).toEqual(new Set(["v"]));
      await client.del(key);
    } finally {
      await client.close();
    }
  });

  it("the options form (host, port, password) authenticates too", async () => {
    const u = new URL(url);
    const client = new HotKV({ host: u.hostname, port: Number(u.port), password: decodeURIComponent(u.password || u.username) });
    try {
      expect(await client.ping()).toBe("PONG");
    } finally {
      await client.close();
    }
  });

  it("a wrong password fails with a ReplyError, not a hang or a crash", async () => {
    const client = new HotKV(withPassword("definitely-not-the-password"));
    try {
      await expect(client.ping()).rejects.toBeInstanceOf(ReplyError);
      await expect(client.ping()).rejects.toThrow(/WRONGPASS|invalid|NOAUTH|AUTH/i);
    } finally {
      await client.close();
    }
  });

  it("no password gets NOAUTH", async () => {
    const client = new HotKV(withoutPassword);
    try {
      await expect(client.get("x")).rejects.toMatchObject({ code: "NOAUTH" });
    } finally {
      await client.close();
    }
  });

  it("AUTH with a username and the wrong password fails", async () => {
    const u = new URL(url);
    const client = new HotKV({ host: u.hostname, port: Number(u.port), username: "default", password: "wrong" });
    try {
      await expect(client.ping()).rejects.toBeInstanceOf(ReplyError);
    } finally {
      await client.close();
    }
  });

  it("SELECT through the URL path works with AUTH", async () => {
    const client = new HotKV(`${url.replace(/\/$/, "")}/3`);
    try {
      expect(await client.ping()).toBe("PONG");
      await client.set(`auth-db3:${process.pid}`, "1");
      expect(await client.dbSize()).toBeGreaterThanOrEqual(1);
      await client.del(`auth-db3:${process.pid}`);
    } finally {
      await client.close();
    }
  });
});
