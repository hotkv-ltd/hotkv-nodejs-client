// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// The client as a customer uses it: over the internet, TLS with a password,
// against a public server. Skipped unless HOTKV_REMOTE_HOST is set.
//
//   HOTKV_REMOTE_HOST      host or IP of the server
//   HOTKV_REMOTE_PORT      TLS port (default 6379)
//   HOTKV_REMOTE_PASSWORD  the password (never put it in a file)
//   HOTKV_REMOTE_CA        path to the CA / self-signed certificate (PEM) to verify against
//
// Every key and namespace carries a run-unique prefix and is removed at the
// end. Nothing global is touched (no FLUSHALL, no CONFIG SET). The licensed
// engines (AI caches, budgets, ...) are expected to work: the server under
// test needs a license that covers them, so NOLICENSE is a failure here.

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HotKV } from "../../src/client.js";
import { ReplyError } from "../../src/errors.js";
import type { HotKVOptions } from "../../src/options.js";
import type { PubSubMessage } from "../../src/pubsub.js";
import { sleep } from "./helpers.js";

const HOST = process.env.HOTKV_REMOTE_HOST;
const PORT = Number(process.env.HOTKV_REMOTE_PORT ?? "6379");
const PASSWORD = process.env.HOTKV_REMOTE_PASSWORD ?? "";
const CA = process.env.HOTKV_REMOTE_CA;

/** exec() results carry raw replies: a bulk string is a Buffer (the queued promise of each call is the decoded one). */
const plain = ([e, v]: readonly [Error | null, unknown]): unknown => (e ? "ERR" : Buffer.isBuffer(v) ? v.toString("utf8") : v);

const RUN = `remote-node-${randomBytes(5).toString("hex")}`;

function options(extra?: HotKVOptions): HotKVOptions {
  return {
    host: HOST,
    port: PORT,
    password: PASSWORD,
    tls: { caFile: CA },
    connectTimeoutMs: 15_000,
    commandTimeoutMs: 30_000,
    ...extra,
  };
}

describe.skipIf(!HOST)("remote server over TLS with a password", { timeout: 60_000 }, () => {
  let client: HotKV;
  const keys: string[] = [];
  const key = (name: string): string => {
    const k = `${RUN}:${name}`;
    keys.push(k);
    return k;
  };

  beforeAll(() => {
    client = new HotKV(options());
  });
  afterAll(async () => {
    if (keys.length > 0) await client.del(...keys);
    await client.close();
  });

  describe("connecting", () => {
    it("PING with the options form", async () => {
      expect(await client.ping()).toBe("PONG");
      expect(await client.ping("hello")).toBe("hello");
    });

    it("PING with a hotkvs:// URL carrying the password", async () => {
      const viaUrl = new HotKV({
        url: `hotkvs://:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}`,
        tls: { caFile: CA },
        connectTimeoutMs: 15_000,
        commandTimeoutMs: 30_000,
      });
      try {
        expect(await viaUrl.ping()).toBe("PONG");
        const k = key("url");
        await viaUrl.set(k, "via-url");
        expect(await client.get(k)).toBe("via-url");
      } finally {
        await viaUrl.close();
      }
    });

    it("the same over RESP2", async () => {
      const resp2 = new HotKV(options({ resp3: false }));
      try {
        expect(await resp2.ping()).toBe("PONG");
        const k = key("resp2");
        await resp2.hSet(k, { a: "1" });
        expect(await resp2.hGetAll(k)).toEqual({ a: "1" });
      } finally {
        await resp2.close();
      }
    });

    it("a wrong password fails cleanly with a ReplyError", async () => {
      const bad = new HotKV(options({ password: `${PASSWORD}-wrong` }));
      try {
        const err = await bad.ping().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ReplyError);
        expect((err as ReplyError).code).toMatch(/WRONGPASS|NOAUTH|ERR/);
        // And it does not leave the client unusable for a retry with the same wrong password.
        await expect(bad.ping()).rejects.toBeInstanceOf(ReplyError);
      } finally {
        await bad.close();
      }
    });

    it("no password gets NOAUTH", async () => {
      const anonymous = new HotKV(options({ password: undefined }));
      try {
        await expect(anonymous.get(key("anon"))).rejects.toMatchObject({ code: "NOAUTH" });
      } finally {
        await anonymous.close();
      }
    });

    it("a self-signed certificate is refused without the CA", async () => {
      const unverified = new HotKV(options({ tls: true, connectTimeoutMs: 8000 }));
      try {
        const err = await unverified.ping().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect(String((err as Error).message)).toMatch(/self.signed|certificate|verify|unable/i);
      } finally {
        await unverified.close();
      }
    });

    it("rejectUnauthorized: false connects without the CA (the one insecure-skip-verify test)", async () => {
      const insecure = new HotKV(options({ tls: { rejectUnauthorized: false } }));
      try {
        expect(await insecure.ping()).toBe("PONG");
      } finally {
        await insecure.close();
      }
    });

    it("a client with no TLS against the TLS port fails instead of hanging", async () => {
      const plain = new HotKV(options({ tls: false, connectTimeoutMs: 8000, commandTimeoutMs: 8000 }));
      try {
        await expect(plain.ping()).rejects.toBeInstanceOf(Error);
      } finally {
        await plain.close();
      }
    });
  });

  describe("data types", () => {
    it("strings: SET GET APPEND STRLEN INCR MSET MGET GETDEL", async () => {
      const k = key("str");
      await client.set(k, "hello");
      expect(await client.get(k)).toBe("hello");
      expect(await client.append(k, " world")).toBe(11);
      expect(await client.strLen(k)).toBe(11);
      expect(await client.getRange(k, 0, 4)).toBe("hello");
      const n = key("counter");
      expect(await client.incr(n)).toBe(1);
      expect(await client.incrBy(n, 9)).toBe(10);
      expect(Number(await client.incrByFloat(n, 0.5))).toBe(10.5);
      const a = key("m1");
      const b = key("m2");
      await client.mSet({ [a]: "1", [b]: "2" });
      expect(await client.mGet(a, b, `${RUN}:none`)).toEqual(["1", "2", null]);
      expect(await client.getDel(a)).toBe("1");
      expect(await client.get(a)).toBeNull();
    });

    it("hashes", async () => {
      const k = key("hash");
      expect(await client.hSet(k, { name: "ada", age: "36" })).toBe(2);
      expect(await client.hGet(k, "name")).toBe("ada");
      expect(await client.hGetAll(k)).toEqual({ name: "ada", age: "36" });
      expect(await client.hIncrBy(k, "age", 1)).toBe(37);
      expect(await client.hDel(k, "name")).toBe(1);
      expect(await client.hLen(k)).toBe(1);
    });

    it("lists", async () => {
      const k = key("list");
      expect(await client.rPush(k, "a", "b", "c")).toBe(3);
      expect(await client.lPush(k, "z")).toBe(4);
      expect(await client.lRange(k, 0, -1)).toEqual(["z", "a", "b", "c"]);
      expect(await client.lPop(k)).toBe("z");
      expect(await client.rPop(k)).toBe("c");
      expect(await client.lLen(k)).toBe(2);
    });

    it("sets", async () => {
      const k = key("set");
      expect(await client.sAdd(k, "x", "y", "z")).toBe(3);
      expect(await client.sIsMember(k, "y")).toBe(true);
      expect((await client.sMembers(k)).sort()).toEqual(["x", "y", "z"]);
      expect(await client.sRem(k, "x")).toBe(1);
      expect(await client.sCard(k)).toBe(2);
    });

    it("sorted sets", async () => {
      const k = key("zset");
      expect(await client.zAdd(k, [["a", 1], ["b", 2.5], ["c", 1e-7]])).toBe(3);
      expect(await client.zRange(k, 0, -1)).toEqual(["c", "a", "b"]);
      expect(await client.zRangeByScore(k, 1, 3, { withScores: true })).toEqual([["a", "1"], ["b", "2.5"]]);
      expect(await client.zRank(k, "b")).toBe(2);
      expect(await client.zCard(k)).toBe(3);
    });

    it("streams", async () => {
      const k = key("stream");
      const id1 = await client.xAdd(k, { a: "1" });
      await client.xAdd(k, { a: "2" });
      expect(await client.xLen(k)).toBe(2);
      const range = await client.xRange(k, "-", "+");
      expect(range.map((e) => e.fields)).toEqual([{ a: "1" }, { a: "2" }]);
      expect(range[0]?.id).toBe(id1);
      await client.xGroupCreate(k, "g", "0");
      const read = await client.xReadGroup("g", "c1", { [k]: ">" });
      expect(read?.[k]).toHaveLength(2);
      expect(await client.xAck(k, "g", id1)).toBe(1);
    });

    it("expiry: EXPIRE TTL PERSIST and a key that expires", async () => {
      const k = key("exp");
      await client.set(k, "v");
      expect(await client.expire(k, 100)).toBe(true);
      expect(await client.ttl(k)).toBeGreaterThan(90);
      expect(await client.persist(k)).toBe(true);
      expect(await client.ttl(k)).toBe(-1);
      const short = key("short");
      await client.set(short, "gone", { px: 300 });
      expect(await client.get(short)).toBe("gone");
      await sleep(700);
      expect(await client.get(short)).toBeNull();
    });

    it("a 1 MB value round trips byte for byte", async () => {
      const k = key("mb");
      const blob = randomBytes(1024 * 1024);
      await client.set(k, blob);
      expect(await client.strLen(k)).toBe(blob.length);
      const back = (await client.command("GET", k)) as Buffer;
      expect(Buffer.isBuffer(back)).toBe(true);
      expect(back.equals(blob)).toBe(true);
      const text = key("mbtext");
      const big = "x".repeat(1024 * 1024);
      await client.set(text, big);
      expect(await client.get(text)).toBe(big);
    });
  });

  describe("batching and concurrency", () => {
    it("a pipeline in one round trip", async () => {
      const a = key("p1");
      const b = key("p2");
      const pipeline = client.pipeline();
      pipeline.set(a, "1");
      pipeline.incr(a);
      pipeline.set(b, "x");
      pipeline.get(a);
      const results = await pipeline.exec();
      expect(results.map(plain)).toEqual(["OK", 2, "OK", "2"]);
    });

    it("MULTI/EXEC", async () => {
      const k = key("tx");
      const multi = client.multi();
      multi.set(k, "10");
      multi.incr(k);
      multi.get(k);
      const results = await multi.exec();
      expect(results).not.toBeNull();
      expect((results ?? []).map(plain)).toEqual(["OK", 11, "11"]);
    });

    it("WATCH aborts the transaction when the key changes", async () => {
      const k = key("watch");
      await client.set(k, "1");
      const multi = await client.watch(k);
      await client.set(k, "changed-elsewhere");
      multi.set(k, "from-tx");
      const result = await multi.exec();
      expect(result).toBeNull();
      expect(await client.get(k)).toBe("changed-elsewhere");
    });

    it("pub/sub across separate connections", async () => {
      const channel = `${RUN}:channel`;
      const sub = client.subscribe(channel);
      const psub = client.psubscribe(`${RUN}:pat:*`);
      try {
        const got = new Promise<PubSubMessage>((resolve) => sub.once("message", resolve));
        const pgot = new Promise<PubSubMessage>((resolve) => psub.once("pmessage", resolve));
        await sleep(1500); // let both SUBSCRIBE confirmations cross the internet
        const publisher = new HotKV(options());
        try {
          expect(await publisher.publish(channel, "over the wire")).toBe(1);
          await publisher.publish(`${RUN}:pat:one`, "pattern");
        } finally {
          await publisher.close();
        }
        expect((await got).message).toBe("over the wire");
        const p = await pgot;
        expect(p.message).toBe("pattern");
        expect(p.channel).toBe(`${RUN}:pat:one`);
      } finally {
        await sub.close();
        await psub.close();
      }
    });

    it("concurrent use of one client: 200 INCRs and 100 SET/GETs", async () => {
      const n = key("conc");
      const results = await Promise.all(Array.from({ length: 200 }, () => client.incr(n)));
      expect(new Set(results).size).toBe(200);
      expect(await client.get(n)).toBe("200");
      const pairs = await Promise.all(
        Array.from({ length: 100 }, async (_, i) => {
          const k = `${RUN}:conc:${i}`;
          keys.push(k);
          await client.set(k, `v${i}`);
          return client.get(k);
        }),
      );
      expect(pairs).toEqual(Array.from({ length: 100 }, (_, i) => `v${i}`));
      expect(client.poolStats().total).toBeLessThanOrEqual(10);
    });

    it("reconnects after the server closes a connection", async () => {
      const own = new HotKV(options({ pool: { maxSize: 1 } }));
      try {
        const k = key("reconnect");
        await own.set(k, "before");
        const id = await own.clientId();
        const killer = new HotKV(options());
        try {
          // Closes only this test's own connection by its id.
          expect(await killer.command("CLIENT", "KILL", "ID", id)).toBe(1);
        } finally {
          await killer.close();
        }
        await sleep(300);
        expect(await own.get(k)).toBe("before");
        await own.set(k, "after");
        expect(await own.get(k)).toBe("after");
      } finally {
        await own.close();
      }
    });
  });

  describe("AI features through the typed API", () => {
    const names: Record<string, string[]> = {};
    const name = (kind: string): string => {
      const n = `${RUN}_${kind}`;
      (names[kind] ??= []).push(n);
      return n;
    };

    afterAll(async () => {
      // Best effort: whatever a failed test left behind.
      const drop: Record<string, string[]> = {
        scache: ["SCACHE.DROP"], pcache: ["PCACHE.DROP"], toolcache: ["TOOL.CACHE.DROP"], ncache: ["NCACHE.DROP"],
        guard: ["GUARD.DROP"], rerank: ["RERANK.DROP"], budget: ["LLMBUDGET.DROP"], stats: ["LLMSTATS.DROP"],
        prompt: ["PROMPT.DROP"], dedup: ["EMBED.DEDUP.DROP"], conv: ["AMEM.CONV.DROP"], work: ["AMEM.WORK.CLEAR"],
        epis: ["AMEM.EPIS.CLEAR"], summary: ["AMEM.SUMMARY.DROP"], rag: ["RAG.DROP"], rl: ["RATELIMIT.DROP"],
        tb: ["RATELIMIT.DROP"], ts: ["TS.DELETE"], feature: ["FEATURE.DROP"], vsim: ["VSIM.DROPINDEX"],
      };
      for (const [kind, list] of Object.entries(names)) {
        for (const n of list) {
          await client.execute([...(drop[kind] ?? []), n]).catch(() => undefined);
        }
      }
    });

    it("SCACHE: create, set with an embedding, similar get, stats, drop", async () => {
      const ns = name("scache");
      await client.scacheCreate(ns, 4, { threshold: 0.8 });
      await client.scacheSet(ns, "what is the capital of France", "Paris", [0.9, 0.1, 0, 0]);
      const hit = await client.scacheGet(ns, [0.88, 0.12, 0.01, 0]);
      expect(hit?.response).toBe("Paris");
      expect(hit?.similarity).toBeGreaterThan(0.95);
      expect(await client.scacheGet(ns, [0, 0, 1, 0])).toBeNull();
      const stats = await client.scacheStats(ns);
      expect(stats.entries).toBe(1);
      expect(stats.hits).toBe(1);
      await client.scacheSet(ns, "expires at", "later", [0, 1, 0, 0], { pxat: Date.now() + 600_000 });
      expect(await client.scacheList()).toContain(ns);
      expect(await client.scacheDrop(ns)).toBe(true);
    });

    it("PCACHE: set, get, expiry at an absolute time, stats", async () => {
      const ns = name("pcache");
      await client.pcacheCreate(ns, { maxEntries: 100, costPerHitUsd: 0.000001 });
      await client.pcacheSet(ns, "prompt", "answer", { pxat: Date.now() + 600_000 });
      expect(await client.pcacheGet(ns, "prompt")).toBe("answer");
      expect(await client.pcacheGet(ns, "other")).toBeNull();
      const stats = await client.pcacheStats(ns);
      expect(stats.hits).toBe(1);
      expect(await client.pcacheDrop(ns)).toBe(true);
    });

    it("keyed caches: TOOL.CACHE, NCACHE, GUARD, RERANK", async () => {
      for (const [kind, api] of [
        ["toolcache", { create: (n: string) => client.toolCacheCreate(n), set: (n: string, k: string, v: string) => client.toolCacheSet(n, k, v, { ttlSeconds: 600 }), get: (n: string, k: string) => client.toolCacheGet(n, k), drop: (n: string) => client.toolCacheDrop(n) }],
        ["ncache", { create: (n: string) => client.nCacheCreate(n), set: (n: string, k: string, v: string) => client.nCacheSet(n, k, v), get: (n: string, k: string) => client.nCacheGet(n, k), drop: (n: string) => client.nCacheDrop(n) }],
        ["guard", { create: (n: string) => client.guardCreate(n), set: (n: string, k: string, v: string) => client.guardSet(n, k, v, { pxat: Date.now() + 600_000 }), get: (n: string, k: string) => client.guardGet(n, k), drop: (n: string) => client.guardDrop(n) }],
        ["rerank", { create: (n: string) => client.rerankCreate(n), set: (n: string, k: string, v: string) => client.rerankSet(n, k, v), get: (n: string, k: string) => client.rerankGet(n, k), drop: (n: string) => client.rerankDrop(n) }],
      ] as const) {
        const ns = name(kind);
        await api.create(ns);
        await api.set(ns, "k", `value-of-${kind}`);
        expect(await api.get(ns, "k"), kind).toBe(`value-of-${kind}`);
        expect(await api.get(ns, "missing"), kind).toBeNull();
        expect(await api.drop(ns), kind).toBe(true);
      }
    });

    it("LLMBUDGET with float limits (the exponent-form regression)", async () => {
      const b = name("budget");
      await client.llmBudgetSet(b, 1_000_000, 0.00001, 3600);
      expect((await client.llmBudgetStatus(b)).costLimitUsd).toBeCloseTo(0.00001, 9);
      expect(await client.llmBudgetConsume(b, 10, 0.000001)).toBe(true);
      expect(await client.llmBudgetConsume(b, 10, 0.5)).toBe(false); // over the 0.00001 dollar cap
      const status = await client.llmBudgetStatus(b);
      expect(status.requestsRejected).toBeGreaterThanOrEqual(1);
      expect(await client.llmBudgetList()).toContain(b);
      await client.llmBudgetSet(b, 1_000_000, 123456.789012, 3600);
      expect((await client.llmBudgetStatus(b)).costLimitUsd).toBeCloseTo(123456.789012, 5);
      expect(await client.llmBudgetDrop(b)).toBe(true);
    });

    it("LLMSTATS: bucket, record, get, price", async () => {
      const bucket = name("stats");
      await client.llmStatsBucket(bucket);
      await client.llmStatsRecord(bucket, 100, 50, 0, 0.0000025, 120);
      const snapshot = await client.llmStatsGet(bucket);
      expect(snapshot.requests).toBe(1);
      const model = `${RUN}-model`;
      await client.llmStatsPriceSet(model, 0.00001, 0.00003);
      expect((await client.llmStatsPriceGet(model)).inputUsdPerMtok).toBeCloseTo(0.00001, 9);
      await client.llmStatsPriceDel(model);
      expect(await client.llmStatsDrop(bucket)).toBe(true);
    });

    it("PROMPT registry", async () => {
      const prompt = name("prompt");
      expect(await client.promptPut(prompt, "Hello {{name}}")).toBe(1);
      expect(await client.promptPut(prompt, "Hi {{name}}!")).toBe(2);
      expect((await client.promptLatest(prompt))?.version).toBe(2);
      expect((await client.promptGet(prompt, 1))?.content).toBe("Hello {{name}}");
      expect(await client.promptVersions(prompt)).toEqual([1, 2]);
      expect(await client.promptDrop(prompt)).toBe(true);
    });

    it("EMBED.DEDUP", async () => {
      const ns = name("dedup");
      expect(await client.embedDedupPut(ns, "abc123", "model-x", "0.1,0.2")).toBe(true);
      expect(await client.embedDedupPut(ns, "abc123", "model-x", "0.1,0.2")).toBe(false);
      expect(await client.embedDedupGet(ns, "abc123")).toBe("0.1,0.2");
      expect((await client.embedDedupStats(ns)).entries).toBe(1);
      expect(await client.embedDedupDrop(ns)).toBe(true);
    });

    it("AMEM: conversation, semantic, working, episodic memory", async () => {
      const session = name("conv");
      await client.amemConvCreate(session, { window: 10, pxat: Date.now() + 600_000 });
      await client.amemConvAppend(session, "user", "hello");
      await client.amemConvAppend(session, "assistant", "hi");
      expect(await client.amemConvGet(session)).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);
      expect(await client.amemConvDrop(session)).toBe(true);

      const agent = name("sem");
      await client.amemSemCreate(agent, 3);
      await client.amemSemStore(agent, "f1", "the sky is blue", [1, 0, 0]);
      await client.amemSemStore(agent, "f2", "grass is green", [0, 1, 0], { pxat: Date.now() + 600_000 });
      expect((await client.amemSemRecall(agent, 1, [0.9, 0.1, 0]))[0]?.key).toBe("f1");

      const work = name("work");
      await client.amemWorkSet(work, "scratch", "temp", 600);
      expect(await client.amemWorkGet(work, "scratch")).toBe("temp");
      expect(await client.amemWorkClear(work)).toBe(true);

      const epis = name("epis");
      await client.amemEpisLog(epis, "tool_call", "called search", '{"ok":true}');
      expect((await client.amemEpisStats(epis)).totalEvents).toBe(1);
      expect(await client.amemEpisClear(epis)).toBe(true);
      const results = await client.amemSearch(agent, 3, [1, 0, 0]);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(await client.amemSemForget(agent, "f1")).toBe(true);
      expect(await client.amemSemForget(agent, "f2")).toBe(true);
    });

    it("AMEM.SUMMARY", async () => {
      const agent = name("summary");
      expect(await client.amemSummarySet(agent, "Initial.")).toBe(1);
      expect((await client.amemSummaryGet(agent))?.version).toBe(1);
      expect(await client.amemSummaryDrop(agent)).toBe(true);
    });

    it("RAG: ingest and search", async () => {
      const rag = name("rag");
      await client.ragCreate(rag, 3, { strategy: "fixed", chunkSize: 100, chunkOverlap: 10 });
      expect(await client.ragIngest(rag, "doc-1", "hello world from the remote test", { vectors: [[1, 0, 0]] })).toBeGreaterThanOrEqual(1);
      const results = await client.ragSearch(rag, "hello", { k: 3, alpha: 0.5, vector: [1, 0, 0] });
      expect(results[0]?.docId).toBe("doc-1");
      expect((await client.ragStats(rag)).dimensions).toBe(3);
      await client.ragDrop(rag);
    });

    it("RATELIMIT and GCRA", async () => {
      const rl = name("rl");
      await client.rateLimitCreate(rl, 2, 60_000);
      expect((await client.rateLimitCheck(rl, "u1")).allowed).toBe(true);
      expect((await client.rateLimitCheck(rl, "u1")).allowed).toBe(true);
      expect((await client.rateLimitCheck(rl, "u1")).allowed).toBe(false);
      await client.rateLimitDrop(rl);
      const tb = name("tb");
      await client.rateLimitCreate(tb, 5, 1000, { algo: "token_bucket", refill: 0.001 });
      expect((await client.rateLimitCheck(tb, "u")).allowed).toBe(true);
      await client.rateLimitDrop(tb);

      const g = key("gcra");
      const first = await client.gcraLimit(g, 60_000, 2);
      expect(first.denied).toBe(false);
      await client.gcraLimit(g, 60_000, 2);
      expect((await client.gcraLimit(g, 60_000, 2)).denied).toBe(true);
      expect(await client.gcraReset(g)).toBeGreaterThanOrEqual(1);
    });

    it("TS: time series", async () => {
      const ts = name("ts");
      const base = Date.now();
      await client.tsCreate(ts, { retentionMs: 3_600_000, labels: { run: RUN } });
      await client.tsAdd(ts, base, 0.00025);
      await client.tsAdd(ts, base + 1000, "2.5");
      const range = await client.tsRange(ts, base - 1, base + 2000);
      expect(range).toHaveLength(2);
      expect(Number(range[0]?.value)).toBeCloseTo(0.00025, 9);
      expect((await client.tsInfo(ts)).totalSamples).toBe(2);
      await client.tsDelete(ts);
    });

    it("FEATURE store", async () => {
      const group = name("feature");
      await client.featureCreate(group, "remote test", [
        { name: "age", type: "int64" },
        { name: "score", type: "double" },
      ]);
      await client.featureSet(group, "e1", { age: 30, score: 4.5 });
      expect((await client.featureGet(group, "e1"))?.values.age).toBe("30");
      await client.featureSetAt(group, "e2", Date.now(), { age: 31, score: 1e-7 });
      expect((await client.featureBatch(group, ["e1", "e2", "none"])).map((r) => r !== null)).toEqual([true, true, false]);
      await client.execute(["FEATURE.DROP", group]);
    });

    it("VSIM: vector index", async () => {
      const index = name("vsim");
      await client.vsimCreateIndex(index, 3, { metric: "cosine" });
      expect(await client.vsimSet(index, "a", [1, 0, 1e-7])).toBe(true);
      expect(await client.vsimSet(index, "b", [0, 1, 0])).toBe(true);
      const hits = await client.vsimSearch(index, 1, [1, 0, 0]);
      expect(hits[0]?.key).toBe("a");
      expect((await client.vsimInfo(index)).vectors).toBe(2);
      await client.vsimDropIndex(index);
    });
  });
});
