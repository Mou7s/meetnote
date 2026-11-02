export default defineNuxtConfig({
  compatibilityDate: '2026-10-28',
  modules: ['@nuxt/ui'],
  ssr: false,
  // The API and Durable Objects run in worker/index.ts, independently of Nitro.
  nitro: { preset: 'static' },
  colorMode: { preference: 'light' },
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  serverDir: 'nuxt-server',
  app: { head: { title: 'MeetNote · 会议工作空间', htmlAttrs: { lang: 'zh-CN' }, link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }], meta: [{ name: 'theme-color', content: '#059669' }] } },
  typescript: { tsConfig: { compilerOptions: { types: ['bun'] } } }
})
