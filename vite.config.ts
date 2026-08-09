// defineConfig comes from vitest/config (a superset of Vite's) so the test
// settings below are typed; the production build does not use vitest.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev-mode proxy points at the local API server (npm run dev:server).
// Production serving does not use Vite at all; the Hono server serves dist/.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT ?? 4317}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
  test: {
    // The pillar suites smoke the operator's real data - thousands of vault,
    // skill, and wrap files. Their runtime tracks filesystem cache warmth, so
    // the 5s default measures the machine, not the code, and would make the
    // gate flaky right after check 1 wipes node_modules.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
