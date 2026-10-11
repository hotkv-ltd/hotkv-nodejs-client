// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

// Vercel AI SDK language model middleware, published as the "@hotkv/client/ai-sdk"
// entry point. `ai` is an optional peer dependency: a plain `@hotkv/client`
// import never pulls this in.
//
// Types are derived from the AI SDK's own `LanguageModelMiddleware` type
// (via `Parameters`/`ReturnType`) rather than imported from
// `@ai-sdk/provider` directly, so this keeps working across the AI SDK's
// own internal language model spec version bumps without an update here.

import type { LanguageModelMiddleware } from "ai";
import { ExactCacheBackend, type ExactCacheClient } from "../internal/exactCache.js";
import { SemanticCacheBackend, type SemanticCacheClient, type SemanticCacheMetric } from "../internal/semanticCache.js";
import type { TokenUsage } from "../usage.js";
import { buildCacheKey, extractPromptText, isErrorPart, isFinishPart, usageFromAiSdk } from "./cacheKey.js";
import { deserializeGenerateResult, deserializeStreamParts, serializeGenerateResult, serializeStreamParts } from "./serialize.js";

type WrapGenerateArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0];
type WrapStreamArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];
type GenerateResult = Awaited<ReturnType<WrapGenerateArgs["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<WrapStreamArgs["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

export interface HotKVCacheSemanticOptions {
  /** Embeds a prompt's text into a vector, using whatever embedding model/provider you like. */
  embed: (text: string) => Promise<number[]>;
  /** Minimum similarity (0..1) a stored answer must match to count as a hit. Server default is 0.85. */
  threshold?: number;
  metric?: SemanticCacheMetric;
}

export interface HotKVCacheOptions {
  /** A `hotkv.HotKV`/`HotKVCluster` client (or anything with the same `pcache*`/`scache*`/`get`/`set` methods). */
  client: ExactCacheClient & SemanticCacheClient;
  /** Base namespace for cached entries. Default `"ai-sdk-cache"`. */
  namespace?: string;
  /** TTL applied to stored entries, in seconds. Omit for no expiry. */
  ttlSeconds?: number;
  /**
   * Enables similarity based caching alongside exact-key caching: on an
   * exact-key miss, the prompt is embedded and looked up in a `SCACHE.*`
   * namespace before falling through to the real model call.
   */
  semantic?: HotKVCacheSemanticOptions;
}

/**
 * Language model middleware caching `generateText()`/`streamText()`
 * results in HotKV, for `wrapLanguageModel()`.
 *
 * ```ts
 * import { wrapLanguageModel, generateText } from "ai";
 * import { hotkvCache } from "@hotkv/client/ai-sdk";
 * import { HotKV } from "@hotkv/client";
 *
 * const client = new HotKV({ url: process.env.HOTKV_URL });
 * const model = wrapLanguageModel({
 *   model: openai("gpt-6-sol"),
 *   middleware: hotkvCache({ client, ttlSeconds: 3600 }),
 * });
 *
 * const { text } = await generateText({ model, prompt: "Summarize this in one line." });
 * ```
 *
 * The cache key covers the model's provider id, model id, the full
 * prompt and every generation setting (temperature, `maxOutputTokens`,
 * tools, and so on), so two calls only share a cache entry when they are
 * identical in every way that could change the answer. `wrapStream()`
 * records a live stream's parts as they pass through and replays them
 * verbatim on a later identical call; a stream that ends with an
 * `"error"` part is never cached. Exact-key caching falls back to core
 * `GET`/`SET` (a SHA-256 key) the first time the server answers `PCACHE.*`
 * with `NOLICENSE`, so this keeps working on a Starter plan license.
 */
export function hotkvCache(options: HotKVCacheOptions): LanguageModelMiddleware {
  const namespace = options.namespace ?? "ai-sdk-cache";
  const exact = new ExactCacheBackend(options.client, namespace, options.ttlSeconds);
  const semantic = options.semantic
    ? new SemanticCacheBackend(options.client, `${namespace}-semantic`, {
        metric: options.semantic.metric,
        threshold: options.semantic.threshold,
        ttlSeconds: options.ttlSeconds,
      })
    : undefined;

  async function lookup(key: string, promptText: string): Promise<string | null> {
    const exactHit = await exact.get(key);
    if (exactHit !== null) return exactHit;
    if (!semantic) return null;
    const vector = await options.semantic!.embed(promptText);
    return semantic.get(vector);
  }

  async function store(key: string, promptText: string, value: string, usage?: TokenUsage): Promise<void> {
    await exact.set(key, value, undefined, usage);
    if (!semantic) return;
    const vector = await options.semantic!.embed(promptText);
    await semantic.set(promptText, value, vector, usage);
  }

  return {
    wrapGenerate: async ({ doGenerate, params, model }: WrapGenerateArgs): Promise<GenerateResult> => {
      const key = buildCacheKey(model, params);
      const promptText = extractPromptText(params.prompt);
      const cached = await lookup(key, promptText);
      if (cached !== null) {
        return deserializeGenerateResult(cached) as GenerateResult;
      }
      const result = await doGenerate();
      // The model id is always known here, so this always attributes the
      // call's usage (any count the provider did not report is just 0).
      await store(key, promptText, serializeGenerateResult(result), usageFromAiSdk(model, result.usage));
      return result;
    },
    wrapStream: async ({ doStream, params, model }: WrapStreamArgs): Promise<StreamResult> => {
      const key = buildCacheKey(model, params);
      const promptText = extractPromptText(params.prompt);
      const cached = await lookup(key, promptText);
      if (cached !== null) {
        const parts = deserializeStreamParts(cached) as StreamPart[];
        return { stream: replayStream(parts) } as StreamResult;
      }

      const { stream, ...rest } = await doStream();
      const recorded: StreamPart[] = [];
      let sawError = false;
      let usage: TokenUsage | undefined;
      const tapped = stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(chunk, controller) {
            recorded.push(chunk);
            if (isErrorPart(chunk)) sawError = true;
            // The standard, always-emitted final part of a successful
            // stream; as reliable a source of usage as doGenerate()'s.
            if (isFinishPart(chunk)) usage = usageFromAiSdk(model, chunk.usage);
            controller.enqueue(chunk);
          },
          flush: async () => {
            if (!sawError) {
              await store(key, promptText, serializeStreamParts(recorded), usage);
            }
          },
        }),
      );
      return { stream: tapped, ...rest } as StreamResult;
    },
  };
}

function replayStream<T>(parts: T[]): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[index] as T);
      index += 1;
    },
  });
}

export { buildCacheKey, extractPromptText } from "./cacheKey.js";
