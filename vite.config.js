const { defineConfig } = require('vite');

module.exports = defineConfig({
  root: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});
