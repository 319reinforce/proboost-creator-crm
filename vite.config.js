const path = require('path');
const react = require('@vitejs/plugin-react');
const { defineConfig } = require('vite');

module.exports = defineConfig({
  root: path.join(__dirname, 'src/web/client'),
  base: '/app/',
  plugins: [
    react(),
  ],
  build: {
    outDir: path.join(__dirname, 'src/web/public/app'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(__dirname, 'src/web/client/main.jsx'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/recharts') || id.includes('/d3-')) return 'charts';
          return 'vendor';
        },
      },
    },
  },
});
