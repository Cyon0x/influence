import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Builds to ../auth-widget.js — a single self-contained script that
// index.html loads with a plain <script> tag, no module system required on
// the consuming page. emptyOutDir MUST stay false: outDir is the parent
// web/ directory that also holds index.html, app.js, config.js etc — an
// emptied outDir would delete all of it.
export default defineConfig({
  // Privy pulls in WalletConnect/viem-adjacent dependencies that assume a
  // Node-like `process`/`Buffer` global exists (true under webpack's
  // automatic polyfills, not true in Vite by default) — without this,
  // the bundle throws "process is not defined" at load time in the browser.
  plugins: [react(), nodePolyfills()],
  build: {
    outDir: '../',
    emptyOutDir: false,
    lib: {
      entry: 'src/main.jsx',
      name: 'InfluenceAuthWidget',
      formats: ['iife'],
      fileName: () => 'auth-widget.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
