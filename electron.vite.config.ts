import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const root = (p: string) => resolve(import.meta.dirname, p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: root('src/main/index.ts') },
        external: ['better-sqlite3'],
        output: {
          // Electron's built-in modules are CommonJS; a "type": "module"
          // package would load out/main/index.js as ESM and named imports
          // from 'electron' would fail. Emit CommonJS with an explicit .cjs
          // extension so Node/Electron always loads it as CJS.
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: root('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [
      tanstackRouter({
        target: 'react',
        routesDirectory: root('src/renderer/routes'),
        generatedRouteTree: root('src/renderer/routeTree.gen.ts'),
      }),
      tailwindcss(),
      react(),
    ],
    resolve: {
      alias: {
        '#': root('src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: root('src/renderer/index.html') },
      },
    },
  },
})
