import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base '/app/' — the built app is served by Express under /app, so the plain
// HTML pages keep / as the always-works fallback. In dev, Vite proxies the
// API routes to the Express server on :3000 (run both: npm run dev + dev:web).
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  server: {
    port: 5173,
    proxy: {
      "/app-config": "http://localhost:3000",
      "/chat": "http://localhost:3000",
      "/events": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/otp": "http://localhost:3000",
      "/dev": "http://localhost:3000",
    },
  },
});
