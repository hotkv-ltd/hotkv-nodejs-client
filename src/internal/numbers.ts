// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// How a number becomes a command argument.
//
// JavaScript prints a number below 1e-6 or from 1e21 up in exponent form
// (`String(1e-7)` is "1e-7"), and not every HotKV argument parser takes an
// exponent: the dollar amounts of LLMBUDGET.SET and LLMSTATS.PRICE are
// fixed-point decimals with no exponent and no sign, and the floating-point
// arguments parsed with std::from_chars refuse a leading "+". Every float the
// client sends therefore goes through here and leaves as plain decimal text:
// the shortest digits that read back as the same double, an optional minus
// sign, no exponent, no thousands separator and no locale (the output never
// depends on the host's locale).

/** The largest whole-dollar amount a 64-bit count of micro-dollars can hold. */
const MAX_USD_MICROS = (1n << 64n) - 1n;

/** Expands the exponent form JavaScript prints into plain decimal text. */
function expandExponent(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const sign = m[1] ?? "";
  const whole = m[2] ?? "";
  const fraction = m[3] ?? "";
  const exp = Number(m[4]);
  const digits = whole + fraction;
  const point = whole.length + exp;
  let out: string;
  if (point <= 0) {
    out = `0.${"0".repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + "0".repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  // Leading zeros of the whole part ("0012") and trailing zeros of the
  // fraction ("1.500") carry no value.
  const [w = "0", f = ""] = out.split(".");
  const wholePart = w.replace(/^0+(?=\d)/, "");
  const fractionPart = f.replace(/0+$/, "");
  return `${sign}${wholePart}${fractionPart ? `.${fractionPart}` : ""}`;
}

/**
 * The plain decimal text of a finite number: "0.00001" for 1e-5,
 * "1000000000000000000000" for 1e21, "-2.5" for -2.5, "0" for both zeros.
 */
function plainDecimal(value: number): string {
  if (value === 0) return "0";
  return expandExponent(String(value));
}

function describe(what: string | undefined): string {
  return what ?? "number argument";
}

/**
 * A finite float as plain decimal text. Throws a RangeError for NaN and for
 * either infinity: the commands that read a finite double or float (vector
 * components, thresholds, rates, coordinates, INCRBYFLOAT increments) reject
 * them.
 */
export function formatFloat(value: number, what?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`hotkv: ${describe(what)} must be a finite number, got ${String(value)}`);
  }
  return plainDecimal(value);
}

/**
 * A sorted set score or score bound: plain decimal text for a finite number,
 * "inf" and "-inf" for the infinities (ZADD and the range commands read them
 * the same way). Throws a RangeError for NaN.
 */
export function formatScore(value: number, what?: string): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new RangeError(`hotkv: ${describe(what)} must not be NaN`);
  }
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  return plainDecimal(value);
}

/** The number itself, after checking that it is finite (the writer then sends it as plain decimal text). */
export function requireFinite(value: number, what?: string): number {
  formatFloat(value, what);
  return value;
}

/**
 * A float vector component. Same text as formatFloat, and a RangeError for a
 * value outside the 32-bit float range, which the server stores components
 * in and refuses to read. A value too small for a 32-bit float is sent as 0.
 */
export function formatVectorComponent(value: number, what?: string): string {
  const text = formatFloat(value, what ?? "vector component");
  const f32 = Math.fround(value);
  if (!Number.isFinite(f32)) {
    throw new RangeError(`hotkv: ${what ?? "vector component"} ${text} is outside the 32-bit float range`);
  }
  return f32 === 0 ? "0" : text;
}

/** A number argument as the writer sends it: integers and floats as plain decimal, NaN refused, the infinities as "inf" and "-inf". */
export function formatNumberArg(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value === 0 ? "0" : String(value);
  return formatScore(value, "number argument");
}

/** Adds one to a string of decimal digits. */
function incrementDigits(digits: string): string {
  const chars = digits.split("");
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === "9") {
      chars[i] = "0";
      i -= 1;
    } else {
      chars[i] = String(Number(chars[i]) + 1);
      return chars.join("");
    }
  }
  return `1${chars.join("")}`;
}

const USD_TEXT = /^\d+(?:\.\d{1,6})?$/;

/**
 * A dollar amount as the fixed-point decimal the server reads exactly
 * (LLMBUDGET.SET, LLMSTATS.PRICE SET): digits with an optional fraction of at
 * most six digits (micro-dollars), no sign and no exponent. A number is
 * rounded half up to six decimals on its shortest decimal text, so 5e-7
 * becomes "0.000001" and 0.1 + 0.2 becomes "0.3". Throws a RangeError for a
 * negative, NaN, infinite or too large amount. A string is the caller's own
 * decimal and is checked, not changed.
 */
export function formatUsd(value: number | string, what?: string): string {
  if (typeof value === "string") {
    if (!USD_TEXT.test(value)) {
      throw new RangeError(
        `hotkv: ${describe(what)} "${value}" is not a dollar amount: use digits with at most 6 decimals, no sign and no exponent`,
      );
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`hotkv: ${describe(what)} must be a finite number of at least 0, got ${String(value)}`);
  }
  const [rawWhole = "0", rawFraction = ""] = plainDecimal(value).split(".");
  let whole = rawWhole;
  let fraction = rawFraction;
  if (fraction.length > 6) {
    const roundUp = fraction.charCodeAt(6) >= 53; // the seventh digit is 5 or more
    fraction = fraction.slice(0, 6);
    if (roundUp) {
      const bumped = incrementDigits(whole + fraction);
      whole = bumped.slice(0, bumped.length - 6);
      fraction = bumped.slice(bumped.length - 6);
    }
  }
  fraction = fraction.replace(/0+$/, "");
  if (BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6)) > MAX_USD_MICROS) {
    throw new RangeError(`hotkv: ${describe(what)} ${String(value)} is too large`);
  }
  return fraction ? `${whole}.${fraction}` : whole;
}
