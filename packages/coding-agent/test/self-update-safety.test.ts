import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, isOfficialDistribution, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { checkForNewPiVersion } from "../src/utils/version-check.ts";

describe("self-update safety for Havk distribution", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "havk-self-update-test-"));
		writeFileSync(join(tempDir, "package.json"), "{}");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("identifies Havk as a non-official distribution", () => {
		expect(PACKAGE_NAME).toBe("@alfa-reza/havk");
		expect(APP_NAME).toBe("havk");
		expect(isOfficialDistribution()).toBe(false);
	});

	it("automatic version notification safely no-ops and does not surface upstream Pi releases", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@earendil-works/pi-coding-agent",
				version: "99.0.0",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkForNewPiVersion(VERSION);
		expect(result).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("havk update --self does not query the upstream version endpoint or install upstream Pi", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@earendil-works/pi-coding-agent",
				version: "99.0.0",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handled = await handlePackageCommand(["update", "--self"]);
		expect(handled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		const stderr = errorSpy.mock.calls.map(([msg]) => String(msg)).join("\n");
		expect(stderr).toContain("Self-update is not configured for this distribution yet.");
		expect(stderr).toContain(`Update ${PACKAGE_NAME} manually with your package manager.`);
		expect(stderr).not.toContain("@earendil-works/pi-coding-agent");
		expect(process.exitCode).toBe(1);
	});

	it("havk update defaults to self and safely rejects without updating to upstream Pi", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handled = await handlePackageCommand(["update"]);
		expect(handled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		const stderr = errorSpy.mock.calls.map(([msg]) => String(msg)).join("\n");
		expect(stderr).toContain("Self-update is not configured for this distribution yet.");
		expect(stderr).toContain(`Update ${PACKAGE_NAME} manually with your package manager.`);
		expect(stderr).not.toContain("@earendil-works/pi-coding-agent");
		expect(process.exitCode).toBe(1);
	});

	it("havk update --all updates extensions but skips self-update without installing upstream Pi", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handled = await handlePackageCommand(["update", "--all"]);
		expect(handled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		const stderr = errorSpy.mock.calls.map(([msg]) => String(msg)).join("\n");
		expect(stderr).toContain("Self-update is not configured for this distribution yet.");
		expect(stderr).toContain(`Update ${PACKAGE_NAME} manually with your package manager.`);
		expect(stderr).not.toContain("@earendil-works/pi-coding-agent");
	});
});
