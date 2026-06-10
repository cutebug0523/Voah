import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 渲染层走 5174 端口；Electron 主进程在 dev 下加载该地址，生产加载 dist。
export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true }
});
