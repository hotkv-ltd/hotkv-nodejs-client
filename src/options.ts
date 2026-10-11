// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { isIP } from "node:net";
import { parseConnectionURL } from "./url.js";

/** TLS settings. `insecure-skip-verify` equivalent is `rejectUnauthorized: false`; use it for tests only. */
export interface TLSOptions {
  /** PEM encoded CA certificate(s), or their raw content. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Path to a PEM encoded CA certificate file, read when the connection is opened. */
  caFile?: string;
  /** PEM encoded client certificate, for mutual TLS. */
  cert?: string | Buffer;
  /** Path to a PEM encoded client certificate file. */
  certFile?: string;
  /** PEM encoded client private key, for mutual TLS. */
  key?: string | Buffer;
  /** Path to a PEM encoded client private key file. */
  keyFile?: string;
  /** Expected server name for certificate validation and SNI; defaults to the connection host. */
  servername?: string;
  /** Set to false to skip certificate verification. Tests only, never in production. */
  rejectUnauthorized?: boolean;
}

export interface PoolOptions {
  /** Maximum number of pooled connections. Default 10. */
  maxSize?: number;
  /** A pooled connection idle longer than this is health checked (PING) before reuse. Default 30000. */
  idleTimeoutMs?: number;
  /** How long to wait for a connection to become available before failing. Default equals connectTimeoutMs. */
  acquireTimeoutMs?: number;
}

export interface HotKVOptions {
  /** A full connection URL; see parseConnectionURL. Individual fields below override the URL. */
  url?: string;
  host?: string;
  port?: number;
  /** Unix domain socket path. When set, host/port are ignored. Not supported on Windows. */
  path?: string;
  username?: string;
  password?: string;
  /** Database index selected with SELECT after connecting. Default 0. */
  db?: number;
  /** Sent as CLIENT SETNAME / HELLO SETNAME. */
  clientName?: string;
  /** Time allowed to establish a TCP/TLS connection and complete the handshake. Default 5000. */
  connectTimeoutMs?: number;
  /** Time allowed for any single command's reply. 0 disables the timeout. Default 0. */
  commandTimeoutMs?: number;
  /** true for defaults, or a detailed TLSOptions object. Also implied by hotkvs://.rediss:// URLs. */
  tls?: boolean | TLSOptions;
  /** Negotiate RESP3 with HELLO 3, falling back to RESP2 automatically. Default true. */
  resp3?: boolean;
  /** How many times to retry an idempotent read once after a connection loss. Default 1. */
  maxRetries?: number;
  /** Enable TCP keep-alive on the socket. Default true. */
  keepAlive?: boolean;
  /**
   * Send READONLY after connecting, so a cluster replica serves reads on
   * these connections. Used by HotKVCluster for its replica clients.
   */
  replicaReads?: boolean;
  pool?: PoolOptions;
}

export interface ResolvedPoolOptions {
  maxSize: number;
  idleTimeoutMs: number;
  acquireTimeoutMs: number;
}

/** Options after merging url + explicit fields + defaults; what the rest of the client consumes. */
export interface ResolvedOptions {
  host: string;
  port: number;
  path: string | undefined;
  username: string | undefined;
  password: string | undefined;
  db: number;
  clientName: string | undefined;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  tls: TLSOptions | undefined;
  resp3: boolean;
  maxRetries: number;
  keepAlive: boolean;
  replicaReads: boolean;
  pool: ResolvedPoolOptions;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6379;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 0;
const DEFAULT_POOL_MAX_SIZE = 10;
const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30000;

function resolveTLS(opts: HotKVOptions, urlWantsTLS: boolean, host: string): TLSOptions | undefined {
  const requested = typeof opts.tls === "boolean" ? opts.tls : opts.tls !== undefined || urlWantsTLS;
  if (!requested) return undefined;
  const given: TLSOptions = typeof opts.tls === "object" ? opts.tls : {};
  return {
    ca: given.ca,
    caFile: given.caFile,
    cert: given.cert,
    certFile: given.certFile,
    key: given.key,
    keyFile: given.keyFile,
    // An IP address is not a valid TLS server name (RFC 6066): Node warns and ignores it.
    servername: given.servername ?? (isIP(host) === 0 ? host : undefined),
    rejectUnauthorized: given.rejectUnauthorized ?? true,
  };
}

/** Merges a connection URL/options object/plain string with defaults into a fully resolved config. */
export function resolveOptions(input?: string | HotKVOptions): ResolvedOptions {
  const opts: HotKVOptions = typeof input === "string" ? { url: input } : { ...(input ?? {}) };
  const fromUrl = opts.url !== undefined ? parseConnectionURL(opts.url) : undefined;

  const host = opts.host ?? fromUrl?.host ?? DEFAULT_HOST;
  const port = opts.port ?? fromUrl?.port ?? DEFAULT_PORT;
  const username = opts.username ?? fromUrl?.username;
  const password = opts.password ?? fromUrl?.password;
  const db = opts.db ?? fromUrl?.db ?? 0;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return {
    host,
    port,
    path: opts.path,
    username,
    password,
    db,
    clientName: opts.clientName,
    connectTimeoutMs,
    commandTimeoutMs: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    tls: resolveTLS(opts, fromUrl?.tls ?? false, host),
    resp3: opts.resp3 ?? true,
    maxRetries: opts.maxRetries ?? 1,
    keepAlive: opts.keepAlive ?? true,
    replicaReads: opts.replicaReads ?? false,
    pool: {
      maxSize: opts.pool?.maxSize ?? DEFAULT_POOL_MAX_SIZE,
      idleTimeoutMs: opts.pool?.idleTimeoutMs ?? DEFAULT_POOL_IDLE_TIMEOUT_MS,
      acquireTimeoutMs: opts.pool?.acquireTimeoutMs ?? connectTimeoutMs,
    },
  };
}
