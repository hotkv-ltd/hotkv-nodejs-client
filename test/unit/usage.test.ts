// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import { tokenUsageArgs, type TokenUsage } from "../../src/usage.js";

describe("tokenUsageArgs", () => {
  it("sends just MODEL when every count is omitted", () => {
    expect(tokenUsageArgs({ model: "gpt-6-sol" })).toEqual(["MODEL", "gpt-6-sol"]);
  });

  it("omits zero counts", () => {
    const usage: TokenUsage = { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0 };
    expect(tokenUsageArgs(usage)).toEqual(["MODEL", "claude-sonnet-5"]);
  });

  it("includes every count when all are given", () => {
    const usage: TokenUsage = {
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWrite5mTokens: 7,
      cacheWrite1hTokens: 9,
    };
    expect(tokenUsageArgs(usage)).toEqual([
      "MODEL", "claude-sonnet-5",
      "INPUT", 100,
      "OUTPUT", 20,
      "CACHEREAD", 5,
      "CACHEWRITE5M", 7,
      "CACHEWRITE1H", 9,
    ]);
  });

  it("keeps only the nonzero keywords for a partial usage", () => {
    const usage: TokenUsage = { model: "gpt-6-sol", inputTokens: 50, cacheWrite1hTokens: 3 };
    expect(tokenUsageArgs(usage)).toEqual(["MODEL", "gpt-6-sol", "INPUT", 50, "CACHEWRITE1H", 3]);
  });
});
