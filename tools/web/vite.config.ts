import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Every call the web app makes goes to the sim on :3001 — trading through its recording
// /api proxy so the harness measures the browser's orders the way it measures its own,
// and the panel surfaces directly. Nothing here may reach the challenge API on its own.
const SIM = 'http://localhost:3001';
const PATHS = ['/api', '/attempts', '/simulation', '/load', '/chaos', '/history'];

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // `/backoffice` is the panel's own route as well as the sim's prefix, so only the
      // sub-paths are forwarded — a bare `/backoffice` has to reach the app.
      '/backoffice/': SIM,
      ...Object.fromEntries(PATHS.map((path) => [path, SIM])),
    },
  },
});
