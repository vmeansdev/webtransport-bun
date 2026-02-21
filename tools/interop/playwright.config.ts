import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    timeout: 30_000,
    retries: 0,
    use: {
        // Chromium is the only browser supporting WebTransport
        browserName: "chromium",
        // Required for WebTransport: allow insecure localhost certs
        launchOptions: {
            args: [
                "--origin-to-force-quic-on=localhost:4433",
                "--ignore-certificate-errors-spki-list=BSQJ0jkQ7wwhR7KvPZ+DSNk2XTZ/MS6xCbo9qu7+g8Y=",
            ],
        },
    },
    projects: [
        {
            name: "chromium-webtransport",
            use: { browserName: "chromium" },
        },
    ],
});
