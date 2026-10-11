// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream, convertReadableStreamToArray } from "ai/test";
import { generateText, streamText, wrapLanguageModel } from "ai";
import type { HotKV } from "../../src/client.js";
import { hotkvCache } from "../../src/ai-sdk/index.js";
import { hasServer, makeClient, runOrSkipIfNotLicensed, uniquePrefix } from "./helpers.js";

function usage() {
  return {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  };
}

function generateResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(),
    warnings: [],
  };
}

describe.skipIf(!hasServer)("@hotkv/client/ai-sdk", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("aisdk");
  });
  afterAll(async () => {
    await client.close();
  });

  it("generateText: first call hits the model, identical second call is served by HotKV", async () => {
    const doGenerate = vi.fn(async () => generateResult("first-answer"));
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate }),
      middleware: hotkvCache({ client, namespace: p + "exact" }),
    });

    const first = await generateText({ model, prompt: "what is HotKV?" });
    const second = await generateText({ model, prompt: "what is HotKV?" });

    expect(first.text).toBe("first-answer");
    expect(second.text).toBe("first-answer");
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it("generateText: a different prompt is a miss, and calls the model again", async () => {
    const doGenerate = vi.fn(async ({ prompt }: { prompt: unknown }) => {
      const text = JSON.stringify(prompt).includes("first question") ? "answer-one" : "answer-two";
      return generateResult(text);
    });
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate }),
      middleware: hotkvCache({ client, namespace: p + "miss" }),
    });

    const first = await generateText({ model, prompt: "first question" });
    const second = await generateText({ model, prompt: "second question" });

    expect(first.text).toBe("answer-one");
    expect(second.text).toBe("answer-two");
    expect(doGenerate).toHaveBeenCalledTimes(2);
  });

  it("generateText: a different model id never shares a cache entry", async () => {
    const doGenerateA = vi.fn(async () => generateResult("model-a-answer"));
    const doGenerateB = vi.fn(async () => generateResult("model-b-answer"));
    const namespace = p + "modelsplit";

    const modelA = wrapLanguageModel({
      model: new MockLanguageModelV4({ modelId: "model-a", doGenerate: doGenerateA }),
      middleware: hotkvCache({ client, namespace }),
    });
    const modelB = wrapLanguageModel({
      model: new MockLanguageModelV4({ modelId: "model-b", doGenerate: doGenerateB }),
      middleware: hotkvCache({ client, namespace }),
    });

    const resultA = await generateText({ model: modelA, prompt: "same prompt text" });
    const resultB = await generateText({ model: modelB, prompt: "same prompt text" });

    expect(resultA.text).toBe("model-a-answer");
    expect(resultB.text).toBe("model-b-answer");
    expect(doGenerateA).toHaveBeenCalledTimes(1);
    expect(doGenerateB).toHaveBeenCalledTimes(1);
  });

  it("generateText: usage is stored automatically and a hit reports savings", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      const namespace = p + "usage";
      const doGenerate = vi.fn(async () => generateResult("the answer"));
      const model = wrapLanguageModel({
        model: new MockLanguageModelV4({ modelId: "claude-sonnet-5", doGenerate }),
        middleware: hotkvCache({ client, namespace }),
      });

      await generateText({ model, prompt: "usage question" }); // a miss: stores usage
      await generateText({ model, prompt: "usage question" }); // a hit: attributes it
      expect(doGenerate).toHaveBeenCalledTimes(1);

      const stats = await client.pcacheStats(namespace);
      expect(stats.usageSavedRequests).toBeGreaterThanOrEqual(1);
      // usage() above reports 3 non-cached input tokens.
      expect(stats.usageSavedInputTokens).toBeGreaterThanOrEqual(3);
    });
  });

  it("semantic caching: a similar prompt hits the semantic cache with a controlled fake embedding", async (ctx) => {
    await runOrSkipIfNotLicensed(ctx, async () => {
      // hotkvCache()'s semantic option treats NOLICENSE as "always a miss"
      // rather than raising (SemanticCacheBackend swallows it), so a
      // licensing probe comes first: on an unlicensed server this raises
      // NotLicensedError, which runOrSkipIfNotLicensed() turns into a skip
      // instead of the call-count assertions below failing.
      await client.scacheCreate(p + "semantic-license-probe", 1);

      const vectors: Record<string, number[]> = {
        "capital of France?": [1, 0, 0],
        "what is the capital of France": [0.99, 0.01, 0], // near duplicate
        "capital of Germany?": [0, 1, 0], // unrelated
      };
      const embed = async (text: string) => vectors[text] ?? [0, 0, 1];

      const doGenerate = vi.fn(async ({ prompt }: { prompt: unknown }) => {
        const text = JSON.stringify(prompt).includes("Germany") ? "Berlin" : "Paris";
        return generateResult(text);
      });
      const model = wrapLanguageModel({
        model: new MockLanguageModelV4({ doGenerate }),
        middleware: hotkvCache({ client, namespace: p + "semantic", semantic: { embed, threshold: 0.9 } }),
      });

      const first = await generateText({ model, prompt: "capital of France?" });
      expect(first.text).toBe("Paris");
      expect(doGenerate).toHaveBeenCalledTimes(1);

      // A different exact prompt, semantically close: served from the semantic cache.
      const second = await generateText({ model, prompt: "what is the capital of France" });
      expect(second.text).toBe("Paris");
      expect(doGenerate).toHaveBeenCalledTimes(1);

      // An unrelated prompt: still calls the model.
      const third = await generateText({ model, prompt: "capital of Germany?" });
      expect(third.text).toBe("Berlin");
      expect(doGenerate).toHaveBeenCalledTimes(2);
    });
  });

  it("streamText: replays a cached stream verbatim on an identical second call", async () => {
    const chunks = [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "1" },
      { type: "text-delta" as const, id: "1", delta: "Hot" },
      { type: "text-delta" as const, id: "1", delta: "KV" },
      { type: "text-end" as const, id: "1" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage() },
    ];
    const doStream = vi.fn(async () => ({ stream: convertArrayToReadableStream(chunks) }));
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doStream }),
      middleware: hotkvCache({ client, namespace: p + "stream" }),
    });

    const first = await streamText({ model, prompt: "stream this" });
    const firstText = await first.text;
    expect(firstText).toBe("HotKV");

    const second = await streamText({ model, prompt: "stream this" });
    const secondText = await second.text;
    expect(secondText).toBe("HotKV");

    // The underlying model only ever streamed once; the second call was replayed from HotKV.
    expect(doStream).toHaveBeenCalledTimes(1);
  });

  it("wrapStream(): the recorded parts round trip exactly through the cache", async () => {
    const parts = [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "1" },
      { type: "text-delta" as const, id: "1", delta: "cached" },
      { type: "text-end" as const, id: "1" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage() },
    ];
    const doStream = vi.fn(async () => ({ stream: convertArrayToReadableStream(parts) }));
    const model = new MockLanguageModelV4({ doStream });
    const middleware = hotkvCache({ client, namespace: p + "rawstream" });
    const params = { prompt: [{ role: "user", content: [{ type: "text", text: "round trip" }] }] };

    const live = await middleware.wrapStream!({ doStream: () => model.doStream(params as never), doGenerate: () => model.doGenerate(params as never), params: params as never, model: model as never });
    await convertReadableStreamToArray(live.stream);

    const replayed = await middleware.wrapStream!({ doStream: () => model.doStream(params as never), doGenerate: () => model.doGenerate(params as never), params: params as never, model: model as never });
    const replayedParts = await convertReadableStreamToArray(replayed.stream);

    expect(replayedParts).toEqual(parts);
    expect(doStream).toHaveBeenCalledTimes(1);
  });
});
