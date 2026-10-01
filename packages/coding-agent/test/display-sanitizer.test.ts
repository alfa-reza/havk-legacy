import { describe, expect, it } from "vitest";
import { sanitizeApprovalDisplay } from "../src/core/sudo/display-sanitizer.ts";

describe("sanitizeApprovalDisplay", () => {
	it("strips ANSI color, cursor, and erase escapes", () => {
		const input = "\x1b[31;1mRed Bold\x1b[0m \x1b[2J\x1b[H\x1b[2Krm -rf /";
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toBe("Red Bold rm -rf /");
	});

	it("strips OSC hyperlinks and window title sequences", () => {
		const input = "\x1b]8;;https://evil.com\x07sudo safe\x1b]8;;\x07";
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toBe("sudo safe");
	});

	it("visibly escapes carriage return and backspace", () => {
		const input = "sudo apt install benign\rrm -rf /\b\b\b";
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toContain("\\r");
		expect(sanitized).toContain("\\b");
		expect(sanitized).toBe("sudo apt install benign\\rrm -rf /\\b\\b\\b");
	});

	it("visibly escapes C0 control characters", () => {
		const input = "sudo \x01\x02\x03cmd\x1f";
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toBe("sudo \\x01\\x02\\x03cmd\\x1f");
	});

	it("visibly escapes Unicode Bidi_Control characters", () => {
		// RLO (\u202E) attempts to reverse the visual order of following text
		const input = "sudo echo \u202Exlm.txt";
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toContain("[U+202E]");
		expect(sanitized).not.toContain("\u202E");
	});

	it("preserves legitimate shell syntax, whitespace, and multi-line structure", () => {
		const input = 'sudo apt update && sudo apt install -y binwalk \\\n  --option="foo bar"';
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toBe(input);
	});

	it("does not mutate original command string", () => {
		const input = "sudo \x1b[31mapt\x1b[0m update";
		const copy = input;
		const sanitized = sanitizeApprovalDisplay(input);
		expect(sanitized).toBe("sudo apt update");
		expect(input).toBe(copy);
	});

	it("neutralizes C1 CSI escapes and visibly escapes C1 controls including U+009B and DEL", () => {
		// 8-bit C1 CSI escape sequence: \u009B2J
		const csiInput = "sudo echo \u009B2Jbenign";
		expect(sanitizeApprovalDisplay(csiInput)).toBe("sudo echo benign");

		// Standalone U+009B
		const standaloneC1 = "sudo echo \u009B";
		expect(sanitizeApprovalDisplay(standaloneC1)).toBe("sudo echo \\x9b");

		// Other C1 controls (0x80 to 0x9F)
		const otherC1 = "sudo echo \u0080\u0085\u0090\u009F";
		expect(sanitizeApprovalDisplay(otherC1)).toBe("sudo echo \\x80\\x85\\x90\\x9f");

		// DEL (0x7F)
		const delInput = "sudo echo \x7f";
		expect(sanitizeApprovalDisplay(delInput)).toBe("sudo echo \\x7f");
	});
});
