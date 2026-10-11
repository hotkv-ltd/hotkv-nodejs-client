// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import type { Executor } from "../executor.js";
import { bool01, num } from "../resp/decode.js";
import type { CommandArg } from "../resp/types.js";

export interface HyperLogLogCommands {
  /** PFADD key [element ...]: whether the cardinality estimate changed. */
  pfAdd(key: string, ...elements: CommandArg[]): Promise<boolean>;
  /** PFCOUNT key [key ...]: approximate cardinality of the (merged) set(s). */
  pfCount(...keys: string[]): Promise<number>;
  /** PFMERGE destination sourcekey [sourcekey ...]. */
  pfMerge(destination: string, ...sourceKeys: string[]): Promise<void>;
}

export function installHyperLogLogCommands(proto: object): void {
  Object.assign(proto, {
    async pfAdd(this: Executor, key: string, ...elements: CommandArg[]) {
      return bool01(await this.execute(["PFADD", key, ...elements]));
    },
    async pfCount(this: Executor, ...keys: string[]) {
      return num(await this.execute(["PFCOUNT", ...keys]));
    },
    async pfMerge(this: Executor, destination: string, ...sourceKeys: string[]) {
      await this.execute(["PFMERGE", destination, ...sourceKeys]);
    },
  });
}
