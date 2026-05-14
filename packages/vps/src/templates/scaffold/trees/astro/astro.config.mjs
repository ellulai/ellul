import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: ['.{{APP_ZONE}}', 'localhost'],
    },
  },
});
