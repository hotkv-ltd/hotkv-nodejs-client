// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Unit tests for @hotkv/client/langchain's extractUsage(): the best-effort
// TokenUsage extraction HotKVCache/HotKVSemanticCache use so a cache
// entry can attribute a real model call's savings. No server needed
// (@langchain/core is a devDependency, always installed alongside these
// tests; see package.json).

import { AIMessage } from "@langchain/core/messages";
import { ChatGeneration, Generation } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { extractUsage } from "../../src/langchain/_usage.js";

function chatGeneration(opts: { model?: string; usageMetadata?: Record<string, unknown> }): ChatGeneration {
  const message = new AIMessage({
    content: "hi",
    response_metadata: opts.model ? { model_name: opts.model } : {},
    usage_metadata: opts.usageMetadata as never,
  });
  return { text: "hi", message };
}

describe("extractUsage", () => {
  it("extracts model and token counts when both are present", () => {
    const generation = chatGeneration({
      model: "claude-sonnet-5",
      usageMetadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_token_details: { cache_read: 5 } },
    });
    const usage = extractUsage([generation]);
    expect(usage).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
    });
  });

  it("falls back to the plain model metadata key", () => {
    const message = new AIMessage({
      content: "hi",
      response_metadata: { model: "gpt-6-sol" },
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } as never,
    });
    const usage = extractUsage([{ text: "hi", message }]);
    expect(usage?.model).toBe("gpt-6-sol");
  });

  it("is undefined when usage_metadata is missing", () => {
    const generation = chatGeneration({ model: "claude-sonnet-5" });
    expect(extractUsage([generation])).toBeUndefined();
  });

  it("is undefined when the model name is missing", () => {
    const generation = chatGeneration({ usageMetadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    expect(extractUsage([generation])).toBeUndefined();
  });

  it("is undefined for a plain text Generation with no message", () => {
    const generation: Generation = { text: "plain completion, no message at all" };
    expect(extractUsage([generation])).toBeUndefined();
  });

  it("is undefined for an empty generations list", () => {
    expect(extractUsage([])).toBeUndefined();
  });

  it("finds usage on a later generation in the list", () => {
    const plain: Generation = { text: "no usage here" };
    const withUsage = chatGeneration({
      model: "claude-sonnet-5",
      usageMetadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
    const usage = extractUsage([plain, withUsage]);
    expect(usage?.inputTokens).toBe(7);
  });
});
