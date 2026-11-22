import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Playwright hard-gate integration tests launch real Chromium.
    testTimeout: 90000,
  },
});
