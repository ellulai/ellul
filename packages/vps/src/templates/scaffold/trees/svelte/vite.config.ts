import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Vite 5.1+ blocks unknown Host headers. Allow our preview domain.
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.{{APP_ZONE}}', 'localhost'],
  },
});
