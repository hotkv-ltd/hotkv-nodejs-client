// Copyright (c) 2026 HotKV Ltd
// Licensed under the Apache License, Version 2.0. See LICENSE in the project root.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Integration tests share one real HotKV server process; running every
    // test file's own connection pool fully in parallel can outrun a
    // modestly threaded server. Files still run one after another (fast
    // enough for this suite), while tests within a file still run
    // concurrently where nothing serializes them.
    fileParallelism: false,
  },
});
