// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { CommandArgs, RespValue } from "./resp/types.js";

/**
 * Anything that can send one command and return its decoded reply. HotKV,
 * Pipeline/Multi and HotKVCluster all implement this; every typed command
 * method in ./commands is written once against this interface and mixed
 * into all three.
 */
export interface Executor {
  execute(args: CommandArgs): Promise<RespValue>;
}
