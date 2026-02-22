import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getCertHashBase64 } from "./cert-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certHash = getCertHashBase64();

export default defineConfig({
    testDir: "./tests",
    timeout: 30_000,
    retries: 0,
    use: {
        browserName: "chromium",
        launchOptions: {
            args: [
                "--origin-to-force-quic-on=127.0.0.1:4433",
                "--ignore-certificate-errors",
                "--allow-insecure-localhost",
                ...(certHash
                    ? [`--ignore-certificate-errors-spki-list=${certHash}`]
                    : []),
                "--webtransport-developer-mode",
            ],
        },
    },
    webServer: {
        command: "bun run addon-server.ts",
        cwd: join(__dirname),
        url: "http://127.0.0.1:4434", // Health endpoint (QUIC on 4433 doesn't respond to HTTP GET)
        reuseExistingServer: !process.env.CI,
        timeout: 15000,
    },
    projects: [
        {
            name: "chromium-webtransport",
            use: { browserName: "chromium" },
        },
    ],
});
