import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    vue(),
    Components({ resolvers: [ElementPlusResolver({ importStyle: 'css' })], dts: false }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:18770',
      '/__desktop__': 'http://127.0.0.1:18770',
      '/fonts': 'http://127.0.0.1:18770',
      '/images': 'http://127.0.0.1:18770',
    },
  },
  build: {
    outDir: '../web',
    emptyOutDir: false,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // ECharts registers models across mutually dependent modules.
        // Preserve source evaluation order when separating its renderer/controls.
        strictExecutionOrder: true,
        entryFileNames: 'app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.woff2'))
            ? 'fonts/[name][extname]'
            : 'assets/[name][extname]',
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: 'chart-renderer', test: /node_modules\/zrender\//, priority: 30 },
            { name: 'chart-series', test: /node_modules\/echarts\/lib\/chart\//, priority: 30 },
            {
              name: 'chart-controls',
              test: /node_modules\/echarts\/lib\/component\//,
              priority: 30,
            },
            { name: 'chart-core', test: /node_modules\/echarts\//, priority: 20 },
          ],
        },
      },
    },
  },
});
