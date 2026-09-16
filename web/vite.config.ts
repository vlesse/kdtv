import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Set-top boxes run old Chromium. Keep the output conservative.
    target: 'chrome69',
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    port: 9082,
    proxy: { '/api': 'http://localhost:9081' },
  },
});
