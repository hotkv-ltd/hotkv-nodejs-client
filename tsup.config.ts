// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    ai: "src/ai/index.ts",
    "ai-sdk": "src/ai-sdk/index.ts",
    langchain: "src/langchain/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  shims: false,
  skipNodeModulesBundle: true,
});
