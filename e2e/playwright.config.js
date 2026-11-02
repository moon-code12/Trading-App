import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Dedicated ports and a throwaway database so tests never touch dev data.
export const API_PORT = 4100;
export const WEB_PORT = 5180;
// Set once in the main process; workers inherit it.
process.env.E2E_DB ??= path.join(os.tmpdir(), `trading-e2e-${Date.now()}.db`);
export const DB_FILE = process.env.E2E_DB;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  workers: 1,
  timeout: 240_000,
  reporter: [['list']],
  use: { channel: 'chromium', baseURL: `http://localhost:${WEB_PORT}`, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: [
    {
      command: 'node src/index.js',
      cwd: '../server',
      url: `http://localhost:${API_PORT}/api/health`,
      env: { PORT: String(API_PORT), SIM_PROFILE: 'ideal', JWT_SECRET: 'e2e-secret', ADMIN_EMAIL: 'admin@e2e.test', ADMIN_PASSWORD: 'adminpass1', DB_FILE },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: '../client',
      url: `http://localhost:${WEB_PORT}`,
      env: { API_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
