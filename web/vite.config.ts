import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: the live game (index.html) and the replay / rewind viewer (replay.html).
// Both are static; the game server serves the built output of either from one port.
const dir = import.meta.dirname;
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(dir, 'index.html'),
        replay: resolve(dir, 'replay.html'),
      },
    },
  },
});
