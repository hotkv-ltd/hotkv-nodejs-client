// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { createHash } from "node:crypto";

/** One chat style message, used only to build a deterministic PromptCache key. */
export interface PromptMessage {
  role: string;
  content: string;
}

/**
 * The normalized shape a PromptCache key is derived from. `params` values
 * must already be strings (format numbers yourself, e.g. "0.7", so float
 * formatting never differs between languages or platforms).
 */
export interface PromptCacheKeyInput {
  provider: string;
  model: string;
  system?: string;
  messages: PromptMessage[];
  params?: Record<string, string>;
}

function appendJSONString(parts: string[], s: string): void {
  parts.push('"');
  for (const ch of s) {
    switch (ch) {
      case '"':
        parts.push('\\"');
        break;
      case "\\":
        parts.push("\\\\");
        break;
      case "\n":
        parts.push("\\n");
        break;
      case "\r":
        parts.push("\\r");
        break;
      case "\t":
        parts.push("\\t");
        break;
      case "\b":
        parts.push("\\b");
        break;
      case "\f":
        parts.push("\\f");
        break;
      default: {
        const code = ch.codePointAt(0) as number;
        if (code < 0x20) {
          parts.push(`\\u${code.toString(16).padStart(4, "0")}`);
        } else {
          parts.push(ch);
        }
      }
    }
  }
  parts.push('"');
}

/**
 * Builds the exact canonical JSON string PromptCache keys are hashed from.
 * Every official HotKV SDK implements this identically: fixed top level key order, messages in caller order, params
 * sorted by byte value, compact (no insignificant whitespace), standard
 * JSON string escaping with non-ASCII left as literal UTF-8. Exported
 * mainly so tests (and callers curious what gets hashed) can inspect it;
 * buildPromptCacheKey() is what everyone else should call.
 */
export function canonicalPromptCacheJSON(input: PromptCacheKeyInput): string {
  const parts: string[] = ["{"];

  parts.push('"provider":');
  appendJSONString(parts, input.provider);

  parts.push(',"model":');
  appendJSONString(parts, input.model);

  parts.push(',"system":');
  appendJSONString(parts, input.system ?? "");

  parts.push(',"messages":[');
  input.messages.forEach((m, i) => {
    if (i > 0) parts.push(",");
    parts.push('{"role":');
    appendJSONString(parts, m.role);
    parts.push(',"content":');
    appendJSONString(parts, m.content);
    parts.push("}");
  });
  parts.push("]");

  parts.push(',"params":{');
  const params = input.params ?? {};
  const keys = Object.keys(params).sort();
  keys.forEach((k, i) => {
    if (i > 0) parts.push(",");
    appendJSONString(parts, k);
    parts.push(":");
    appendJSONString(parts, params[k] as string);
  });
  parts.push("}");

  parts.push("}");
  return parts.join("");
}

/**
 * Deterministically derives a PromptCache key: the lowercase hex SHA-256
 * digest of canonicalPromptCacheJSON(input)'s UTF-8 bytes. Byte identical
 * across every official HotKV SDK for the same logical request.
 */
export function buildPromptCacheKey(input: PromptCacheKeyInput): string {
  return createHash("sha256").update(canonicalPromptCacheJSON(input), "utf8").digest("hex");
}
