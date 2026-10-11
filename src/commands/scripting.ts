// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { createHash } from "node:crypto";
import type { Executor } from "../executor.js";
import { isNoScriptError } from "../errors.js";
import { arr, bool01, str } from "../resp/decode.js";
import type { CommandArg, RespValue } from "../resp/types.js";

function sha1(script: string): string {
  return createHash("sha1").update(script, "utf8").digest("hex");
}

function evalArgs(command: string, script: string, keys: string[], args: CommandArg[]): CommandArg[] {
  return [command, script, keys.length, ...keys, ...args];
}

export interface ScriptingCommands {
  /** EVAL script numkeys key [key ...] arg [arg ...]: the script's own reply, whatever shape that is. */
  eval(script: string, keys: string[], args?: CommandArg[]): Promise<RespValue>;
  /** EVALSHA sha1 numkeys key [key ...] arg [arg ...]. Throws NOSCRIPT if the script was never loaded; see evalShaOrLoad. */
  evalSha(sha1Hex: string, keys: string[], args?: CommandArg[]): Promise<RespValue>;
  /** Computes the script's SHA1, runs EVALSHA, and transparently falls back to EVAL on a NOSCRIPT error. */
  evalShaOrLoad(script: string, keys: string[], args?: CommandArg[]): Promise<RespValue>;
  /** SCRIPT LOAD script: its SHA1 digest, for later EVALSHA calls. */
  scriptLoad(script: string): Promise<string>;
  /** SCRIPT EXISTS sha1 [sha1 ...]. */
  scriptExists(...sha1Hexes: string[]): Promise<boolean[]>;
  /** SCRIPT FLUSH: clears the server's script cache. */
  scriptFlush(): Promise<void>;
}

export function installScriptingCommands(proto: object): void {
  Object.assign(proto, {
    async eval(this: Executor, script: string, keys: string[], args: CommandArg[] = []) {
      return this.execute(evalArgs("EVAL", script, keys, args));
    },
    async evalSha(this: Executor, sha1Hex: string, keys: string[], args: CommandArg[] = []) {
      return this.execute(evalArgs("EVALSHA", sha1Hex, keys, args));
    },
    async evalShaOrLoad(this: Executor, script: string, keys: string[], args: CommandArg[] = []) {
      try {
        return await this.execute(evalArgs("EVALSHA", sha1(script), keys, args));
      } catch (err) {
        if (!isNoScriptError(err)) throw err;
        return this.execute(evalArgs("EVAL", script, keys, args));
      }
    },
    async scriptLoad(this: Executor, script: string) {
      return str(await this.execute(["SCRIPT", "LOAD", script]));
    },
    async scriptExists(this: Executor, ...sha1Hexes: string[]) {
      return arr(await this.execute(["SCRIPT", "EXISTS", ...sha1Hexes])).map(bool01);
    },
    async scriptFlush(this: Executor) {
      await this.execute(["SCRIPT", "FLUSH"]);
    },
  });
}
