import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "services/**", "tests/e2e/**"],
    environment: "node",
    passWithNoTests: false,
  },
});
