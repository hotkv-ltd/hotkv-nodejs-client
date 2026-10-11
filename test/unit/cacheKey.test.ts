// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPromptCacheKey, canonicalPromptCacheJSON } from "../../src/ai/cacheKey.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("canonicalPromptCacheJSON", () => {
  it("produces top level keys in the fixed order provider, model, system, messages, params", () => {
    const json = canonicalPromptCacheJSON({
      provider: "acme",
      model: "gpt-6-sol",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
      params: { temperature: "0.7" },
    });
    expect(json).toBe(
      '{"provider":"acme","model":"gpt-6-sol","system":"be terse","messages":[{"role":"user","content":"hi"}],"params":{"temperature":"0.7"}}',
    );
  });

  it("keeps missing system and params present as empty rather than omitted", () => {
    const json = canonicalPromptCacheJSON({ provider: "acme", model: "m", messages: [] });
    expect(json).toBe('{"provider":"acme","model":"m","system":"","messages":[],"params":{}}');
  });

  it("preserves caller supplied message order", () => {
    const json = canonicalPromptCacheJSON({
      provider: "p",
      model: "m",
      messages: [
        { role: "system", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ],
    });
    expect(json).toContain('"messages":[{"role":"system","content":"a"},{"role":"user","content":"b"},{"role":"assistant","content":"c"}]');
  });

  it("sorts params keys ascending by byte value", () => {
    const json = canonicalPromptCacheJSON({
      provider: "p",
      model: "m",
      messages: [],
      params: { top_p: "1", max_tokens: "256", temperature: "0.7" },
    });
    expect(json).toContain('"params":{"max_tokens":"256","temperature":"0.7","top_p":"1"}');
  });

  it("produces compact encoding with no insignificant whitespace", () => {
    const json = canonicalPromptCacheJSON({ provider: "p", model: "m", messages: [] });
    expect(json).not.toMatch(/[\n\t]| : | , /);
  });

  it("escapes quotes, backslashes and control characters below 0x20", () => {
    const json = canonicalPromptCacheJSON({
      provider: "p",
      model: "m",
      messages: [{ role: "user", content: 'quote:" backslash:\\ tab:\t null:\u0000' }],
    });
    expect(json).toContain('quote:\\" backslash:\\\\ tab:\\t null:\\u0000');
  });

  it("leaves non-ASCII characters as literal UTF-8, not \\u escaped", () => {
    const json = canonicalPromptCacheJSON({ provider: "p", model: "m", messages: [{ role: "user", content: "café 你好" }] });
    expect(json).toContain("café 你好");
    expect(json).not.toMatch(/\\u00e9|\\u4f60/);
  });
});

describe("buildPromptCacheKey", () => {
  it("is the lowercase hex SHA-256 of the canonical JSON's UTF-8 bytes", () => {
    const input = { provider: "acme", model: "m", messages: [{ role: "user", content: "hi" }], params: { temperature: "0.7" } };
    const expected = sha256(canonicalPromptCacheJSON(input));
    expect(buildPromptCacheKey(input)).toBe(expected);
  });

  it("returns a 64 character lowercase hex string", () => {
    const key = buildPromptCacheKey({ provider: "p", model: "m", messages: [] });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same logical input", () => {
    const input = { provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], params: { a: "1" } };
    expect(buildPromptCacheKey(input)).toBe(buildPromptCacheKey(structuredClone(input)));
  });

  it("params key order in the input object does not affect the key", () => {
    const a = buildPromptCacheKey({ provider: "p", model: "m", messages: [], params: { top_p: "1", temperature: "0.7" } });
    const b = buildPromptCacheKey({ provider: "p", model: "m", messages: [], params: { temperature: "0.7", top_p: "1" } });
    expect(a).toBe(b);
  });

  it("changes when any field changes", () => {
    const base = buildPromptCacheKey({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(buildPromptCacheKey({ provider: "p2", model: "m", messages: [{ role: "user", content: "hi" }] })).not.toBe(base);
    expect(buildPromptCacheKey({ provider: "p", model: "m2", messages: [{ role: "user", content: "hi" }] })).not.toBe(base);
    expect(buildPromptCacheKey({ provider: "p", model: "m", messages: [{ role: "user", content: "bye" }] })).not.toBe(base);
    expect(buildPromptCacheKey({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], system: "x" })).not.toBe(base);
  });
});
