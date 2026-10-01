// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
// output "server": apenas a rota de detalhes (/titulo/[type]/[id]) é
// renderizada on-demand, pois IDs arbitrários do TMDB não podem ser
// prerenderizados. As páginas fixas usam `prerender = true` e continuam
// estáticas como antes.
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  security: {
    checkOrigin: true,
    allowedDomains: [
      {
        protocol: 'https',
        hostname: 'cinevee.onrender.com',
      },
    ],
  },
  vite: {
    plugins: [tailwindcss()]
  }
});