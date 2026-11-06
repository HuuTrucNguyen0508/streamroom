import { defineConfig } from "@playwright/test";

// Runs against an already running app (the docker compose stack by default). Always headless.
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: [
        // Fake mic (a beeping tone) and a fake 2560x1440 screen for getDisplayMedia, both auto-approved.
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
