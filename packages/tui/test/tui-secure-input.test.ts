import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MockFocusedComponent implements Component {
	readonly received: string[] = [];

	render(): string[] {
		return ["mock"];
	}

	handleInput(data: string): void {
		this.received.push(data);
	}

	invalidate(): void {}
}

describe("TUI Secure Input (S4 Isolation)", () => {
	it("diverts raw terminal input to secure handler and isolates ordinary listeners", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new MockFocusedComponent();

		const listenerReceived: string[] = [];
		tui.addInputListener((data) => {
			listenerReceived.push(data);
			return undefined;
		});

		let debugTriggered = false;
		tui.onDebug = () => {
			debugTriggered = true;
		};

		tui.setFocus(component);
		tui.start();

		// Normal state: listeners and component receive input
		terminal.sendInput("hello");
		assert.deepStrictEqual(listenerReceived, ["hello"]);
		assert.deepStrictEqual(component.received, ["hello"]);

		// Activate secure input
		const secureReceived: string[] = [];
		tui.setSecureInput((data) => {
			secureReceived.push(data);
		});

		// Send secret data
		terminal.sendInput("s");
		terminal.sendInput("e");
		terminal.sendInput("c");
		terminal.sendInput("r");
		terminal.sendInput("e");
		terminal.sendInput("t");

		// Secure handler received all keystrokes
		assert.deepStrictEqual(secureReceived, ["s", "e", "c", "r", "e", "t"]);

		// Ordinary input listener received NOTHING new
		assert.deepStrictEqual(listenerReceived, ["hello"]);

		// Focused component received NOTHING new
		assert.deepStrictEqual(component.received, ["hello"]);

		// Global debug shortcut is also isolated
		terminal.sendInput("\x1b[68;6u"); // Shift+Ctrl+D in kitty CSI-u or legacy
		assert.strictEqual(debugTriggered, false);

		// Deactivate secure input
		tui.setSecureInput(null);

		// Normal input resumes
		terminal.sendInput("world");
		assert.deepStrictEqual(listenerReceived, ["hello", "world"]);
		assert.deepStrictEqual(component.received, ["hello", "world"]);

		tui.stop();
	});

	it("clears secure input handler on stop", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		let count = 0;
		tui.setSecureInput(() => {
			count++;
		});
		tui.start();
		tui.stop();

		// After stop and restart, secure input is reset
		tui.start();
		terminal.sendInput("test");
		assert.strictEqual(count, 0);
		tui.stop();
	});
});
