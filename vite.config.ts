import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The site's Content-Security-Policy has to allow calls to the API, whose
 * address is only known at build time, so fill it in to the built
 * staticwebapp.config.json.
 */
function staticWebAppHeaders(): Plugin {
  let outDir = '';
  return {
    name: 'static-web-app-headers',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      const file = path.join(outDir, 'staticwebapp.config.json');
      const apiUrl = process.env.VITE_API_URL;
      const apiOrigin = apiUrl ? new URL(apiUrl).origin : '';
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace(' %API_ORIGIN%', apiOrigin ? ` ${apiOrigin}` : ''));
    },
  };
}

export default defineConfig({
  root: 'src/client',
  plugins: [react(), staticWebAppHeaders()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api/': 'http://localhost:3000',
    },
  },
});
