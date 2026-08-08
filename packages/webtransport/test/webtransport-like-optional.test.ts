import { describe, expect, test } from "bun:test";
import { WEBTRANSPORT_LIKE_OPTIONAL } from "../src/types.js";

describe("WebTransportLike optional members (C1)", () => {
	test("declared optional set is frozen to getStats only", () => {
		expect([...WEBTRANSPORT_LIKE_OPTIONAL]).toEqual(["getStats"]);
	});
});
