import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Playwright hard-gate integration tests launch real Chromium.
    testTimeout: 120000,
    // One file at a time: concurrent SwiftShader suites starve each other on CI runners.
    fileParallelism: false,
  },
});
