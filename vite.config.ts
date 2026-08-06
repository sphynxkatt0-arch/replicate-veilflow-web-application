import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  server: {
    // Windows IPv6 loopback (::1) often rejects binding with EACCES
    host: "127.0.0.1",
    // 5173 is inside an OS-reserved port range (5141-5240) on this machine
    port: 8080,
  },
  // the project lives on a drive that is out of space; keep Vite's
  // dependency cache on C: instead of node_modules/.vite
  cacheDir: "C:/Users/smili/AppData/Local/Temp/opencode/vite-cache",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
