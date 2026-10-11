// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { describe, expect, it } from "vitest";
import {
  AskError,
  errorFromReply,
  isAskError,
  isMovedError,
  isNoAuthError,
  isNoScriptError,
  isNotLicensedError,
  isReadOnlyError,
  isReplyError,
  isWrongTypeError,
  MovedError,
  NotLicensedError,
  ReplyError,
} from "../../src/errors.js";

describe("errorFromReply", () => {
  it("builds a NotLicensedError for NOLICENSE", () => {
    const err = errorFromReply("NOLICENSE enterprise feature 'prompt-cache' requires a valid license");
    expect(err).toBeInstanceOf(NotLicensedError);
    expect(err.code).toBe("NOLICENSE");
  });

  it("builds a MovedError with slot and address parsed out", () => {
    const err = errorFromReply("MOVED 3999 127.0.0.1:6381");
    expect(err).toBeInstanceOf(MovedError);
    expect((err as MovedError).slot).toBe(3999);
    expect((err as MovedError).address).toBe("127.0.0.1:6381");
  });

  it("builds an AskError with slot and address parsed out", () => {
    const err = errorFromReply("ASK 3999 127.0.0.1:6381");
    expect(err).toBeInstanceOf(AskError);
    expect((err as AskError).slot).toBe(3999);
    expect((err as AskError).address).toBe("127.0.0.1:6381");
  });

  it("falls back to a plain ReplyError for anything else", () => {
    const err = errorFromReply("WRONGTYPE Operation against a key holding the wrong kind of value");
    expect(err.constructor).toBe(ReplyError);
    expect(err.code).toBe("WRONGTYPE");
  });

  it("treats a code with no message as the whole code", () => {
    const err = errorFromReply("NOAUTH");
    expect(err.code).toBe("NOAUTH");
  });
});

describe("is*Error predicates", () => {
  it("match on error code, not message text", () => {
    expect(isNotLicensedError(errorFromReply("NOLICENSE something entirely different"))).toBe(true);
    expect(isWrongTypeError(errorFromReply("WRONGTYPE x"))).toBe(true);
    expect(isNoAuthError(errorFromReply("NOAUTH x"))).toBe(true);
    expect(isReadOnlyError(errorFromReply("READONLY x"))).toBe(true);
    expect(isNoScriptError(errorFromReply("NOSCRIPT x"))).toBe(true);
    expect(isMovedError(errorFromReply("MOVED 1 a:1"))).toBe(true);
    expect(isAskError(errorFromReply("ASK 1 a:1"))).toBe(true);
  });

  it("reject a same shaped error with a different code", () => {
    expect(isNotLicensedError(errorFromReply("ERR something"))).toBe(false);
  });

  it("reject non-error values", () => {
    expect(isNotLicensedError(null)).toBe(false);
    expect(isNotLicensedError(undefined)).toBe(false);
    expect(isNotLicensedError("NOLICENSE")).toBe(false);
    expect(isNotLicensedError({ code: "NOLICENSE" })).toBe(false); // not an Error instance
  });

  it("are structural rather than tied to one specific class instance, so they still work across a bundle boundary", () => {
    // @hotkv/client/ai is bundled as a separate entry point from hotkv's main
    // entry; a NotLicensedError instance created by "the other bundle"'s
    // copy of the class is not `instanceof` compatible with this one, but
    // still has the same shape and must still be detected.
    class ForeignNotLicensedError extends Error {
      code = "NOLICENSE";
      raw = "NOLICENSE enterprise feature 'x' requires a valid license";
    }
    const foreign = new ForeignNotLicensedError();
    expect(foreign).not.toBeInstanceOf(NotLicensedError);
    expect(isNotLicensedError(foreign)).toBe(true);
    expect(isReplyError(foreign)).toBe(true);
  });
});
