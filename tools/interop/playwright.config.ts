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
                "--origin-to-force-quic-on=127.0.0.1:4433",
                "--ignore-certificate-errors",
            ],
        },
    },
    webServer: {
        command: "cd ../../crates/reference && cargo run",
        url: "http://127.0.0.1:4434", // Health endpoint (QUIC on 4433 doesn't respond to HTTP GET)
        reuseExistingServer: !process.env.CI,
    },
    projects: [
        {
            name: "chromium-webtransport",
            use: { browserName: "chromium" },
        },
    ],
});
