// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Structural error checks shared by the internal cache backends
// (exactCache.ts, semanticCache.ts). Structural rather than `instanceof
// ReplyError`, for the same reason src/errors.ts's own predicates are: a
// bundled subpath entry point (@hotkv/client/ai-sdk, @hotkv/client/langchain) has its own
// copy of the error classes, not `instanceof` compatible with one raised
// by a plain `@hotkv/client` import in the same process.

/** True for a `-NOLICENSE ...` reply, wherever the error came from. */
export function isNotLicensedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "NOLICENSE";
}

/** True for a "... not found" reply, such as PCACHE.STATS on a namespace nobody created. */
export function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const raw = (err as { raw?: unknown }).raw;
  return typeof raw === "string" && /not found/i.test(raw);
}

/** True for a "namespace already exists" reply from `SCACHE.CREATE`/`PCACHE.CREATE`. */
export function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const raw = (err as { raw?: unknown }).raw;
  return typeof raw === "string" && /already exists/i.test(raw);
}
