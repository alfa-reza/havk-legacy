import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";
import { HOST_PROVIDED_EXTENSION_PACKAGES } from "../src/core/resource-loader.ts";
import { resolvePluginExternal } from "../src/experimental/plugins/bundled.ts";
import * as bundledPiCodingAgent from "../src/index.ts";

describe("dual-package compatibility", () => {
	it("registers both @alfa-reza/havk and @earendil-works/pi-coding-agent in virtual modules", () => {
		expect(PACKAGE_NAME).toBe("@alfa-reza/havk");
		expect(VIRTUAL_MODULES["@alfa-reza/havk"]).toBe(bundledPiCodingAgent);
		expect(VIRTUAL_MODULES["@earendil-works/pi-coding-agent"]).toBe(bundledPiCodingAgent);
	});

	it("includes both identities in host-provided extension packages to avoid duplicate install warnings", () => {
		expect(HOST_PROVIDED_EXTENSION_PACKAGES.has("@alfa-reza/havk")).toBe(true);
		expect(HOST_PROVIDED_EXTENSION_PACKAGES.has("@earendil-works/pi-coding-agent")).toBe(true);
		expect(HOST_PROVIDED_EXTENSION_PACKAGES.has("@mariozechner/pi-coding-agent")).toBe(true);
	});

	it("resolves plugin externals for both new and legacy specifiers", () => {
		const havkResolved = resolvePluginExternal("@alfa-reza/havk/experimental/plugin");
		const legacyResolved = resolvePluginExternal("@earendil-works/pi-coding-agent/experimental/plugin");

		expect(havkResolved).toBeDefined();
		expect(legacyResolved).toBeDefined();
		expect(havkResolved).toBe(legacyResolved);

		expect(resolvePluginExternal("unrelated-package")).toBeUndefined();
	});
});
