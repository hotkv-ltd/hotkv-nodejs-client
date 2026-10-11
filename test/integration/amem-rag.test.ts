// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

describe.skipIf(!hasServer)("AMEM.* (agent memory)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("amem");
  });
  afterAll(async () => {
    await client.close();
  });

  it("conversation memory: CREATE / APPEND / GET / WINDOW / CLEAR / DROP", async (ctx) => {
    const session = `${p}_conv`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.amemConvCreate(session, { window: 10 });
      await client.amemConvAppend(session, "user", "hello");
      await client.amemConvAppend(session, "assistant", "hi there");
      const turns = await client.amemConvGet(session);
      expect(turns).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ]);
      const windowed = await client.amemConvWindow(session, 1);
      expect(windowed).toEqual([{ role: "assistant", content: "hi there" }]);
      expect(await client.amemConvClear(session)).toBe(true);
      expect(await client.amemConvDrop(session)).toBe(true);
    });
  });

  it("semantic memory: CREATE / STORE / RECALL / FORGET / LIST", async (ctx) => {
    const agent = `${p}_sem`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.amemSemCreate(agent, 3);
      await client.amemSemStore(agent, "fact1", "the sky is blue", [1, 0, 0]);
      await client.amemSemStore(agent, "fact2", "grass is green", [0, 1, 0]);
      const recalled = await client.amemSemRecall(agent, 1, [1, 0, 0]);
      expect(recalled[0]?.key).toBe("fact1");
      expect((await client.amemSemList(agent)).sort()).toEqual(["fact1", "fact2"]);
      expect(await client.amemSemForget(agent, "fact2")).toBe(true);
    });
  });

  it("working memory: SET / GET / DEL / CLEAR / LIST", async (ctx) => {
    const session = `${p}_work`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.amemWorkSet(session, "scratch", "temp-value");
      expect(await client.amemWorkGet(session, "scratch")).toBe("temp-value");
      expect(await client.amemWorkList(session)).toEqual(["scratch"]);
      expect(await client.amemWorkDel(session, "scratch")).toBe(true);
      expect(await client.amemWorkGet(session, "scratch")).toBeNull();
      await client.amemWorkClear(session);
    });
  });

  it("episodic memory: LOG / QUERY / STATS / CLEAR", async (ctx) => {
    const agent = `${p}_epis`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.amemEpisLog(agent, "tool_call", "called search()", '{"ok":true}');
      const events = await client.amemEpisQuery(agent);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("tool_call");
      const stats = await client.amemEpisStats(agent);
      expect(stats.totalEvents).toBe(1);
      expect(await client.amemEpisClear(agent)).toBe(true);
    });
  });

  it("AMEM.SEARCH combines semantic, episodic and working memory", async (ctx) => {
    const agent = `${p}_search`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.amemSemCreate(agent, 2);
      await client.amemSemStore(agent, "k1", "content one", [1, 0]);
      const results = await client.amemSearch(agent, 5, [1, 0]);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("AMEM.SUMMARY.* needs a license with the amem-summary feature", async (ctx) => {
    const agent = `${p}_summary`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      const v1 = await client.amemSummarySet(agent, "Initial summary.");
      expect(v1).toBe(1);
      const v2 = await client.amemSummaryAppend(agent, " More detail.");
      expect(v2).toBeGreaterThan(v1);
      const record = await client.amemSummaryGet(agent);
      expect(record?.version).toBe(v2);
      expect(await client.amemSummaryList()).toContain(agent);
      expect(await client.amemSummaryDrop(agent)).toBe(true);
    });
  });
});

describe.skipIf(!hasServer)("RAG.* (retrieval augmented generation)", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("rag");
  });
  afterAll(async () => {
    await client.close();
  });

  it("CREATE / INGEST / SEARCH / STATS / LIST / DROP", async (ctx) => {
    const pipeline = `${p}_pipeline`;
    await runOrSkipIfNotLicensed(ctx, async () => {
      await client.ragCreate(pipeline, 3, { strategy: "fixed", chunkSize: 100, chunkOverlap: 10 });

      const chunks = await client.ragIngest(pipeline, "doc-1", "hello world", {
        vectors: [[1, 0, 0]],
        meta: { source: "unit-test" },
      });
      expect(chunks).toBeGreaterThanOrEqual(1);

      const results = await client.ragSearch(pipeline, "hello", { k: 5, alpha: 0.5, vector: [1, 0, 0] });
      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results[0]?.docId).toBe("doc-1");
      }

      const stats = await client.ragStats(pipeline);
      expect(stats.name).toBe(pipeline);
      expect(stats.dimensions).toBe(3);

      expect(await client.ragList()).toContain(pipeline);
      await client.ragDrop(pipeline);
    });
  });
});
