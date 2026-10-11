// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { EventEmitter } from "node:events";
import { Connection } from "./connection.js";
import type { ResolvedOptions } from "./options.js";
import { arr, str } from "./resp/decode.js";
import type { Frame, RespValue } from "./resp/types.js";
import { encodeCommand } from "./resp/writer.js";

export type PubSubMessageKind = "message" | "pmessage" | "smessage";

export interface PubSubMessage {
  kind: PubSubMessageKind;
  /** The channel the message was published on. */
  channel: string;
  /** The pattern that matched, set only for pattern subscriptions (pmessage). */
  pattern?: string;
  message: string;
}

/** A minimal async pull queue, backing PubSub's async iterator. */
class AsyncQueue<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffered.push(item);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.buffered.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * A pub/sub subscription: a dedicated connection (never pooled), delivering
 * messages three ways at once: EventEmitter events ("message", "pmessage",
 * "smessage", plus a kind independent "messageAny"), and async iteration
 * (`for await (const m of pubsub)`). RESP3 push frames and RESP2's
 * unsolicited replies are both handled transparently.
 */
export class PubSub extends EventEmitter {
  private conn: Connection | undefined;
  private readonly connecting: Promise<Connection>;
  private readonly queue = new AsyncQueue<PubSubMessage>();
  private readonly channels = new Set<string>();
  private readonly patterns = new Set<string>();
  private readonly shardChannels = new Set<string>();
  private closed = false;

  constructor(private readonly opts: ResolvedOptions) {
    super();
    this.connecting = this.open();
    // A connect failure is surfaced to every subscribe()/send() caller that
    // awaits `this.connecting`; attach a no-op handler too so Node never
    // reports it as an unhandled rejection if no one has subscribed yet.
    this.connecting.catch(() => undefined);
  }

  private async open(): Promise<Connection> {
    const conn = new Connection(this.opts);
    await conn.connect();
    conn.on("frame", (frame: Frame) => this.onFrame(frame));
    conn.on("close", () => {
      this.closed = true;
      this.queue.end();
      this.emit("close");
    });
    this.conn = conn;
    return conn;
  }

  async subscribe(...channels: string[]): Promise<void> {
    if (channels.length === 0) return;
    const wait = this.awaitConfirmations("subscribe", channels.length);
    for (const c of channels) this.channels.add(c);
    await this.send("SUBSCRIBE", channels);
    await wait;
  }

  async psubscribe(...patterns: string[]): Promise<void> {
    if (patterns.length === 0) return;
    const wait = this.awaitConfirmations("psubscribe", patterns.length);
    for (const p of patterns) this.patterns.add(p);
    await this.send("PSUBSCRIBE", patterns);
    await wait;
  }

  async ssubscribe(...channels: string[]): Promise<void> {
    if (channels.length === 0) return;
    const wait = this.awaitConfirmations("ssubscribe", channels.length);
    for (const c of channels) this.shardChannels.add(c);
    await this.send("SSUBSCRIBE", channels);
    await wait;
  }

  async unsubscribe(...channels: string[]): Promise<void> {
    const targets = channels.length > 0 ? channels : [...this.channels];
    if (targets.length === 0) return;
    const wait = this.awaitConfirmations("unsubscribe", targets.length);
    for (const c of targets) this.channels.delete(c);
    await this.send("UNSUBSCRIBE", targets);
    await wait;
  }

  async punsubscribe(...patterns: string[]): Promise<void> {
    const targets = patterns.length > 0 ? patterns : [...this.patterns];
    if (targets.length === 0) return;
    const wait = this.awaitConfirmations("punsubscribe", targets.length);
    for (const p of targets) this.patterns.delete(p);
    await this.send("PUNSUBSCRIBE", targets);
    await wait;
  }

  async sunsubscribe(...channels: string[]): Promise<void> {
    const targets = channels.length > 0 ? channels : [...this.shardChannels];
    if (targets.length === 0) return;
    const wait = this.awaitConfirmations("sunsubscribe", targets.length);
    for (const c of targets) this.shardChannels.delete(c);
    await this.send("SUNSUBSCRIBE", targets);
    await wait;
  }

  async ping(): Promise<void> {
    const conn = this.conn ?? (await this.connecting);
    conn.writeRaw(encodeCommand(["PING"]));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.end();
    const conn = this.conn ?? (await this.connecting.catch(() => undefined));
    conn?.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<PubSubMessage> {
    return { next: () => this.queue.next() };
  }

  private async send(command: string, targets: string[]): Promise<void> {
    const conn = this.conn ?? (await this.connecting);
    conn.writeRaw(encodeCommand([command, ...targets]));
  }

  private awaitConfirmations(event: string, count: number): Promise<void> {
    return new Promise((resolve) => {
      let remaining = count;
      const onConfirm = () => {
        remaining -= 1;
        if (remaining <= 0) {
          this.off(event, onConfirm);
          resolve();
        }
      };
      this.on(event, onConfirm);
    });
  }

  private onFrame(frame: Frame): void {
    const parts = arr(frame.value);
    const type = str(parts[0] as RespValue);
    switch (type) {
      case "subscribe":
      case "psubscribe":
      case "ssubscribe":
      case "unsubscribe":
      case "punsubscribe":
      case "sunsubscribe":
        this.emit(type, str(parts[1] as RespValue), Number(parts[2]));
        return;
      case "message":
        this.deliver({
          kind: "message",
          channel: str(parts[1] as RespValue),
          message: str(parts[2] as RespValue),
        });
        return;
      case "pmessage":
        this.deliver({
          kind: "pmessage",
          pattern: str(parts[1] as RespValue),
          channel: str(parts[2] as RespValue),
          message: str(parts[3] as RespValue),
        });
        return;
      case "smessage":
        this.deliver({
          kind: "smessage",
          channel: str(parts[1] as RespValue),
          message: str(parts[2] as RespValue),
        });
        return;
      default:
        this.emit("frame", frame.value);
    }
  }

  private deliver(msg: PubSubMessage): void {
    this.emit(msg.kind, msg);
    this.emit("messageAny", msg);
    this.queue.push(msg);
  }
}
