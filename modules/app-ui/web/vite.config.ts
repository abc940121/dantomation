import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Built into ../ui (committed) and served by core at /m/app-ui/ui/. Relative base, so the
// page works under that prefix. File names stay inside core's ui path pattern.
// KaTeX ships .ttf fallbacks next to woff2/woff; core does not serve .ttf, and every browser we
// target takes woff2. Drop the ttf files and their src entries from the bundle.
function dropTtf() {
  return {
    name: "drop-ttf",
    enforce: "post" as const,
    generateBundle(_: unknown, bundle: Record<string, any>) {
      for (const [name, item] of Object.entries(bundle)) {
        if (name.endsWith(".ttf")) delete bundle[name];
        else if (item.type === "asset" && name.endsWith(".css") && typeof item.source === "string") {
          item.source = item.source.replace(/,\s*url\([^)]*\.ttf\)\s*format\("truetype"\)/g, "");
        }
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), dropTtf()],
  resolve: { alias: { "@": here("./src"), "@shared": here("./shared") } },
  build: {
    outDir: "../ui",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    fs: { allow: [".."] },
    proxy: { "/api": "http://127.0.0.1:8787", "/m": "http://127.0.0.1:8787" },
  },
});
