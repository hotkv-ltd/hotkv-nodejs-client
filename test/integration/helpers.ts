// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { HotKV } from "../../src/client.js";
import { HotKVCluster } from "../../src/cluster.js";
import type { ClusterNodeAddr, HotKVClusterOptions } from "../../src/cluster.js";
import { isNotLicensedError } from "../../src/errors.js";
import type { HotKVOptions } from "../../src/options.js";

export const TEST_URL = process.env.HOTKV_TEST_URL;

/**
 * `host:port,host:port,...` seeds of a cluster.
 * With it set, makeClient() returns a HotKVCluster and the suite runs against
 * the cluster; tests that cannot run on a cluster client (pipelines, pub/sub,
 * connection level state) use `describe.skipIf(isCluster)`.
 */
export const CLUSTER = process.env.HOTKV_TEST_CLUSTER;
export const isCluster = Boolean(CLUSTER);
/** CA file of a TLS-only cluster; the cluster clients then use TLS. */
export const CLUSTER_TLS_CA = process.env.HOTKV_TEST_CLUSTER_TLS_CA;

/** True when an integration test target is configured. Every integration test file skips entirely otherwise. */
export const hasServer = Boolean(TEST_URL) || isCluster;

export function clusterSeeds(): ClusterNodeAddr[] {
  return (CLUSTER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const i = s.lastIndexOf(":");
      return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
    });
}

export function clusterOptions(): HotKVClusterOptions {
  return CLUSTER_TLS_CA ? { tls: { caFile: CLUSTER_TLS_CA } } : {};
}

export function makeCluster(overrides?: HotKVClusterOptions): HotKVCluster {
  return new HotKVCluster(clusterSeeds(), { ...clusterOptions(), ...overrides });
}

let seq = 0;

/** A key/namespace prefix unique to this test run and call site, so concurrent test files never collide. */
export function uniquePrefix(tag: string): string {
  seq += 1;
  const token = `hotkv-node-test:${tag}:${process.pid}:${Date.now().toString(36)}:${seq}`;
  // On a cluster a hash tag keeps every key a test derives from the prefix in
  // one slot, so multi-key commands are valid.
  return isCluster ? `{${token}}` : token;
}

export function makeClient(overrides?: HotKVOptions): HotKV {
  if (isCluster) {
    // A cluster client has the same typed surface; the tests that need
    // connection level features skip themselves on a cluster.
    return makeCluster(overrides as HotKVClusterOptions) as unknown as HotKV;
  }
  if (!TEST_URL) {
    throw new Error("HOTKV_TEST_URL is not set; guard call sites with `describe.skipIf(!hasServer)`");
  }
  return new HotKV({ url: TEST_URL, ...overrides });
}

/** Minimal subset of Vitest's per-test context this file needs, kept structural to avoid a hard vitest dependency here. */
export interface SkippableContext {
  skip: (note?: string) => void;
}

/**
 * Runs fn(); if it rejects with NOLICENSE, skips the current test with a
 * clear reason instead of failing it. Skipping (not asserting the error)
 * means the same test passes outright on a server whose license includes the
 * feature.
 */
export async function runOrSkipIfNotLicensed<T>(ctx: SkippableContext, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isNotLicensedError(err)) {
      ctx.skip(`server license does not include this feature: ${(err as Error).message}`);
      return undefined;
    }
    throw err;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
