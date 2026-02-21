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
});
