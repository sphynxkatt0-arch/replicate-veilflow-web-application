import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const buildMeta = {
  gitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local",
  gitRef: process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_REF_NAME ?? "local",
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
  builtAt: new Date().toISOString(),
};

function buildMetadataPlugin(): Plugin {
  return {
    name: "veilflow-build-metadata",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-meta.json",
        source: `${JSON.stringify(buildMeta, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildMetadataPlugin()],
  resolve: {
    alias: [
      {
        find: /^\.\/Chart$/,
        replacement: fileURLToPath(new URL("./src/worldclass/ChartOptimized.tsx", import.meta.url)),
      },
    ],
  },
  define: {
    __VEILFLOW_BUILD_META__: JSON.stringify(buildMeta),
  },
  server: { host: "127.0.0.1", port: 8080 },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
