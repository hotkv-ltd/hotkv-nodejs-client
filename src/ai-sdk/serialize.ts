// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// JSON round trip for a doGenerate() result and a recorded doStream()
// part list. Both are plain, JSON friendly objects (SharedV#Warning,
// LanguageModelV#Content, ...) except for one wrinkle: a response's
// `timestamp` is a native `Date`, which JSON.stringify would otherwise
// silently turn into a string with no way back. A small marker object
// round trips it exactly.

const DATE_MARKER = "__hotkvDate";

function reviveDates(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const marker = (value as Record<string, unknown>)[DATE_MARKER];
    if (typeof marker === "string") return new Date(marker);
  }
  return value;
}

function replaceDates(_key: string, value: unknown): unknown {
  return value instanceof Date ? { [DATE_MARKER]: value.toISOString() } : value;
}

export function serializeGenerateResult(result: unknown): string {
  return JSON.stringify(result, replaceDates);
}

export function deserializeGenerateResult(text: string): unknown {
  return JSON.parse(text, reviveDates);
}

export function serializeStreamParts(parts: unknown[]): string {
  return JSON.stringify(parts, replaceDates);
}

export function deserializeStreamParts(text: string): unknown[] {
  return JSON.parse(text, reviveDates) as unknown[];
}
