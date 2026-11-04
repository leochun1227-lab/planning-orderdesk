import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: [
    { find: '@/lib', replacement: r('./lib') },
    { find: '@/components', replacement: r('./src/components') },
  ] },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2500,
    rollupOptions: { output: { manualChunks(id) {
      if (id.includes('ag-grid')) return 'grid';
      if (id.includes('exceljs')) return 'excel';
    } } } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000', '/login': 'http://127.0.0.1:3000', '/logout': 'http://127.0.0.1:3000' } },
});
