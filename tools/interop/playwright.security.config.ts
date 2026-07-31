import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "compose-dashboard-security.pw.ts",
	timeout: 30_000,
	retries: 0,
	use: { browserName: "chromium" },
});
