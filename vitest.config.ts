import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const mock = (p: string) => fileURLToPath(new URL(`./tests/frontend/mocks/${p}`, import.meta.url));

export default defineConfig({
  esbuild: { jsx: "automatic", jsxDev: false },
  test: {
    include: ["tests/frontend/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/frontend/setup.ts"],
  },
  resolve: {
    alias: {
      "@decky/ui": mock("decky-ui.tsx"),
      "@decky/api": mock("decky-api.ts"),
    },
  },
});
