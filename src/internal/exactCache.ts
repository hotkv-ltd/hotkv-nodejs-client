// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Exact-match string storage on top of PCACHE.*, falling back to core
// GET/SET (a SHA-256 derived key, EX for the TTL) when the server replies
// NOLICENSE for PCACHE.* (a license without the prompt-cache feature, such as
// the Starter plan). Detection happens once per instance:
// the first NOLICENSE reply flips it to the fallback path for good, so
// nothing keeps retrying PCACHE.* on every call.
//
// Shared by @hotkv/client/ai-sdk's hotkvCache() and @hotkv/client/langchain's HotKVCache;
// not part of either package's public API.

import { createHash } from "node:crypto";
import type { TokenUsage } from "../usage.js";
import { isAlreadyExistsError, isNotFoundError, isNotLicensedError } from "./errorChecks.js";

/** The subset of a HotKV client ExactCacheBackend needs. `HotKV` and `HotKVCluster` both satisfy this. */
export interface ExactCacheClient {
  pcacheCreate(ns: string, opts?: { ttlSeconds?: number }): Promise<void>;
  pcacheGet(ns: string, key: string): Promise<string | null>;
  pcacheStats?(ns: string): Promise<unknown>;
  pcacheSet(ns: string, key: string, value: string, opts?: { ttlSeconds?: number; usage?: TokenUsage }): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
}

function coreKey(namespace: string, key: string): string {
  const digest = createHash("sha256").update(`${namespace}:${key}`, "utf8").digest("hex");
  return `hotkv:exact-cache-fallback:${namespace}:${digest}`;
}

export class ExactCacheBackend {
  private licensed: boolean | null = null;

  constructor(
    private readonly client: ExactCacheClient,
    private readonly namespace: string,
    private readonly ttlSeconds?: number,
  ) {}

  private async ensure(): Promise<void> {
    if (this.licensed !== null) return;
    try {
      await this.client.pcacheCreate(this.namespace, { ttlSeconds: this.ttlSeconds });
      this.licensed = true;
    } catch (err) {
      if (isNotLicensedError(err)) {
        this.licensed = false;
        return;
      }
      if (isAlreadyExistsError(err)) {
        // The server answers "already exists or limit reached": make sure the
        // namespace is really there before using it.
        try {
          await this.client.pcacheStats?.(this.namespace);
        } catch (statsErr) {
          if (isNotFoundError(statsErr)) throw err;
        }
        this.licensed = true;
        return;
      }
      throw err;
    }
  }

  async get(key: string): Promise<string | null> {
    await this.ensure();
    if (this.licensed) {
      try {
        return await this.client.pcacheGet(this.namespace, key);
      } catch (err) {
        if (!isNotLicensedError(err)) throw err;
        this.licensed = false;
      }
    }
    return this.client.get(coreKey(this.namespace, key));
  }

  /** `usage`, when given, is recorded with the entry so a later hit
   * attributes it to PCACHE.STATS's usageSaved* fields. It is silently
   * dropped in the fallback (unlicensed) path: plain SET has no
   * usage-tracking concept. */
  async set(key: string, value: string, ttlSeconds?: number, usage?: TokenUsage): Promise<void> {
    await this.ensure();
    const effectiveTtl = ttlSeconds ?? this.ttlSeconds;
    if (this.licensed) {
      try {
        await this.client.pcacheSet(this.namespace, key, value, { ttlSeconds: effectiveTtl, usage });
        return;
      } catch (err) {
        if (!isNotLicensedError(err)) throw err;
        this.licensed = false;
      }
    }
    const key2 = coreKey(this.namespace, key);
    if (effectiveTtl !== undefined) {
      await this.client.set(key2, value, { ex: effectiveTtl });
    } else {
      await this.client.set(key2, value);
    }
  }
}
