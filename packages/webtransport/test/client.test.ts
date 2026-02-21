import { describe, it, expect } from "bun:test";
import { connect } from "../src/index.js";

describe("webtransport client exports", () => {
    it("exports connect function", () => {
        expect(typeof connect).toBe("function");
    });

    it("connect throws (not yet implemented)", async () => {
        expect(connect("https://localhost:4433")).rejects.toThrow(
            "not yet implemented",
        );
    });

    it("connect with insecureSkipVerify emits warning log", async () => {
        const logs: Array<{ level: string; msg: string }> = [];
        await expect(
            connect("https://localhost:4433", {
                tls: { insecureSkipVerify: true },
                log: (e) => logs.push(e),
            }),
        ).rejects.toThrow("not yet implemented");
        expect(logs).toHaveLength(1);
        const entry = logs[0]!;
        expect(entry.level).toBe("warn");
        expect(entry.msg).toContain("insecureSkipVerify");
        expect(entry.msg).toContain("dev only");
    });
});
