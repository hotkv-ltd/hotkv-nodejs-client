// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { HotKVError } from "./errors.js";

/** The pieces of a connection URL relevant to Options; unset fields are left absent. */
export interface ParsedConnectionURL {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls: boolean;
}

const DEFAULT_PORT = 6379;

/**
 * Parses `(hotkv|hotkvs|redis|rediss)://[user[:pass]@]host[:port][/db]`.
 * `hotkvs://` and `rediss://` request TLS; `redis://`/`rediss://` are
 * accepted for drop-in migration and behave identically to their `hotkv`
 * counterparts.
 */
export function parseConnectionURL(raw: string): ParsedConnectionURL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HotKVError(`hotkv: invalid connection URL: ${raw}`);
  }

  const scheme = u.protocol.slice(0, -1).toLowerCase();
  let tls: boolean;
  switch (scheme) {
    case "hotkv":
    case "redis":
      tls = false;
      break;
    case "hotkvs":
    case "rediss":
      tls = true;
      break;
    default:
      throw new HotKVError(
        `hotkv: unsupported URL scheme "${scheme}" (want hotkv, hotkvs, redis, or rediss)`,
      );
  }

  // WHATWG URL keeps the brackets of an IPv6 literal ("[::1]"); a socket wants the bare address.
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1") || "127.0.0.1";
  const portText = u.port;
  const port = portText ? Number(portText) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new HotKVError(`hotkv: invalid port in URL: "${portText}"`);
  }

  const result: ParsedConnectionURL = { host, port, tls };

  if (u.password !== "") {
    result.password = decodeURIComponent(u.password);
    if (u.username !== "") result.username = decodeURIComponent(u.username);
  } else if (u.username !== "") {
    // A single userinfo component with no colon is the legacy single value
    // AUTH form: redis://:secret@host is the canonical spelling, but plain
    // redis://secret@host is accepted too.
    result.password = decodeURIComponent(u.username);
  }

  const path = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
  if (path !== "") {
    const db = Number(path);
    if (!Number.isInteger(db) || db < 0) {
      throw new HotKVError(`hotkv: invalid database index in URL path: "${path}"`);
    }
    result.db = db;
  }

  return result;
}
