// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
  compatibilityDate: '2025-04-01',
  // `future.compatibilityVersion: 4` tells Nuxt 3 to use the v4
  // directory layout (`srcDir = app/`). Our tree places `app.vue`
  // under `app/` — without this flag Nuxt falls back to
  // `srcDir = rootDir` and silently serves the built-in NuxtWelcome.
  future: {
    compatibilityVersion: 4,
  },
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
    // Vite 5.1+ blocks unknown Host headers — allow our preview
    // domain. See CVE-2024-28849.
    server: {
      allowedHosts: ['.{{APP_ZONE}}', 'localhost'],
    },
  },
});
