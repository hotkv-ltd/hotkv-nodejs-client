// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { Embeddings } from "@langchain/core/embeddings";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Generation } from "@langchain/core/outputs";
import type { HotKV } from "../../src/client.js";
import { HotKVCache, HotKVSemanticCache } from "../../src/langchain/index.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

class ControlledEmbeddings extends Embeddings {
  constructor(private readonly vectors: Record<string, number[]>) {
    super({});
  }
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedQuery(t)));
  }
  async embedQuery(text: string): Promise<number[]> {
    return this.vectors[text] ?? [0, 0, 1];
  }
}

describe.skipIf(!hasServer)("@hotkv/client/langchain", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("langchainjs");
  });
  afterAll(async () => {
    await client.close();
  });

  describe("HotKVCache (exact match)", () => {
    it("first call hits the model, an identical second call is served by HotKV", async () => {
      const cache = new HotKVCache(client, { namespace: p + "exact" });
      const chat = new FakeListChatModel({ responses: ["first-answer", "second-answer"], cache });

      const first = await chat.invoke([new HumanMessage("what is HotKV?")]);
      const second = await chat.invoke([new HumanMessage("what is HotKV?")]);

      expect(first.content).toBe("first-answer");
      expect(second.content).toBe("first-answer"); // served from cache, not the next canned response

      const third = await chat.invoke([new HumanMessage("a different question")]);
      expect(third.content).toBe("second-answer"); // a real miss still advances the fake model
    });

    it("lookup()/update() namespace by llmKey, so a different model/params never shares an entry", async () => {
      const cache = new HotKVCache(client, { namespace: p + "isolation" });
      const value: Generation[] = [{ text: "cached-for-model-a" }];

      await cache.update("same prompt text", "model=a;temperature=0", value);

      const hit = await cache.lookup("same prompt text", "model=a;temperature=0");
      expect(hit).toEqual(value);

      expect(await cache.lookup("same prompt text", "model=b;temperature=0")).toBeNull();
      expect(await cache.lookup("same prompt text", "model=a;temperature=0.7")).toBeNull();
    });

    it("round trips a ChatGeneration (with its message) through the cache", async () => {
      const cache = new HotKVCache(client, { namespace: p + "chatgen" });
      const generations: Generation[] = [
        { text: "hello there", message: new HumanMessage("hello there") } as unknown as Generation,
      ];
      await cache.update("prompt", "llm-key", generations);
      const hit = await cache.lookup("prompt", "llm-key");
      expect(hit).not.toBeNull();
      expect((hit as Generation[])[0]?.text).toBe("hello there");
    });

    it("stores usage automatically when the AIMessage carries a model name and usage_metadata", async (ctx) => {
      await runOrSkipIfNotLicensed(ctx, async () => {
        const namespace = p + "usage";
        const cache = new HotKVCache(client, { namespace });
        const message = new AIMessage({
          content: "hello there",
          response_metadata: { model_name: "claude-sonnet-5" },
          usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        });
        await cache.update("prompt", "llm-key", [{ text: "hello there", message } as unknown as Generation]);

        const stats = await client.pcacheStats(namespace);
        expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(0);
        // The entry has not been hit yet (a hit is what attributes
        // usageSaved*); confirm the stored entry itself exists.
        expect(stats.entries).toBeGreaterThanOrEqual(1);

        // A lookup (a hit) is what attributes the stored usage.
        await cache.lookup("prompt", "llm-key");
        const statsAfterHit = await client.pcacheStats(namespace);
        expect(statsAfterHit.usageSavedRequests).toBeGreaterThanOrEqual(1);
        expect(statsAfterHit.usageSavedInputTokens).toBeGreaterThanOrEqual(100);
      });
    });
  });

  describe("HotKVSemanticCache", () => {
    const vectors: Record<string, number[]> = {
      "capital of France?": [1, 0, 0],
      "what's the capital of France": [0.99, 0.01, 0], // near duplicate
      "capital of Germany?": [0, 1, 0], // unrelated
    };

    it("a semantically similar prompt hits the cache with a controlled fake embedding", async (ctx) => {
      await runOrSkipIfNotLicensed(ctx, async () => {
        // HotKVSemanticCache.lookup()/update() treat NOLICENSE as "always a
        // miss" rather than raising (see its docstring), so a licensing
        // probe comes first: on an unlicensed server this raises
        // NotLicensedError, which runOrSkipIfNotLicensed() turns into a
        // skip instead of the assertions below failing.
        await client.scacheCreate(p + "semantic-license-probe", 1);

        const embeddings = new ControlledEmbeddings(vectors);
        const cache = new HotKVSemanticCache(client, embeddings, { namespace: p + "semantic", threshold: 0.9 });

        await cache.update("capital of France?", "llm-a", [{ text: "Paris" }]);

        const similarHit = await cache.lookup("what's the capital of France", "llm-a");
        expect(similarHit).toEqual([{ text: "Paris" }]);

        const differentMiss = await cache.lookup("capital of Germany?", "llm-a");
        expect(differentMiss).toBeNull();

        // Same near-duplicate prompt, different llmKey: no cross-model leakage.
        const isolatedMiss = await cache.lookup("what's the capital of France", "llm-b");
        expect(isolatedMiss).toBeNull();
      });
    });

    it("end to end through a chat model: the model runs once, a similar prompt is then served from HotKV", async (ctx) => {
      await runOrSkipIfNotLicensed(ctx, async () => {
        await client.scacheCreate(p + "semantic-e2e-license-probe", 1);

        const embeddings = new ControlledEmbeddings(vectors);
        const cache = new HotKVSemanticCache(client, embeddings, { namespace: p + "semantic-e2e", threshold: 0.9 });
        const chat = new FakeListChatModel({ responses: ["Paris", "SHOULD_NOT_BE_USED"], cache });

        const first = await chat.invoke([new HumanMessage("capital of France?")]);
        expect(first.content).toBe("Paris");

        const second = await chat.invoke([new HumanMessage("what's the capital of France")]);
        expect(second.content).toBe("Paris");
      });
    });
  });
});
