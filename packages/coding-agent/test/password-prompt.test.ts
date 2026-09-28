import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { PasswordPromptComponent, SecurePasswordBuffer } from "../src/modes/interactive/components/password-prompt.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class MockTUI implements Partial<TUI> {
	secureInputHandler: ((data: string) => void) | null = null;
	renderRequested = false;

	setSecureInput(handler: ((data: string) => void) | null): void {
		this.secureInputHandler = handler;
	}

	requestRender(): void {
		this.renderRequested = true;
	}
}

describe("SecurePasswordBuffer", () => {
	it("stores input, calculates mask, and zeroes memory on backspace and clear", () => {
		const buffer = new SecurePasswordBuffer(16);
		buffer.append("abc");
		expect(buffer.charCount).toBe(3);
		expect(buffer.byteLength).toBe(3);
		expect(buffer.getMask()).toBe("***");

		// Extract secret
		const secret = buffer.extractSecret();
		expect(secret.toString("utf-8")).toBe("abc");
		secret.fill(0);

		// Backspace
		buffer.backspace();
		expect(buffer.charCount).toBe(2);
		expect(buffer.byteLength).toBe(2);
		expect(buffer.getMask()).toBe("**");

		// Clear
		buffer.clear();
		expect(buffer.charCount).toBe(0);
		expect(buffer.byteLength).toBe(0);
		expect(buffer.getMask()).toBe("");
	});

	it("handles multi-byte UTF-8 characters properly", () => {
		const buffer = new SecurePasswordBuffer();
		buffer.append("pass🔑word");
		// 'pass' (4) + '🔑' (1 char, 4 bytes) + 'word' (4) = 9 chars, 12 bytes
		expect(buffer.charCount).toBe(9);
		expect(buffer.byteLength).toBe(12);
		expect(buffer.getMask()).toBe("*********");

		// Backspace 4 times ('word')
		buffer.backspace();
		buffer.backspace();
		buffer.backspace();
		buffer.backspace();
		expect(buffer.charCount).toBe(5);
		expect(buffer.byteLength).toBe(8);

		// Backspace 1 more time ('🔑', 4 bytes)
		buffer.backspace();
		expect(buffer.charCount).toBe(4);
		expect(buffer.byteLength).toBe(4);
		expect(buffer.getMask()).toBe("****");

		const secret = buffer.extractSecret();
		expect(secret.toString("utf-8")).toBe("pass");
		secret.fill(0);
		buffer.clear();
	});
});

describe("PasswordPromptComponent (S4 Isolation & UI)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders required PRD copy and never reveals plaintext password", () => {
		const mockTui = new MockTUI();
		let submitted: Buffer | null = null;
		let cancelled = false;

		const prompt = new PasswordPromptComponent({
			tui: mockTui as unknown as TUI,
			onSubmit: (pwd) => {
				submitted = pwd;
			},
			onCancel: () => {
				cancelled = true;
			},
		});

		// Verify secure input was hooked
		expect(mockTui.secureInputHandler).not.toBeNull();

		// Initial render check
		let lines = prompt.render(80);
		const initialJoined = lines.join("\n");
		expect(initialJoined).toContain("Sudo authentication required");
		expect(initialJoined).toContain("Sudo password:");
		expect(initialJoined).toContain("Press Esc to cancel");

		// Feed keystrokes through secure input handler
		mockTui.secureInputHandler!("s");
		mockTui.secureInputHandler!("u");
		mockTui.secureInputHandler!("p");
		mockTui.secureInputHandler!("e");
		mockTui.secureInputHandler!("r");
		mockTui.secureInputHandler!("s");
		mockTui.secureInputHandler!("e");
		mockTui.secureInputHandler!("c");
		mockTui.secureInputHandler!("r");
		mockTui.secureInputHandler!("e");
		mockTui.secureInputHandler!("t");

		lines = prompt.render(80);
		const maskedJoined = lines.join("\n");
		// Check that plaintext is NEVER present
		expect(maskedJoined).not.toContain("supersecret");
		expect(maskedJoined).not.toContain("super");
		expect(maskedJoined).not.toContain("secret");
		// Check that masked stars are present (11 chars)
		expect(maskedJoined).toContain("***********");

		// Test backspace
		mockTui.secureInputHandler!("\x7f");
		lines = prompt.render(80);
		expect(lines.join("\n")).toContain("**********"); // 10 chars now

		// Submit with Enter
		mockTui.secureInputHandler!("\r");
		expect(submitted).not.toBeNull();
		expect(submitted!.toString("utf-8")).toBe("supersecre");
		submitted!.fill(0);

		// Secure input unhooked
		expect(mockTui.secureInputHandler).toBeNull();
		expect(cancelled).toBe(false);
	});

	it("cancels on Escape and clears secure input", () => {
		const mockTui = new MockTUI();
		let cancelled = false;

		new PasswordPromptComponent({
			tui: mockTui as unknown as TUI,
			onSubmit: () => {},
			onCancel: () => {
				cancelled = true;
			},
		});

		mockTui.secureInputHandler!("p");
		mockTui.secureInputHandler!("a");
		mockTui.secureInputHandler!("s");
		mockTui.secureInputHandler!("s");

		mockTui.secureInputHandler!("\x1b"); // Escape
		expect(cancelled).toBe(true);
		expect(mockTui.secureInputHandler).toBeNull();
	});

	it("cancels when AbortSignal triggers", () => {
		const mockTui = new MockTUI();
		let cancelled = false;
		const controller = new AbortController();

		new PasswordPromptComponent({
			tui: mockTui as unknown as TUI,
			onSubmit: () => {},
			onCancel: () => {
				cancelled = true;
			},
			signal: controller.signal,
		});

		mockTui.secureInputHandler!("a");
		mockTui.secureInputHandler!("b");

		controller.abort();
		expect(cancelled).toBe(true);
		expect(mockTui.secureInputHandler).toBeNull();
	});

	it("handles bracketed paste without exposing plaintext", () => {
		const mockTui = new MockTUI();
		let submitted: Buffer | null = null;

		const prompt = new PasswordPromptComponent({
			tui: mockTui as unknown as TUI,
			onSubmit: (pwd) => {
				submitted = pwd;
			},
			onCancel: () => {},
		});

		// Paste wrapped in \x1b[200~ ... \x1b[201~
		mockTui.secureInputHandler!("\x1b[200~pastedSecret123\x1b[201~");

		const lines = prompt.render(80);
		expect(lines.join("\n")).not.toContain("pastedSecret123");
		expect(lines.join("\n")).toContain("***************"); // 15 chars

		mockTui.secureInputHandler!("\n"); // Enter
		expect(submitted).not.toBeNull();
		expect(submitted!.toString("utf-8")).toBe("pastedSecret123");
		submitted!.fill(0);
	});
});
