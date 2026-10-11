// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// The namespace handling of the cache helpers, with fake clients and no
// server: the namespace is created on first use, and a create the server
// refused is not mistaken for a namespace that exists.

import { describe, expect, it } from "vitest";
import { PromptCache, SemanticCache } from "../../src/ai/index.js";
import { errorFromReply } from "../../src/errors.js";
import { ExactCacheBackend } from "../../src/internal/exactCache.js";
import { SemanticCacheBackend } from "../../src/internal/semanticCache.js";

const refused = () => errorFromReply("ERR namespace already exists or limit reached");
const notFound = () => errorFromReply("ERR namespace not found");

function fakePromptClient(opts: { createError?: () => Error; statsError?: () => Error } = {}) {
  const calls: string[] = [];
  const store = new Map<string, string>();
  return {
    calls,
    pcacheCreate: async () => {
      calls.push("create");
      if (opts.createError) throw opts.createError();
    },
    pcacheStats: async () => {
      calls.push("stats");
      if (opts.statsError) throw opts.statsError();
      return {} as never;
    },
    pcacheGet: async (_ns: string, key: string) => {
      calls.push("get");
      return store.get(key) ?? null;
    },
    pcacheSet: async (_ns: string, key: string, value: string) => {
      calls.push("set");
      store.set(key, value);
    },
    llmStatsBucket: async () => {},
    llmStatsRecord: async () => {},
    get: async () => null,
    set: async () => undefined,
  };
}

const input = { provider: "p", model: "m", messages: [{ role: "user" as const, content: "hi" }], params: {} };

describe("PromptCache and SemanticCache namespaces", () => {
  it("PromptCache.getOrCall creates the namespace before its first use, once", async () => {
    const client = fakePromptClient();
    const cache = new PromptCache(client as never, "ns");
    await cache.getOrCall(input, async () => ({ response: "a" }));
    await cache.getOrCall(input, async () => ({ response: "b" }));
    expect(client.calls[0]).toBe("create");
    expect(client.calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("PromptCache.getOrCall reports a create the server refused instead of failing later", async () => {
    const client = fakePromptClient({ createError: refused, statsError: notFound });
    const cache = new PromptCache(client as never, "ns");
    await expect(cache.getOrCall(input, async () => ({ response: "a" }))).rejects.toThrow(/already exists or limit reached/);
    expect(client.calls).not.toContain("set");
  });

  it("PromptCache.getOrCall goes on when the namespace is there", async () => {
    const client = fakePromptClient({ createError: refused });
    const cache = new PromptCache(client as never, "ns");
    const result = await cache.getOrCall(input, async () => ({ response: "a" }));
    expect(result).toEqual({ response: "a", hit: false });
  });

  it("SemanticCache.getOrCall creates the namespace before its first use", async () => {
    const calls: string[] = [];
    const client = {
      scacheCreate: async () => void calls.push("create"),
      scacheStats: async () => ({}) as never,
      scacheGet: async () => {
        calls.push("get");
        return null;
      },
      scacheSet: async () => void calls.push("set"),
    };
    const cache = new SemanticCache(client as never, "ns", 2);
    await cache.getOrCall("q", [1, 0], async () => "answer");
    expect(calls).toEqual(["create", "get", "set"]);
  });

  it("ExactCacheBackend raises the create error when the namespace is not there, and uses it when it is", async () => {
    const absent = fakePromptClient({ createError: refused, statsError: notFound });
    await expect(new ExactCacheBackend(absent as never, "ns").get("k")).rejects.toThrow(/already exists or limit reached/);

    const present = fakePromptClient({ createError: refused });
    const backend = new ExactCacheBackend(present as never, "ns");
    await backend.set("k", "v");
    expect(await backend.get("k")).toBe("v");
  });

  it("SemanticCacheBackend raises the create error when the namespace is not there", async () => {
    const client = {
      scacheCreate: async () => {
        throw refused();
      },
      scacheStats: async () => {
        throw notFound();
      },
      scacheGet: async () => null,
      scacheSet: async () => undefined,
    };
    await expect(new SemanticCacheBackend(client as never, "ns").set("q", "r", [1, 0])).rejects.toThrow(
      /already exists or limit reached/,
    );
  });
});

describe("stats() of the cache helpers", () => {
  it("asks for the statistics and creates nothing, so a namespace nobody used is reported as not found", async () => {
    const prompt = fakePromptClient({ statsError: notFound });
    await expect(new PromptCache(prompt as never, "ns").stats()).rejects.toThrow(/not found/);
    expect(prompt.calls).toEqual(["stats"]);

    const calls: string[] = [];
    const semantic = {
      scacheCreate: async () => void calls.push("create"),
      scacheStats: async () => {
        calls.push("stats");
        throw notFound();
      },
    };
    await expect(new SemanticCache(semantic as never, "ns", 2).stats()).rejects.toThrow(/not found/);
    expect(calls).toEqual(["stats"]);
  });
});
