// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HotKV } from "../../src/client.js";
import type { PubSubMessage } from "../../src/pubsub.js";
import { hasServer, makeClient, sleep, uniquePrefix, isCluster } from "./helpers.js";

describe.skipIf(!hasServer || isCluster)("pub/sub", () => {
  let client: HotKV;
  let p: string;

  beforeAll(() => {
    client = makeClient();
    p = uniquePrefix("pubsub");
  });
  afterAll(async () => {
    await client.close();
  });

  it("delivers a published message to a channel subscriber via the 'message' event", async () => {
    const channel = `${p}:channel`;
    const sub = client.subscribe(channel);
    try {
      const received = new Promise<PubSubMessage>((resolve) => sub.once("message", resolve));
      await sleep(50); // let SUBSCRIBE's confirmation round trip before publishing
      await client.publish(channel, "hello");
      const msg = await received;
      expect(msg.channel).toBe(channel);
      expect(msg.message).toBe("hello");
    } finally {
      await sub.close();
    }
  });

  it("delivers messages through the async iterator", async () => {
    const channel = `${p}:iter`;
    const sub = client.subscribe(channel);
    try {
      await sleep(50);
      await client.publish(channel, "via-iterator");
      const iterator = sub[Symbol.asyncIterator]();
      const { value, done } = await iterator.next();
      expect(done).toBeFalsy();
      expect(value.message).toBe("via-iterator");
    } finally {
      await sub.close();
    }
  });

  it("PSUBSCRIBE matches a glob pattern and reports the matched pattern", async () => {
    const pattern = `${p}:pattern:*`;
    const sub = client.psubscribe(pattern);
    try {
      const received = new Promise<PubSubMessage>((resolve) => sub.once("pmessage", resolve));
      await sleep(50);
      await client.publish(`${p}:pattern:one`, "pdata");
      const msg = await received;
      expect(msg.kind).toBe("pmessage");
      expect(msg.pattern).toBe(pattern);
      expect(msg.channel).toBe(`${p}:pattern:one`);
    } finally {
      await sub.close();
    }
  });

  it("unsubscribe() stops further delivery on that channel", async () => {
    const channel = `${p}:unsub`;
    const sub = client.subscribe(channel);
    try {
      const messages: string[] = [];
      sub.on("message", (m: PubSubMessage) => messages.push(m.message));
      await sleep(50);
      await sub.unsubscribe(channel);
      await sleep(50);
      await client.publish(channel, "should-not-arrive");
      await sleep(100);
      expect(messages).toEqual([]);
    } finally {
      await sub.close();
    }
  });

  it("a subscriber can listen on more than one channel at once", async () => {
    const chanA = `${p}:multi:a`;
    const chanB = `${p}:multi:b`;
    const sub = client.subscribe(chanA, chanB);
    try {
      const messages: string[] = [];
      sub.on("message", (m: PubSubMessage) => messages.push(m.channel));
      await sleep(50);
      await client.publish(chanA, "1");
      await client.publish(chanB, "2");
      await sleep(100);
      expect(messages.sort()).toEqual([chanA, chanB]);
    } finally {
      await sub.close();
    }
  });
});
