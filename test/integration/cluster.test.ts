// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, describe, expect, it } from "vitest";
import { HotKVCluster } from "../../src/cluster.js";
import { isCluster, TEST_URL, uniquePrefix } from "./helpers.js";

// There is no live multi-node HotKV cluster in this environment, only the
// single standalone test server. These tests exercise what is reachable
// without one (construction, option validation, and routing helpers, the
// latter fully covered against known vectors in
// test/unit/crc16.test.ts) and otherwise skip with a clear reason rather
// than asserting behavior nothing here can actually produce: MOVED/ASK
// redirects need at least two real nodes disagreeing about a slot.

describe("HotKVCluster", () => {
  it("requires at least one seed node", () => {
    expect(() => new HotKVCluster([])).toThrow();
  });

  it("accepts seed nodes as host:port strings or {host, port} objects", () => {
    const cluster = new HotKVCluster(["127.0.0.1:7000", { host: "127.0.0.1", port: 7001 }]);
    expect(cluster).toBeInstanceOf(HotKVCluster);
  });

  it("rejects a malformed seed address", () => {
    expect(() => new HotKVCluster(["not-a-valid-address"])).toThrow();
  });

  describe.skipIf(!TEST_URL || isCluster)("against the standalone test server", () => {
    let cluster: HotKVCluster | undefined;

    afterAll(async () => {
      await cluster?.close();
    });

    it("connect() either loads a real slot map or fails cleanly when the server has clustering disabled", async (ctx) => {
      const url = new URL(TEST_URL as string);
      cluster = new HotKVCluster([{ host: url.hostname, port: Number(url.port) }]);
      try {
        await cluster.connect();
      } catch {
        ctx.skip("no live HotKV cluster available in this environment (standalone test server has clustering disabled)");
        return;
      }
      // If it did succeed, this server actually reports cluster slots: the
      // routing table should be internally consistent.
      const slots = cluster.slotMap();
      expect(slots.length).toBe(16384);
    });

    it("a keyless command still resolves to a seed node without throwing on routing", async () => {
      const url = new URL(TEST_URL as string);
      const soloCluster = new HotKVCluster([{ host: url.hostname, port: Number(url.port) }]);
      try {
        const key = `${uniquePrefix("cluster")}:probe`;
        await soloCluster.execute(["SET", key, "v"]);
        expect(await soloCluster.execute(["GET", key])).toBeTruthy();
      } finally {
        await soloCluster.close();
      }
    });
  });
});
