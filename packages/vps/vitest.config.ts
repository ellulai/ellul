import { defineConfig, type Plugin } from 'vitest/config';
import { readFileSync } from 'fs';
import path from 'path';

// Mirrors tsup.config.ts's static-text esbuild plugin so .sh/.c/.h/unit imports resolve in tests.
const staticTextLoader = (): Plugin => ({
  name: 'ellul-static-text-loader',
  enforce: 'pre',
  load(id) {
    if (/\.(sh|txt|conf|md|c|h|service|slice|timer)$/.test(id)) {
      const content = readFileSync(id, 'utf8');
      return `export default ${JSON.stringify(content)};`;
    }
    return null;
  },
});

export default defineConfig({
  plugins: [staticTextLoader()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@vps/shared': path.resolve(__dirname, 'src/services/shared'),
      '@vps/services': path.resolve(__dirname, 'src/services'),
      '@vps/configs': path.resolve(__dirname, 'src/configs'),
      '@vps/version': path.resolve(__dirname, 'src/version'),
      '@vps/shell': path.resolve(__dirname, 'src/shell'),
      '@vps/templates': path.resolve(__dirname, 'src/templates'),
    },
  },
});
