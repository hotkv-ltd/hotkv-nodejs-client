// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Commands the client has no typed method for are reached with
// client.command(...) / client.execute([...]). This runs them live (the newer
// hash and string commands, the probabilistic structures, CLIENT TRACKING, the
// enterprise administration commands) and checks the replies, so the README's
// statement about the generic path is tested. The licensed ones skip on NOLICENSE.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { ReplyError } from "../../src/errors.js";
import { hasServer, isCluster, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
// RESP3 (the default) answers the Bloom filter commands with booleans, RESP2 with 0 and 1.
const flag = (v: unknown): number => (v === true ? 1 : v === false ? 0 : Number(v));
const texts = (v: unknown): string[] => (v as unknown[]).map(text);

describe.skipIf(!hasServer)("commands without a typed method, through command()", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("generic");
  });
  afterAll(async () => {
    await client.close();
  });

  it("HGETEX, HGETDEL, HSETEX", async () => {
    const h = `${p}:h`;
    await client.hSet(h, { a: "1", b: "2", c: "3" });
    expect(texts(await client.command("HGETEX", h, "EX", 100, "FIELDS", 1, "a"))).toEqual(["1"]);
    const ttl = (await client.hTtl(h, ["a"]))[0] as number;
    expect(ttl).toBeGreaterThan(90);
    const deleted = (await client.command("HGETDEL", h, "FIELDS", 2, "b", "nope")) as unknown[];
    expect(text(deleted[0])).toBe("2");
    expect(deleted[1]).toBeNull();
    expect(await client.hExists(h, "b")).toBe(false);
    expect(await client.command("HSETEX", h, "EX", 100, "FIELDS", 1, "d", "4")).toBe(1);
    expect(await client.hGet(h, "d")).toBe("4");
    await client.del(h);
  });

  it("MSETEX, DELEX", async () => {
    if (isCluster) return;
    const k1 = `${p}:m1`;
    const k2 = `${p}:m2`;
    expect(await client.command("MSETEX", 2, k1, "v1", k2, "v2", "EX", 100)).toBe(1);
    expect(await client.mGet(k1, k2)).toEqual(["v1", "v2"]);
    expect(await client.ttl(k1)).toBeGreaterThan(90);
    const k = `${p}:d`;
    await client.set(k, "v");
    expect(await client.command("DELEX", k, "IFEQ", "other")).toBe(0);
    expect(await client.exists(k)).toBe(1);
    expect(await client.command("DELEX", k, "IFEQ", "v")).toBe(1);
    expect(await client.exists(k)).toBe(0);
    await client.del(k1, k2);
  });

  it("XCFGSET", async () => {
    const s = `${p}:xs`;
    await client.xAdd(s, { a: "b" });
    expect(text(await client.command("XCFGSET", s, "IDMP-DURATION", 100, "IDMP-MAXSIZE", 100))).toBe("OK");
    await client.del(s);
  });

  it("BF, CMS, TOPK", async () => {
    const bf = `${p}:bf`;
    expect(text(await client.command("BF.RESERVE", bf, "0.01", 100))).toBe("OK");
    expect(flag(await client.command("BF.ADD", bf, "x"))).toBe(1);
    expect(flag(await client.command("BF.EXISTS", bf, "x"))).toBe(1);
    expect(flag(await client.command("BF.EXISTS", bf, "y"))).toBe(0);
    const cms = `${p}:cms`;
    expect(text(await client.command("CMS.INITBYDIM", cms, 100, 5))).toBe("OK");
    expect(await client.command("CMS.INCRBY", cms, "a", 3)).toEqual([3]);
    expect(await client.command("CMS.QUERY", cms, "a", "b")).toEqual([3, 0]);
    const tk = `${p}:tk`;
    expect(text(await client.command("TOPK.RESERVE", tk, 3))).toBe("OK");
    await client.command("TOPK.ADD", tk, "a", "b");
    expect(texts(await client.command("TOPK.LIST", tk)).sort()).toEqual(["a", "b"]);
    await client.del(bf, cms, tk);
  });

  it("CLIENT TRACKING, TRACKINGINFO, GETREDIR, CACHING on a dedicated connection", async () => {
    if (isCluster) return;
    const own = makeClient({ resp3: false, pool: { maxSize: 1 } });
    try {
      const info = texts(await own.command("CLIENT", "TRACKINGINFO"));
      expect(info).toContain("flags");
      expect(await own.command("CLIENT", "GETREDIR")).toBe(-1);
      expect(text(await own.command("CLIENT", "TRACKING", "off"))).toBe("OK");
      await expect(own.command("CLIENT", "CACHING", "yes")).rejects.toBeInstanceOf(ReplyError);
    } finally {
      await own.close();
    }
  });

  it("administration commands: AUDIT.INFO, ENCRYPTION.INFO, REPLICATION.INFO, TENANT.LIST, IAM.ROLE.LIST", async (ctx) => {
    if (isCluster) return ctx.skip("per-node administration commands");
    await runOrSkipIfNotLicensed(ctx, async () => {
      const audit = texts(await client.command("AUDIT.INFO"));
      expect(audit).toContain("total_entries");
      expect(texts(await client.command("ENCRYPTION.INFO"))).toContain("algorithm");
      expect(texts(await client.command("REPLICATION.INFO"))).toContain("role");
      expect(Array.isArray(await client.command("TENANT.LIST"))).toBe(true);
      expect(Array.isArray(await client.command("IAM.ROLE.LIST"))).toBe(true);
    });
  });

  it("FEATURE.SETAT through the typed method featureSetAt()", async (ctx) => {
    const group = `${p}_fsa`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.featureCreate(group, "test group", [{ name: "score", type: "double" }]);
      await client.featureSetAt(group, "e1", 1_700_000_000_000, { score: 1.5 });
      const rec = await client.featureGet(group, "e1");
      expect(rec?.values.score).toMatch(/^1\.5/);
      expect(rec?.updatedAtMs).toBe(1_700_000_000_000);
      await client.execute(["FEATURE.DROP", group]);
    });
  });

  it("commands only a cluster has answer an error, not a crash", async () => {
    if (isCluster) return;
    for (const args of [["CLUSTERSCAN", "0"], ["TRIMSLOTS", "0", "1"], ["SFLUSH", "0", "100"]]) {
      const reply = await client.execute(args).then(
        () => "ok",
        (err: unknown) => (err instanceof ReplyError ? err.code : String(err)),
      );
      expect(["ok", "ERR"]).toContain(reply);
    }
  });
});
