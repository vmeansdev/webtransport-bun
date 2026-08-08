import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboard = readFileSync(
	resolve(
		import.meta.dirname,
		"../../../examples/compose-collab/public/index.html",
	),
	"utf8",
);

test("renders peer-controlled dashboard data as inert text", async ({
	page,
}) => {
	const payload = {
		now: "2026-07-31T00:00:00.000Z",
		activeSessions: 1,
		sessions: [
			{
				id: '<img src="/missing" onerror="window.xssExecuted=true">',
				peer: '<svg onload="window.xssExecuted=true">peer</svg>',
			},
		],
		counters: { datagramIn: 1 },
		recentEvents: [
			{
				at: "<script>window.xssExecuted=true</script>",
				type: "<b>event</b>",
				detail: { body: '<img src=x onerror="window.xssExecuted=true">' },
			},
		],
	};
	await page.addInitScript(() => {
		(window as unknown as { xssExecuted?: boolean }).xssExecuted = false;
	});
	await page.route("http://dashboard.test/state", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(payload),
		}),
	);

	await page.setContent(
		dashboard.replace("<head>", '<head><base href="http://dashboard.test/">'),
	);
	await expect(page.locator("#sessions code").first()).toContainText("<img");
	await expect(page.locator("#events code").nth(0)).toContainText("<script>");
	await expect
		.poll(async () =>
			page.evaluate(
				() =>
					(window as unknown as { xssExecuted?: boolean }).xssExecuted === true,
			),
		)
		.toBe(false);
});
