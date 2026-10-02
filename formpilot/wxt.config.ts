import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // Source maps make the console logs point at real files while debugging.
      sourcemap: process.env.NODE_ENV !== 'production' ? 'inline' : false,
      chunkSizeWarningLimit: 2000,
    },
  }),
  webExt: {
    // `pnpm dev` opens a browser with this demo form so you can try the extension right away.
    startUrls: ['http://localhost:4173/form.html'],
  },
  manifest: {
    name: 'FormPilot — AI Form Filler',
    short_name: 'FormPilot',
    description:
      'Fill any web form with AI, grounded in your own documents. Suggestions appear right under the field.',
    minimum_chrome_version: '120',
    author: { email: 'namanpathak503@gmail.com' },
    homepage_url: 'https://github.com/Naman503/ai-personal-assistant-projects/tree/main/formpilot',
    permissions: [
      'storage',
      'unlimitedStorage',
      'contextMenus',
      'offscreen',
      'declarativeNetRequestWithHostAccess',
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'FormPilot' },
    commands: {
      'open-suggestions': {
        suggested_key: { default: 'Alt+J', mac: 'Alt+J' },
        description: 'Show AI suggestions for the focused field',
      },
      'fill-form': {
        suggested_key: { default: 'Alt+Shift+J', mac: 'Alt+Shift+J' },
        description: 'Fill the whole form with AI',
      },
    },
  },
});
