// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { AICacheCommands } from "./aicache.js";
import { installAICacheCommands } from "./aicache.js";
import type { AMemCommands } from "./amem.js";
import { installAMemCommands } from "./amem.js";
import type { BitmapCommands } from "./bitmap.js";
import { installBitmapCommands } from "./bitmap.js";
import type { GenericCommands } from "./generic.js";
import { installGenericCommands } from "./generic.js";
import type { GeoCommands } from "./geo.js";
import { installGeoCommands } from "./geo.js";
import type { HashCommands } from "./hash.js";
import { installHashCommands } from "./hash.js";
import type { HotKVCoreCommands } from "./hotkvcore.js";
import { installHotKVCoreCommands } from "./hotkvcore.js";
import type { HyperLogLogCommands } from "./hyperloglog.js";
import { installHyperLogLogCommands } from "./hyperloglog.js";
import type { ListCommands } from "./list.js";
import { installListCommands } from "./list.js";
import type { OpsCommands } from "./ops.js";
import { installOpsCommands } from "./ops.js";
import type { RagCommands } from "./rag.js";
import { installRagCommands } from "./rag.js";
import type { ScriptingCommands } from "./scripting.js";
import { installScriptingCommands } from "./scripting.js";
import type { ServerCommands } from "./server.js";
import { installServerCommands } from "./server.js";
import type { SetCommands } from "./set.js";
import { installSetCommands } from "./set.js";
import type { StreamCommands } from "./stream.js";
import { installStreamCommands } from "./stream.js";
import type { StringCommands } from "./string.js";
import { installStringCommands } from "./string.js";
import type { ZSetCommands } from "./zset.js";
import { installZSetCommands } from "./zset.js";

export * from "./aicache.js";
export * from "./amem.js";
export * from "./bitmap.js";
export * from "./generic.js";
export * from "./geo.js";
export * from "./hash.js";
export * from "./hotkvcore.js";
export * from "./hyperloglog.js";
export * from "./list.js";
export * from "./ops.js";
export * from "./rag.js";
export * from "./scripting.js";
export * from "./server.js";
export * from "./set.js";
export * from "./stream.js";
export * from "./string.js";
export * from "./zset.js";

/**
 * The full typed command surface, mixed
 * into HotKV, Pipeline, Multi and HotKVCluster alike: every one of them
 * implements Executor, and every method here is a thin wrapper over
 * `this.execute(...)`.
 */
export interface AllCommands
  extends StringCommands,
    GenericCommands,
    ListCommands,
    SetCommands,
    HashCommands,
    ZSetCommands,
    StreamCommands,
    GeoCommands,
    BitmapCommands,
    HyperLogLogCommands,
    ServerCommands,
    ScriptingCommands,
    HotKVCoreCommands,
    AICacheCommands,
    AMemCommands,
    RagCommands,
    OpsCommands {}

/** Installs every typed command method onto a prototype that implements Executor. */
export function installCommands(proto: object): void {
  installStringCommands(proto);
  installGenericCommands(proto);
  installListCommands(proto);
  installSetCommands(proto);
  installHashCommands(proto);
  installZSetCommands(proto);
  installStreamCommands(proto);
  installGeoCommands(proto);
  installBitmapCommands(proto);
  installHyperLogLogCommands(proto);
  installServerCommands(proto);
  installScriptingCommands(proto);
  installHotKVCoreCommands(proto);
  installAICacheCommands(proto);
  installAMemCommands(proto);
  installRagCommands(proto);
  installOpsCommands(proto);
}
