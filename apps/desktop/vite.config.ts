import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

/**
 * Vite serves the frontend; Tauri wraps it in a native window.
 *
 * The dev server binds a fixed port because the Rust shell is configured to
 * load that exact address — a port that moves would leave the window blank
 * with nothing to explain why.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },

  server: {
    // Fixed, and strict about it. The Rust shell loads this exact address, so
    // a port that moved would leave the window blank with nothing to explain
    // why. Failing loudly is the better trade — if this port is taken, free it
    // with `lsof -ti :5173 | xargs kill`.
    port: 5173,
    strictPort: true,
    watch: {
      // The Rust side has its own rebuild loop; watching it here would restart
      // the frontend every time a Rust file is touched.
      ignored: ['**/src-tauri/**'],
    },
  },

  // Tauri reads the built assets from disk, so no server is involved in a
  // release build.
  build: { outDir: 'dist', emptyOutDir: true },
})
