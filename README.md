# HotKV Node.js Client

[![CI](https://github.com/hotkv-ltd/hotkv-nodejs-client/actions/workflows/ci.yml/badge.svg)](https://github.com/hotkv-ltd/hotkv-nodejs-client/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

A high-performance Node.js client for [HotKV](https://hotkv.com), a RESP2/RESP3-compatible
in-memory data store with built-in AI and LLM-serving features (semantic and prompt
caching, agent memory, RAG, feature store, rate limiting, time series and more).

Written in TypeScript (strict), zero runtime dependencies (built on `node:net`,
`node:tls`, `node:crypto` and `node:events` only), ships as both ESM and CommonJS
with full `.d.ts` types.

## Install

```
npm install @hotkv/client
```

Requires Node.js 18 or later.

## Quick start

```ts
import { HotKV } from "@hotkv/client";

const client = new HotKV({ url: "hotkv://127.0.0.1:6379" });

await client.set("greeting", "hello");
console.log(await client.get("greeting")); // "hello"

await client.close();
```

CommonJS works the same way:

```js
const { HotKV } = require("@hotkv/client");
```

`createClient(options)` is available as an alternative to `new HotKV(options)`
for callers who prefer a factory function.

## Connecting

```ts
import { HotKV } from "@hotkv/client";

const client = new HotKV({
  host: "127.0.0.1",
  port: 6379,
  username: "app",
  password: "secret",
  db: 0,
  clientName: "my-service",
  connectTimeoutMs: 5000,
  commandTimeoutMs: 0, // 0 disables the per-command timeout
});
```

Or from a URL (`hotkv://`, `hotkvs://` for TLS, and `redis://` / `rediss://` are
accepted too, for drop-in migration):

```ts
const client = new HotKV("hotkv://user:pass@127.0.0.1:6379/0");
```

The client connects lazily: the first command opens the pool's first
connection. Call `await client.connect()` to warm it up ahead of time if you
want to fail fast on startup instead.

By default the client negotiates RESP3 with `HELLO 3` and falls back to RESP2
automatically if the server does not support it (set `resp3: false` to force
RESP2). Set `maxRetries` (default 1) to control how many times an idempotent
read is retried after a connection loss; writes are never retried automatically.

### TLS

```ts
const client = new HotKV({
  host: "db.hotkv.example.com",
  port: 6400,
  tls: {
    caFile: "/etc/ssl/certs/hotkv-ca.pem",
    // certFile / keyFile for mutual TLS
    servername: "db.hotkv.example.com",
  },
});
```

`tls: true` uses platform defaults; `hotkvs://`/`rediss://` URLs enable TLS the
same way. `rejectUnauthorized: false` skips certificate verification: use it in
tests only, never in production.

### Unix sockets

```ts
const client = new HotKV({ path: "/var/run/hotkv.sock" });
```

### Connection pooling

Every `HotKV` instance owns a bounded pool of connections used for ordinary
commands (including blocking ones, such as `BLPOP`, which simply hold their
borrowed connection for the duration of the call):

```ts
const client = new HotKV({
  pool: {
    maxSize: 10, // default 10
    idleTimeoutMs: 30000, // health checked with PING before reuse past this age
    acquireTimeoutMs: 5000, // how long to wait for a free connection
  },
});

client.poolStats(); // { total, idle, inUse, waiting }
```

## Pipelines

Batch several commands into a single round trip. Every typed method is
available on a pipeline exactly as on the client: each call queues the command
and returns a real `Promise` of the usual type, which resolves once `exec()`
runs.

```ts
const pipeline = client.pipeline();
pipeline.set("a", "1");
pipeline.set("b", "2");
pipeline.incr("a");

const results = await pipeline.exec();
// [[null, "OK"], [null, "OK"], [null, 2]]
```

`exec()` resolves to an array of `[error, value]` pairs, one per queued
command, in order. The value is the raw reply: a status or integer reply as
is, a bulk string reply (the result of `get()`, for example) as a `Buffer`.
The promise each queued call returned resolves to the usual decoded value
(`"2"` for `get()`), so await those when you want decoded values. A failed
command never aborts the rest of the batch: its slot carries the error instead
of the value, and that command's own promise rejects too. The same holds for
the results of a transaction.

## Transactions

```ts
const multi = client.multi();
multi.incr("counter");
multi.incr("counter");
const results = await multi.exec(); // [[null, 1], [null, 2]]
```

`WATCH` is supported through `client.watch(...keys)`, which returns a `Multi`
bound to the connection `WATCH` ran on, so `EXEC` observes the same
connection:

```ts
const multi = await client.watch("balance");
const current = await client.get("balance");
multi.set("balance", String(Number(current) - 10));
const results = await multi.exec(); // null if "balance" changed after WATCH
if (results === null) {
  // retry: another client modified a watched key first
}
```

Call `multi.discard()` (alias `multi.unwatch()`) to release a `WATCH` without
running the transaction.

## Pub/Sub

```ts
const sub = client.subscribe("news");

sub.on("message", (msg) => {
  console.log(msg.channel, msg.message);
});

// or, equivalently:
for await (const msg of sub) {
  console.log(msg.channel, msg.message);
}

await client.publish("news", "hello subscribers");
await sub.close();
```

`client.psubscribe(...patterns)` and `client.ssubscribe(...channels)` (sharded
pub/sub) work the same way; the returned `PubSub` also has
`subscribe()`/`unsubscribe()`/`psubscribe()`/`punsubscribe()`/`ssubscribe()`/
`sunsubscribe()` to change subscriptions after the fact. Each `PubSub` owns a
dedicated connection outside the pool. RESP3 push frames are handled
transparently; the client falls back to RESP2's unsolicited replies the same
way when the server does not negotiate RESP3.

## Cluster

```ts
import { HotKVCluster } from "@hotkv/client";

const cluster = new HotKVCluster(["10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379"]);

await cluster.set("user:1000", "profile-data");
console.log(await cluster.get("user:1000"));

await cluster.close();
```

`HotKVCluster` builds its slot map from `CLUSTER SLOTS`, routes each command by
its key's CRC16 slot (honoring `{hash tag}` substrings), and follows `MOVED`
(refreshing the map) and `ASK` (sending `ASKING` first, on the same
connection) redirects, up to `maxRedirects` (default 16). The typed command
methods are the same as on `HotKV`, except the ones that need one connection
(pipelines, transactions, pub/sub). Set `readFromReplicas: true` to route read only
commands to a random replica of the owning slot (its connections send
`READONLY`). There is no cluster wide pipeline or transaction, since a batch can
span slots that live on different nodes; run pipelines and transactions against
a single-key-scoped set of commands, or against a plain `HotKV` pointed at one
node.

It also rides out a live cluster. A lost primary (failover), a reshard in
flight, `CLUSTERDOWN`, `TRYAGAIN` and `LOADING` make a command refresh the slot
map and try again with a short backoff, for up to `retryTimeoutMs` (default
10000) before it fails with `ClusterError`. A command that may have reached a
node whose connection then broke is sent again, as other cluster clients do;
set `commandTimeoutMs` so a node that stops answering is given up on. That is
at-least-once delivery: when the first copy was in fact applied, a command that
is not idempotent (`incr`, `rpush`, `xadd`, `tsAdd`, `llmBudgetConsume`,
`rateLimitCheck`, `llmStatsRecord`, `amemConvAppend` and the other counters and
appends) is applied twice. Pass `retryWrites: false` to have such a failure
thrown to you instead (a read, and a command that never left the client, are
retried either way). A command is routed by its first key
(`EVAL`'s and `XREAD`'s too, where it is not the first argument), and commands
that name several keys need them in one slot: give them a common hash tag, as on
any cluster.

Some commands the server answers from a node's own state, not from a slot. The
cluster client sends these to every primary and merges the answers, so they
cover the whole cluster: the `*List()` commands of the AI engines
(`pcacheList()`, `scacheList()`, `llmBudgetList()`, `rateLimitList()`, ...),
`tagMembers()`/`tagInter()`, `keys()`, `dbSize()` and `flushAll()`. So are
`scriptLoad()` and `scriptFlush()` and the `FUNCTION LOAD`/`DELETE`/`FLUSH`/`RESTORE`
commands (sent with `command()`): the script cache and the function libraries
belong to a node, so `FCALL` finds what was loaded through the client wherever
the key lives. `VSIM.LOAD` and `VSIM.DROP` ask every primary too, and `VSIM.SAVE`
goes to the owner of the snapshot's name, so a snapshot that `VSIM.LIST` shows is
found (if a reshard left the same name on two nodes, the first one found is
returned). `scanIterator()` walks the keyspace of every primary; `executeOnNode()`
and `executeOnPrimaries()` send a command to one node or to each primary.

The commands that act on one node's own state (`ENCRYPTION.*`,
`AUDIT.*`, `OBSERVE`, `ALERTS`, `HOTKEYS`, `ACL`, `CONFIG`, `INFO`, `SLOWLOG`) go to
one primary, not to all of them: an ACL user exists on the nodes it was created
on and no others. Send them with `executeOnNode()` to the node you mean, or with
`executeOnPrimaries()` to every primary. Pointed at a node that is not in a
cluster, `HotKVCluster` is a plain client of that node for every command.

Every AI engine entry (a cache namespace, a vector index, a rate limiter, a
budget, an agent's memory, ...) is keyed by its name, so it lives on one node,
and a name is all a command needs. See "What is clustered" in the HotKV server
README for what is sharded, what every node holds and what stays on one node.
`@hotkv/client/ai-sdk`, `@hotkv/client/langchain` and `@hotkv/client/ai` take a `HotKVCluster` in place
of a `HotKV`.

## Error handling

```ts
import { isNotLicensedError, isWrongTypeError, ReplyError } from "@hotkv/client";

try {
  await client.get("a-list-key");
} catch (err) {
  if (err instanceof ReplyError) {
    console.log(err.code, err.raw); // e.g. "WRONGTYPE", the full server text
  }
}
```

`ConnectionError`, `TimeoutError`, `ProtocolError`, `ReplyError` (and its
`NotLicensedError`/`MovedError`/`AskError` subtypes), `PoolTimeoutError`,
`PoolExhaustedError` and `ClusterError` are all exported, alongside `is*`
predicate helpers (`isNotLicensedError`, `isMovedError`, `isAskError`,
`isWrongTypeError`, `isNoAuthError`, `isReadOnlyError`, `isNoScriptError`,
`isReplyError`). The predicates check the error's `code` rather than its
class, so they work correctly even across the `@hotkv/client` / `@hotkv/client/ai` package
boundary. A missing key's null bulk reply maps to plain `null`, never an
error.

## HotKV exclusive commands

Typed wrappers cover these HotKV command families:
`TAG.*`, `NEXPIRE`/`NTTL`/`NEXPIREAT` (nanosecond TTLs), `HOTKEYS`, `GCRA.*`
(a rate limiter primitive), `VSIM.*` (a vector similarity index),
the AI caches (below), `AMEM.*` (agent memory: conversation, semantic,
working, episodic), `RAG.*`, `RATELIMIT.*`, `TS.*` (time series), `FEATURE.*`
(a feature store) and `OBSERVE`/`ALERTS`.

```ts
await client.tagSet("doc:42", "draft", "internal");
await client.tagMembers("draft"); // ["doc:42", ...]

await client.vsimCreateIndex("docs", 384, { metric: "cosine" });
await client.vsimSet("docs", "doc:42", embeddingVector);
await client.vsimSearch("docs", 5, queryVector); // [{ key, distance }, ...]

await client.nExpire("session:1", 30_000_000_000n); // 30s, nanosecond resolution
```

Cache entries expire after a TTL in seconds (`ttlSeconds`) or at an absolute
time in Unix milliseconds (`pxat`): `scacheSet(ns, query, response, vector, { pxat })`,
`pcacheSet(ns, prompt, response, { pxat })`, the same option on the keyed caches
(`toolCacheSet()`, `nCacheSet()`, `guardSet()`, `rerankSet()`), and
`amemConvCreate()`, `amemSemStore()` and `amemWorkSet()`.

Enterprise features (everything gated behind a license) need a server that has
a license for them. Otherwise they reply with a `NOLICENSE`
error, which is thrown as a `NotLicensedError`; catch it with
`isNotLicensedError()` to detect and degrade gracefully, exactly as the AI
helpers below do internally.

## AI caching (`@hotkv/client/ai`)

The provider neutral AI helpers live in a separate entry point so a plain
key/value client never pulls them in:

```ts
import { HotKV } from "@hotkv/client";
import { PromptCache } from "@hotkv/client/ai";

const client = new HotKV({ url: process.env.HOTKV_URL });
const cache = new PromptCache(client, "chat-responses", {
  ttlSeconds: 3600,
  statsBucket: "chat-llm-usage",
});
await cache.createNamespace();

async function ask(question: string): Promise<string> {
  const { response, hit } = await cache.getOrCall(
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: question }],
      params: { temperature: "0.7" }, // format numbers yourself: keeps keys identical across languages
    },
    async () => {
      // Only runs on a cache miss. Call whatever LLM client you use here;
      // PromptCache has no dependency on any specific provider's SDK.
      const completion = await someLLMClient.chat({ messages: [{ role: "user", content: question }] });
      return {
        response: completion.text,
        usage: {
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          costUsd: completion.usage.costUsd,
        },
        // The original call's token usage, so a later hit attributes it
        // (and its cost, once the model is priced) to stats()'s
        // usageSaved* fields. Distinct from `usage` above, which only
        // feeds statsBucket's LLMSTATS.RECORD accounting.
        tokenUsage: {
          model: "claude-sonnet-5",
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
        },
      };
    },
  );

  console.log(hit ? "served from cache" : "called the LLM");
  return response;
}

console.log(await cache.stats()); // usageSavedRequests, usageSavedInputTokens, ..., usageSavedCostUsd
```

The cache key is a deterministic SHA-256 of a canonical JSON encoding of
`(provider, model, system, messages, params)`; `buildPromptCacheKey()` is
exported directly if you need the key without the caching wrapper, and is
byte-identical across every official HotKV SDK for the same logical request.

`SemanticCache` looks up the nearest cached answer to an embedding vector
above a similarity threshold, calling your function only on a miss; it never
computes embeddings itself:

```ts
import { SemanticCache } from "@hotkv/client/ai";

const cache = new SemanticCache(client, "faq-answers", 1536, { threshold: 0.86 });
await cache.createNamespace();

const { response, hit } = await cache.getOrCall(question, await embed(question), async () => {
  const completion = await someLLMClient.chat({ messages: [{ role: "user", content: question }] });
  return completion.text;
});
```

Both helpers need the corresponding server license feature (`PromptCache` for
`PromptCache`, `SemanticCache` for `SemanticCache`); if it is missing,
`getOrCall` degrades to always calling your function rather than throwing, so
an unlicensed server never breaks the caller.

## LLM cost tracking

`LLMSTATS.*` and `LLMBUDGET.*` track token usage and cost independently of
caching, e.g. across every call your application makes to a given model:

```ts
await client.llmStatsBucket("chat");
await client.llmStatsRecord("chat", 100, 20, 0, 0, 120.5, { model: "claude-sonnet-5" });
// costUsd (the 4th number) is ignored and priced by the server when model is given
console.log(await client.llmStatsGet("chat")); // requests, costUsd, cacheWrite5mTokens, ...

// Custom pricing for a model not in HotKV's built-in price table
await client.llmStatsPriceSet("my-fine-tuned-model", 2, 8);
console.log(await client.llmStatsPriceGet("my-fine-tuned-model"));

await client.llmBudgetSet("team-alpha", 1_000_000, 50.0, 86400);
const allowed = await client.llmBudgetConsume("team-alpha", undefined, undefined, {
  model: "claude-sonnet-5",
  inputTokens: 100,
  outputTokens: 20,
});
```

For OpenAI-style responses, whose `promptTokens` already includes cache
hits, pass `promptTokens - cachedTokens` as `llmStatsRecord()`'s
`inputTokens` (`cachedTokens` is always cache-READ tokens).

## Integrations

Framework integrations live in their own entry points so a plain `@hotkv/client`
import never pulls them in; the matching framework (`ai`, `@langchain/core`)
is an optional peer dependency, only required once you actually import one.

**Vercel AI SDK** (`@hotkv/client/ai-sdk`):

```ts
import { wrapLanguageModel, generateText } from "ai";
import { hotkvCache } from "@hotkv/client/ai-sdk";

const model = wrapLanguageModel({
  model: openai("gpt-6-sol"),
  middleware: hotkvCache({ client, ttlSeconds: 3600 }),
});

const { text } = await generateText({ model, prompt: "Summarize this in one line." });
```

`hotkvCache()` is language model middleware for `wrapLanguageModel()`: the
cache key covers the model's provider id, model id, the full prompt and
every generation setting, and it caches both `generateText()` results and
`streamText()` streams (a cached stream replays its recorded parts
verbatim, without calling the model again). Pass `semantic: { embed, threshold?
}` to also try an embedding based lookup on an exact-key miss before
falling through to the real model call. Every stored entry automatically
records its `TokenUsage` (the model id is always known; any token count
the provider did not report is just 0), so hits show up in
`PCACHE.STATS`/`SCACHE.STATS`'s `usageSaved*` fields with no extra code.

**LangChain.js** (`@hotkv/client/langchain`):

```ts
import { HotKVCache } from "@hotkv/client/langchain";
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({ cache: new HotKVCache(client, { namespace: "chat-responses", ttlSeconds: 3600 }) });
```

`HotKVCache` implements `@langchain/core`'s `BaseCache` for exact-match
caching on `PCACHE.*`; `HotKVSemanticCache(client, embeddings, { threshold })`
does the same by embedding similarity on `SCACHE.*`, one namespace per
`llmKey` so different models never share answers. Both record a
`TokenUsage` automatically whenever the cached `AIMessage` carries a model
name and LangChain.js's standard `usage_metadata`, so hits attribute
savings the same way; a plain text completion (no `usage_metadata`) is
cached exactly as before.

Exact-match caching (`@hotkv/client/ai-sdk`'s `hotkvCache()`, `@hotkv/client/langchain`'s
`HotKVCache`) falls back to core `GET`/`SET` (a SHA-256 derived key) the
first time the server answers `PCACHE.*` with `NOLICENSE`, so both keep
working on a Starter plan license.

## Scanning

`SCAN`/`HSCAN`/`SSCAN`/`ZSCAN` are exposed as async iterators that page
through the keyspace without blocking the server:

```ts
for await (const key of client.scanIterator({ match: "session:*", count: 100 })) {
  console.log(key);
}

for await (const [field, value] of client.hscanIterator("user:1000")) {
  console.log(field, value);
}
```

## Generic escape hatch

```ts
await client.command("OBJECT", "ENCODING", "some-key");
```

## Command coverage

The client has typed methods for the data commands (strings, keys, hashes
including field expiry, lists, sets, sorted sets, streams, geo, bitmaps,
HyperLogLog, scripting, pub/sub and sharded pub/sub, transactions, scans) and
for the HotKV families listed above. It does not have typed methods for every
command of the server; any other command goes through the generic `command`
method. The commands without a typed method include:

- `CLIENT TRACKING`, `CLIENT CACHING`, `CLIENT GETREDIR`, `CLIENT TRACKINGINFO`,
  `CLIENT LIST`/`KILL` and the other `CLIENT` subcommands except `SETNAME`,
  `GETNAME` and `ID`; `ACL`, `FUNCTION`/`FCALL`, `SLOWLOG`, `MEMORY`, `LATENCY`,
  `OBJECT`, `SORT`, `LCS`, `MONITOR` and the `CLUSTER` administration commands;
- the newer commands `HGETDEL`, `HGETEX`, `HSETEX`, `MSETEX`, `DELEX`,
  `HIMPORT`, `XCFGSET`, `SFLUSH`, `CLUSTERSCAN` and `TRIMSLOTS`;
- the probabilistic structures `BF.*`, `CMS.*` and `TOPK.*`;
- the enterprise administration families `TENANT.*`, `IAM.*`, `AUDIT.*`,
  `ENCRYPTION.*` and `REPLICATION.*`, and the `*.SYNC` replication commands.

All of them can be sent with `client.command(...)` or `client.execute([...])`,
which return the raw decoded reply; the integration suite runs a sample of
them live (`test/integration/generic-command.test.ts`). The AI and enterprise
commands answer `NOLICENSE` on a server whose license does not cover them.

`client.execute([...])` (also available on pipelines, transactions and the
cluster client) is the lower level form every typed method is built on, taking
an array of command arguments and returning the raw decoded reply.

## Numbers

A number argument is sent as plain decimal text, never in exponent form
(`1e-7` is sent as `0.0000001`), because not every server parser reads an
exponent. NaN is refused with a `RangeError` before anything is sent.
Dollar amounts (`llmBudgetSet()`, the `llmStatsPriceSet()` prices) are rounded
half up to six decimals, the precision the server stores, and must not be
negative. Sorted set scores and score bounds may be infinite (sent as `inf` and
`-inf`); thresholds, vector components, coordinates and increments must be
finite.

## Testing

Unit tests need no server:

```
npm run test:unit
```

Integration tests run against a live HotKV server, set with `HOTKV_TEST_URL`
(use a throwaway server: some tests flush databases):

```
HOTKV_TEST_URL=hotkv://127.0.0.1:6379 npm run test:integration
```

They are skipped (not failed) when `HOTKV_TEST_URL` is unset. Tests that need
an enterprise license feature the target server does not have loaded skip
themselves with a clear reason, rather than failing, when they see a
`NOLICENSE` reply. More environment variables:

- `HOTKV_TEST_AUTH_URL`: a server started with a password, for the `AUTH` tests
  (`hotkv://:password@127.0.0.1:6379`);
- `HOTKV_TEST_CLUSTER`: comma separated `host:port` seeds of a cluster, to run
  the suite through a `HotKVCluster`; the licensed engines need a licensed
  cluster (`HOTKV_TEST_CLUSTER_TLS_CA` is the CA file of a TLS-only cluster);
- `HOTKV_REMOTE_HOST`, `HOTKV_REMOTE_PORT`, `HOTKV_REMOTE_PASSWORD`,
  `HOTKV_REMOTE_CA`: a public TLS server with a password, for
  `test/integration/remote.test.ts`.

`@hotkv/client/ai-sdk` and `@hotkv/client/langchain` are exercised by
`test/integration/ai-sdk.test.ts` and `test/integration/langchain.test.ts`
using the frameworks' own mock model/fake chat model and a small
deterministic fake embedding function, so no API keys are needed.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

- Bugs and feature requests: [GitHub issues](https://github.com/hotkv-ltd/hotkv-nodejs-client/issues)
- Questions and commercial support: support@hotkv.com
- Security vulnerabilities: see [SECURITY.md](SECURITY.md)

## License

Licensed under the Apache License, Version 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Trademarks and affiliation

"HotKV" is a trademark of HotKV Ltd; the license does not grant rights to use it.
The HotKV server is a separate commercial product, and its enterprise commands need a HotKV license.

HotKV is an independent product of HotKV Ltd. It speaks the RESP protocol and implements
many Redis commands so that existing tools and client habits carry over, but it is not Redis,
Valkey, Dragonfly or KeyDB, and this SDK is built for and tested against HotKV. HotKV Ltd is not
affiliated with, endorsed by or sponsored by Redis Ltd., the Valkey project, DragonflyDB or KeyDB.
Redis is a registered trademark of Redis Ltd. Valkey, Dragonfly, KeyDB and all other product and
company names are trademarks of their respective owners; they are used here only to describe
protocol and command compatibility.
