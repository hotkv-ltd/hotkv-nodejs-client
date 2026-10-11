// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Unit tests for @hotkv/client/ai-sdk's usageFromAiSdk()/isFinishPart(): the
// TokenUsage extraction hotkvCache() uses so a cache entry can attribute
// a real model call's savings. No server needed.

import { describe, expect, it } from "vitest";
import { isFinishPart, usageFromAiSdk } from "../../src/ai-sdk/cacheKey.js";

describe("usageFromAiSdk", () => {
  it("maps noCache/total/cacheRead to inputTokens/outputTokens/cacheReadTokens", () => {
    const usage = usageFromAiSdk(
      { modelId: "claude-sonnet-5" },
      {
        inputTokens: { noCache: 100, cacheRead: 5 },
        outputTokens: { total: 20 },
      },
    );
    expect(usage).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
    });
  });

  it("defaults missing counts to 0 rather than throwing", () => {
    const usage = usageFromAiSdk({ modelId: "gpt-6-sol" }, { inputTokens: {}, outputTokens: {} });
    expect(usage).toEqual({ model: "gpt-6-sol", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("never fabricates a cache-write tier", () => {
    const usage = usageFromAiSdk({ modelId: "m" }, { inputTokens: { noCache: 1 }, outputTokens: { total: 1 } });
    expect(usage.cacheWrite5mTokens).toBeUndefined();
    expect(usage.cacheWrite1hTokens).toBeUndefined();
  });
});

describe("isFinishPart", () => {
  it("matches a finish part", () => {
    const part = { type: "finish", usage: { inputTokens: { noCache: 1 }, outputTokens: { total: 1 } } };
    expect(isFinishPart(part)).toBe(true);
  });

  it("does not match other part types", () => {
    expect(isFinishPart({ type: "text-delta" })).toBe(false);
    expect(isFinishPart({ type: "error" })).toBe(false);
    expect(isFinishPart(null)).toBe(false);
  });
});
