import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Our own service worker (src/sw.js) so we control the push handler added in Phase 4.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      // 'prompt': a new version waits until the user taps "Update" (no surprise reloads mid-story).
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'One Word Story',
        short_name: 'One Word',
        description: 'Write stories together, one word at a time.',
        start_url: '/',
        scope: '/',
        id: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#faf8f4',
        theme_color: '#1a1612',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Only precache Latin fonts; other alphabets still load from the network if ever needed.
        globIgnores: ['**/*{cyrillic,vietnamese,greek,math,symbols}*'],
      },
    }),
  ],
})
