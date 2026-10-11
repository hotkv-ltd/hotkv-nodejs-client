// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import { ConnectionError, ProtocolError, ReplyError, TimeoutError } from "./errors.js";
import type { ResolvedOptions } from "./options.js";
import { RespReader } from "./resp/reader.js";
import type { CommandArg, CommandArgs, Frame, RespValue } from "./resp/types.js";
import { encodeCommand, encodeCommands } from "./resp/writer.js";

interface Pending {
  resolve: (v: RespValue) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

let connectionSeq = 0;

/**
 * One physical socket to a HotKV server: RESP2/RESP3 handshake, request or
 * response framing over sendCommand()/sendBatch(), and out of band RESP3
 * push (or RESP2 unsolicited pub/sub) frames delivered as "frame" events.
 * Used directly by PubSub, and pooled by Pool for everything else.
 */
export class Connection extends EventEmitter {
  readonly id = ++connectionSeq;
  protocolVersion: 2 | 3 = 2;
  createdAt = Date.now();
  lastUsedAt = Date.now();

  private socket: net.Socket | tls.TLSSocket | undefined;
  private readonly reader = new RespReader();
  private readonly pending: Pending[] = [];
  private _closed = false;

  constructor(private readonly opts: ResolvedOptions) {
    super();
  }

  get closed(): boolean {
    return this._closed;
  }

  async connect(): Promise<void> {
    this.socket = await openSocket(this.opts);
    this.socket.setNoDelay(true);
    if (!this.opts.path && this.opts.keepAlive && this.socket instanceof net.Socket) {
      this.socket.setKeepAlive(true);
    }
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", (err: Error) => this.onSocketError(err));
    this.socket.on("close", () => this.onSocketClose());

    await this.handshake();
  }

  /** Sends one command and resolves with its single reply (rejects on a server error reply). */
  sendCommand(args: CommandArgs): Promise<RespValue> {
    if (this._closed || !this.socket) {
      return Promise.reject(new ConnectionError("connection is closed"));
    }
    // Encode first: an argument the writer refuses (NaN) must throw before a
    // reply slot is queued, or the slot would wait for a reply never asked for.
    const payload = encodeCommand(args);
    const { promise } = this.nextPending();
    this.socket.write(payload, (err) => {
      if (err) this.onSocketError(err);
    });
    return promise;
  }

  /**
   * Sends several commands in a single write and resolves once every reply
   * has arrived. Never rejects for a per-command server error: that error
   * simply occupies that slot in the result array, so one bad command in a
   * pipeline never aborts the rest.
   */
  async sendBatch(batch: readonly CommandArgs[]): Promise<Array<RespValue | Error>> {
    if (batch.length === 0) return [];
    if (this._closed || !this.socket) {
      throw new ConnectionError("connection is closed");
    }
    const payload = encodeCommands(batch);
    const promises = batch.map(() => this.nextPending().promise);
    this.socket.write(payload, (err) => {
      if (err) this.onSocketError(err);
    });
    const settled = await Promise.allSettled(promises);
    return settled.map((s) => (s.status === "fulfilled" ? s.value : (s.reason as Error)));
  }

  /** Writes a raw pre-encoded command without registering a pending reply slot. Used by PubSub. */
  writeRaw(payload: Buffer): void {
    if (this._closed || !this.socket) throw new ConnectionError("connection is closed");
    this.socket.write(payload);
  }

  async ping(): Promise<void> {
    await this.sendCommand(["PING"]);
  }

  /** Closes the connection. Safe to call more than once. */
  close(): void {
    this.destroy(new ConnectionError("connection closed"));
  }

  private nextPending(): { entry: Pending; promise: Promise<RespValue> } {
    let resolve!: (v: RespValue) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<RespValue>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Pending = { resolve, reject };
    if (this.opts.commandTimeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.destroy(new TimeoutError(`command timed out after ${this.opts.commandTimeoutMs}ms`));
      }, this.opts.commandTimeoutMs);
    }
    this.pending.push(entry);
    return { entry, promise };
  }

  private settleNext(value: RespValue): void {
    const entry = this.pending.shift();
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (value instanceof ReplyError) entry.reject(value);
    else entry.resolve(value);
  }

  private onData(chunk: Buffer): void {
    this.lastUsedAt = Date.now();
    this.reader.feed(chunk);
    try {
      for (const frame of this.reader.next()) {
        this.dispatch(frame);
      }
    } catch (err) {
      this.destroy(err instanceof Error ? err : new ProtocolError(String(err)));
    }
  }

  private dispatch(frame: Frame): void {
    // Out of band RESP3 push frames, and anything arriving with no matching
    // pending request (RESP2 pub/sub confirmations and messages, which have
    // no distinct wire type), are delivered as events rather than matched
    // against the request queue.
    if (frame.kind === "push" || this.pending.length === 0) {
      this.emit("frame", frame);
      return;
    }
    this.settleNext(frame.value);
  }

  private onSocketError(err: Error): void {
    this.destroy(new ConnectionError(err.message, err));
  }

  private onSocketClose(): void {
    this.destroy(new ConnectionError("connection closed by peer"));
  }

  private destroy(err: Error): void {
    if (this._closed) return;
    this._closed = true;
    const pending = this.pending.splice(0);
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.socket?.removeAllListeners();
    this.socket?.destroy();
    this.emit("close");
  }

  private async handshake(): Promise<void> {
    let negotiated = false;
    if (this.opts.resp3) {
      negotiated = await this.tryHello(3);
      if (negotiated) this.protocolVersion = 3;
    }
    if (!negotiated) {
      negotiated = await this.tryHello(2);
      this.protocolVersion = 2;
    }
    if (!negotiated) {
      // Pre-HELLO server: do AUTH / SELECT / CLIENT SETNAME by hand over RESP2.
      await this.legacyHandshake();
      return;
    }
    if (this.opts.db !== 0) {
      await this.sendCommand(["SELECT", String(this.opts.db)]);
    }
    if (this.opts.replicaReads) {
      await this.sendCommand(["READONLY"]);
    }
  }

  private async tryHello(version: 2 | 3): Promise<boolean> {
    const args: CommandArg[] = ["HELLO", String(version)];
    if (this.opts.password !== undefined) {
      args.push("AUTH", this.opts.username ?? "default", this.opts.password);
    }
    if (this.opts.clientName !== undefined) {
      args.push("SETNAME", this.opts.clientName);
    }
    try {
      await this.sendCommand(args);
      return true;
    } catch (err) {
      if (err instanceof ReplyError) return false;
      throw err;
    }
  }

  private async legacyHandshake(): Promise<void> {
    if (this.opts.password !== undefined) {
      const args: CommandArg[] =
        this.opts.username !== undefined
          ? ["AUTH", this.opts.username, this.opts.password]
          : ["AUTH", this.opts.password];
      await this.sendCommand(args);
    }
    if (this.opts.clientName !== undefined) {
      await this.sendCommand(["CLIENT", "SETNAME", this.opts.clientName]);
    }
    if (this.opts.db !== 0) {
      await this.sendCommand(["SELECT", String(this.opts.db)]);
    }
    if (this.opts.replicaReads) {
      await this.sendCommand(["READONLY"]);
    }
  }
}

function loadPem(
  inline: string | Buffer | Array<string | Buffer> | undefined,
  filePath: string | undefined,
): string | Buffer | Array<string | Buffer> | undefined {
  if (inline !== undefined) return inline;
  if (filePath !== undefined) return fs.readFileSync(filePath);
  return undefined;
}

function openSocket(opts: ResolvedOptions): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new TimeoutError("connect timed out"));
    }, opts.connectTimeoutMs);

    const onConnect = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ConnectionError(err.message, err));
    };

    let socket: net.Socket | tls.TLSSocket;
    if (opts.tls) {
      const tlsOpts: tls.ConnectionOptions = {
        host: opts.path ? undefined : opts.host,
        port: opts.path ? undefined : opts.port,
        path: opts.path,
        servername: opts.tls.servername,
        rejectUnauthorized: opts.tls.rejectUnauthorized,
        ca: loadPem(opts.tls.ca, opts.tls.caFile),
        cert: loadPem(opts.tls.cert, opts.tls.certFile),
        key: loadPem(opts.tls.key, opts.tls.keyFile),
      };
      socket = tls.connect(tlsOpts, onConnect);
    } else if (opts.path) {
      socket = net.createConnection({ path: opts.path }, onConnect);
    } else {
      socket = net.createConnection({ host: opts.host, port: opts.port }, onConnect);
    }
    socket.once("error", onError);
  });
}
