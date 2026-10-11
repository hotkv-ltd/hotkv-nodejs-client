// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// How the cluster client rides out redirects, a failover and node-local
// commands, with scripted stand-ins for the per-node clients. No server.

import { describe, expect, it } from "vitest";
import { HotKVCluster } from "../../src/cluster.js";
import type { ClusterNodeAddr } from "../../src/cluster.js";
import { keySlot } from "../../src/crc16.js";
import { ClusterError, ConnectionError, errorFromReply } from "../../src/errors.js";
import type { CommandArgs, RespValue } from "../../src/resp/types.js";

const A: ClusterNodeAddr = { host: "10.0.0.1", port: 7001 };
const B: ClusterNodeAddr = { host: "10.0.0.3", port: 7003 };
const A_REPLICA: ClusterNodeAddr = { host: "10.0.0.2", port: 7002 };

const slotsReply = (): RespValue[] => [
  [0, 8191, [Buffer.from("10.0.0.1"), 7001, Buffer.from("a")], [Buffer.from("10.0.0.2"), 7002, Buffer.from("a2")]],
  [8192, 16383, [Buffer.from("10.0.0.3"), 7003, Buffer.from("b")]],
];

// A key whose slot lives on node A.
const KEY_A = (() => {
  for (let i = 0; i < 1000; i++) if (keySlot(`k${i}`) < 8192) return `k${i}`;
  throw new Error("no key");
})();

interface Call {
  addr: ClusterNodeAddr;
  replica: boolean;
  args: CommandArgs;
  asking: boolean;
}
type Handler = (n: number, call: Call) => RespValue | Error;

function transportError(sent: boolean): ConnectionError {
  const err = new ConnectionError("connection refused");
  (err as { sent?: boolean }).sent = sent;
  return err;
}

function makeCluster(handler: Handler, options: ConstructorParameters<typeof HotKVCluster>[1] = {}) {
  const cluster = new HotKVCluster([A], { retryTimeoutMs: 1000, ...options });
  const internal = cluster as unknown as {
    applySlots(reply: RespValue[], host: string): void;
    slotsLoaded: boolean;
    clientFor(addr: ClusterNodeAddr, replica?: boolean): unknown;
    refreshSlots(): Promise<void>;
    slots: unknown[];
  };
  internal.applySlots(slotsReply(), A.host);
  internal.slotsLoaded = true;
  const calls: Call[] = [];
  let refreshes = 0;
  internal.clientFor = (addr: ClusterNodeAddr, replica = false) => ({
    executeOnce: async (args: CommandArgs, asking = false) => {
      const call: Call = { addr, replica, args, asking };
      calls.push(call);
      const result = handler(calls.length, call);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  internal.refreshSlots = async () => {
    refreshes += 1;
  };
  return { cluster, calls, refreshes: () => refreshes, internal };
}

describe("HotKVCluster routing and retries", () => {
  it("follows MOVED to the new owner and remembers it", async () => {
    const { cluster, calls, refreshes, internal } = makeCluster((n) =>
      n === 1 ? errorFromReply(`MOVED ${keySlot(KEY_A)} 10.0.0.3:7003`) : Buffer.from("value"),
    );
    expect(await cluster.execute(["GET", KEY_A])).toEqual(Buffer.from("value"));
    expect(calls.map((c) => c.addr)).toEqual([A, B]);
    expect(refreshes()).toBe(1);
    const range = internal.slots[keySlot(KEY_A)] as { master: ClusterNodeAddr };
    expect(range.master).toEqual(B);
  });

  it("sends ASKING with the command, to the target, without remapping the slot", async () => {
    const { cluster, calls, internal } = makeCluster((n) =>
      n === 1 ? errorFromReply(`ASK ${keySlot(KEY_A)} 10.0.0.3:7003`) : "migrating",
    );
    expect(await cluster.execute(["GET", KEY_A])).toBe("migrating");
    expect(calls[1]).toMatchObject({ addr: B, asking: true });
    expect((internal.slots[keySlot(KEY_A)] as { master: ClusterNodeAddr }).master).toEqual(A);
  });

  it("gives up on a redirect loop", async () => {
    const { cluster, calls } = makeCluster(() => errorFromReply(`ASK ${keySlot(KEY_A)} 10.0.0.3:7003`), {
      maxRedirects: 3,
    });
    await expect(cluster.execute(["GET", KEY_A])).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(4);
  });

  it("rides out a dead primary by refreshing the slot map and trying again", async () => {
    const { cluster, calls, refreshes } = makeCluster((n) => (n <= 2 ? transportError(false) : Buffer.from("after-failover")));
    expect(await cluster.execute(["GET", KEY_A])).toEqual(Buffer.from("after-failover"));
    expect(calls).toHaveLength(3);
    expect(refreshes()).toBe(2);
  });

  it("retries CLUSTERDOWN, TRYAGAIN and a write refused by a demoted primary", async () => {
    const replies: Array<RespValue | Error> = [
      errorFromReply("CLUSTERDOWN The cluster is down"),
      errorFromReply("TRYAGAIN Multiple keys request during rehashing of slot"),
      errorFromReply("READONLY You can't write against a read only replica."),
      "OK",
    ];
    const { cluster, calls } = makeCluster((n) => replies[n - 1] as RespValue | Error);
    expect(await cluster.execute(["SET", KEY_A, "v"])).toBe("OK");
    expect(calls).toHaveLength(4);
  });

  it("ends the retries with a ClusterError after the timeout", async () => {
    const { cluster } = makeCluster(() => transportError(false), { retryTimeoutMs: 300 });
    await expect(cluster.execute(["GET", KEY_A])).rejects.toBeInstanceOf(ClusterError);
  });

  it("does not repeat a write lost in flight when retryWrites is off, but does repeat reads and unsent writes", async () => {
    const lost = makeCluster(() => transportError(true), { retryWrites: false, retryTimeoutMs: 300 });
    await expect(lost.cluster.execute(["SET", KEY_A, "v"])).rejects.toBeInstanceOf(ConnectionError);
    expect(lost.calls).toHaveLength(1);

    const read = makeCluster(() => transportError(true), { retryWrites: false, retryTimeoutMs: 300 });
    await expect(read.cluster.execute(["GET", KEY_A])).rejects.toBeInstanceOf(ClusterError);
    expect(read.calls.length).toBeGreaterThan(2);

    const unsent = makeCluster((n) => (n === 1 ? transportError(false) : "OK"), { retryWrites: false });
    expect(await unsent.cluster.execute(["SET", KEY_A, "v"])).toBe("OK");
  });

  it("reads from a replica and falls back to the primary when it is down", async () => {
    const { cluster, calls } = makeCluster((n, call) => (call.replica ? transportError(false) : Buffer.from("from-primary")), {
      readFromReplicas: true,
    });
    expect(await cluster.execute(["GET", KEY_A])).toEqual(Buffer.from("from-primary"));
    expect(calls[0]).toMatchObject({ addr: A_REPLICA, replica: true });
    expect(calls[1]).toMatchObject({ addr: A, replica: false });
  });

  it("asks every primary for a listing and merges the answers", async () => {
    const { cluster, calls } = makeCluster((n, call) =>
      call.addr.port === 7001 ? [Buffer.from("ns-a1"), Buffer.from("shared")] : [Buffer.from("shared"), Buffer.from("ns-b1")],
    );
    const names = (await cluster.execute(["PCACHE.LIST"])) as Buffer[];
    expect(names.map((b) => b.toString())).toEqual(["ns-a1", "shared", "ns-b1"]);
    expect(calls.map((c) => c.addr.port).sort()).toEqual([7001, 7003]);
  });

  it("sums a count over the primaries", async () => {
    const { cluster } = makeCluster((n, call) => (call.addr.port === 7001 ? 5 : 7));
    expect(await cluster.execute(["DBSIZE"])).toBe(12);
  });

  it("restarts a listing when a primary turns out to be stale", async () => {
    const { cluster, calls } = makeCluster((n) =>
      n === 2 ? errorFromReply("MOVED 5000 10.0.0.9:7009") : [Buffer.from("x")],
    );
    const names = (await cluster.execute(["PCACHE.LIST"])) as Buffer[];
    expect(names.map((b) => b.toString())).toEqual(["x"]);
    expect(calls).toHaveLength(4);
  });

  it("routes EVAL by its key and a keyless command to a primary", async () => {
    const { cluster, calls } = makeCluster(() => Buffer.from("PONG"));
    await cluster.execute(["EVAL", "return 1", 1, KEY_A]);
    expect(calls[0]?.addr).toEqual(A);
    await cluster.execute(["PING"]);
    expect([A, B]).toContainEqual(calls[1]?.addr);
  });

  it("lists the distinct primaries", () => {
    const { cluster } = makeCluster(() => "OK");
    expect(cluster.masters()).toEqual([A, B]);
  });

  it("raises a refused password at once: it is a reply, not a lost connection", async () => {
    const { cluster, calls } = makeCluster(() => errorFromReply("WRONGPASS invalid username-password pair"), {
      retryTimeoutMs: 30_000,
    });
    const started = Date.now();
    await expect(cluster.execute(["GET", KEY_A])).rejects.toMatchObject({ code: "WRONGPASS" });
    await expect(cluster.execute(["PCACHE.LIST"])).rejects.toMatchObject({ code: "WRONGPASS" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toHaveLength(2);
  });

  it("repeats a write lost in flight by default and never with retryWrites off", async () => {
    const lostOnce = makeCluster((n) => (n === 1 ? transportError(true) : 1));
    expect(await lostOnce.cluster.execute(["INCR", KEY_A])).toBe(1);
    expect(lostOnce.calls.map((c) => c.args[0])).toEqual(["INCR", "INCR"]);

    const off = makeCluster(() => transportError(true), { retryWrites: false, retryTimeoutMs: 300 });
    for (const args of [["LLMBUDGET.CONSUME", KEY_A, 100], ["RATELIMIT.CHECK", KEY_A, 1], ["INCR", KEY_A]]) {
      await expect(off.cluster.execute(args)).rejects.toBeInstanceOf(ConnectionError);
    }
    expect(off.calls).toHaveLength(3);
  });

  it("saves a vector snapshot by its name, loads it from the primary that has it and drops it everywhere", async () => {
    const { cluster, calls } = makeCluster((n, call) => {
      const name = String(call.args[0]);
      if (name === "VSIM.LOAD") return call.addr.port === 7003 ? Buffer.from("snapshot-bytes") : null;
      if (name === "VSIM.DROP") return call.addr.port === 7003 ? 1 : 0;
      return "OK";
    });
    await cluster.execute(["VSIM.SAVE", KEY_A, Buffer.from("x")]);
    expect(calls[0]?.addr).toEqual(A); // by the snapshot's name, like a key
    expect(await cluster.execute(["VSIM.LOAD", "snap-on-b"])).toEqual(Buffer.from("snapshot-bytes"));
    expect(calls.slice(1, 3).map((c) => c.addr.port).sort()).toEqual([7001, 7003]);
    expect(await cluster.execute(["VSIM.DROP", "snap-on-b"])).toBe(1);
    expect(calls).toHaveLength(5);
  });
});

describe("HotKVCluster against a node that is not in a cluster", () => {
  // CLUSTER SLOTS of a node with cluster mode off is an empty array.
  function standalone(handler: Handler) {
    const made = makeCluster(handler);
    made.internal.applySlots([], A.host);
    return made;
  }

  it("sends every command to the seed, the fanned-out ones too, without asking for the map again", async () => {
    const { cluster, calls, refreshes } = standalone((n, call) => {
      switch (String(call.args[0])) {
        case "DBSIZE":
          return 7;
        case "KEYS":
          return [Buffer.from("k1"), Buffer.from("k2")];
        case "PCACHE.LIST":
          return [Buffer.from("ns")];
        default:
          return Buffer.from("v");
      }
    });
    expect(await cluster.execute(["GET", KEY_A])).toEqual(Buffer.from("v"));
    expect(await cluster.execute(["DBSIZE"])).toBe(7);
    expect(((await cluster.execute(["KEYS", "*"])) as Buffer[]).map((b) => b.toString())).toEqual(["k1", "k2"]);
    expect(((await cluster.execute(["PCACHE.LIST"])) as Buffer[]).map((b) => b.toString())).toEqual(["ns"]);
    expect(await cluster.execute(["SCRIPT", "LOAD", "return 1"])).toEqual(Buffer.from("v"));
    expect(calls.map((c) => c.addr)).toEqual([A, A, A, A, A]);
    expect(refreshes()).toBe(0);
    expect((await cluster.executeOnPrimaries(["PING"])).size).toBe(1);
  });

  it("asks for the map again after a failure, and routes by slot once the node is in a cluster", async () => {
    const { cluster, calls, internal } = standalone((n, call) =>
      n === 1 ? transportError(false) : String(call.args[0]) === "DBSIZE" ? 3 : Buffer.from("v"),
    );
    internal.refreshSlots = async () => internal.applySlots(slotsReply(), A.host);
    expect(await cluster.execute(["GET", KEY_A])).toEqual(Buffer.from("v"));
    expect(calls).toHaveLength(2);
    // The node joined a cluster meanwhile: a count is now summed over its primaries.
    expect(await cluster.execute(["DBSIZE"])).toBe(6);
  });
});
