import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite 5.1+ blocks unknown Host headers (DNS-rebinding defense —
// CVE-2024-28849). Our previews are served at
// `{shortId}-{sandboxSlug}.{{APP_ZONE}}`; the leading dot matches every
// subdomain.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.{{APP_ZONE}}', 'localhost'],
  },
});
