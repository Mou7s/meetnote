export default defineNuxtConfig({
  compatibilityDate: '2026-10-28',
  modules: ['@nuxt/ui'],
  ssr: false,
  nitro: {
    preset: 'bun',
    externals: { external: ['bun:sqlite'] },
    typescript: {
      tsConfig: {
        compilerOptions: { types: ['bun'] }
      }
    }
  },
  runtimeConfig: {
    userKeysEncryptionKey: '',
    dataDir: '.data/store'
  },
  colorMode: { preference: 'system', fallback: 'light' },
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  app: {
    head: {
      title: 'MeetNote · 会议工作空间',
      htmlAttrs: { lang: 'zh-CN' },
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
    }
  },
  typescript: { tsConfig: { compilerOptions: { types: ['bun'] } } }
})
