import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { SudoApprovalChoice } from "../src/core/sudo/types.ts";
import { SudoApprovalDialogComponent } from "../src/modes/interactive/components/sudo-approval-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class MockTUI implements Partial<TUI> {
	renderRequested = false;
	requestRender(): void {
		this.renderRequested = true;
	}
}

describe("SudoApprovalDialogComponent (S8 & PRD §8.1)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders required PRD copy, sanitized command, and session warning", () => {
		const mockTui = new MockTUI();
		let selectedChoice: SudoApprovalChoice | undefined;

		const hostileCommand = "\x1b[31msudo\x1b[0m \x1b]0;hacked\x07rm -rf /";
		const dialog = new SudoApprovalDialogComponent({
			tui: mockTui as unknown as TUI,
			commandText: hostileCommand,
			onSelect: (choice) => {
				selectedChoice = choice;
			},
		});

		const lines = dialog.render(100);
		const joined = lines.join("\n");

		// Header per PRD §8.1
		expect(joined).toContain("Sudo access requested");
		// Hostile control characters must be sanitized
		expect(joined).not.toContain("\x1b]0;hacked\x07");
		expect(joined).toContain("sudo");
		expect(joined).toContain("rm -rf /");
		// Session root-risk warning per PRD §8.1
		expect(joined).toContain("Session approval may allow full root access if permitted by your sudo policy.");
		// Default choices present
		expect(joined).toContain("Deny");
		expect(joined).toContain("Allow this sudo command");
		expect(joined).toContain("Allow sudo for this session");
		expect(selectedChoice).toBeUndefined();
	});

	it("defaults to Deny when Enter is pressed", () => {
		const mockTui = new MockTUI();
		let selectedChoice: SudoApprovalChoice | undefined;

		const dialog = new SudoApprovalDialogComponent({
			tui: mockTui as unknown as TUI,
			commandText: "sudo apt-get update",
			onSelect: (choice) => {
				selectedChoice = choice;
			},
		});

		// Enter selects default item (Deny)
		dialog.handleInput("\r");
		expect(selectedChoice).toEqual({ decision: "deny" });
	});

	it("selects Allow Once after down arrow and Enter", () => {
		const mockTui = new MockTUI();
		let selectedChoice: SudoApprovalChoice | undefined;

		const dialog = new SudoApprovalDialogComponent({
			tui: mockTui as unknown as TUI,
			commandText: "sudo systemctl restart nginx",
			onSelect: (choice) => {
				selectedChoice = choice;
			},
		});

		// Down arrow key
		dialog.handleInput("\x1b[B");
		// Enter key
		dialog.handleInput("\r");
		expect(selectedChoice).toEqual({ decision: "allow-once" });
	});

	it("selects Allow Session after down arrow twice and Enter", () => {
		const mockTui = new MockTUI();
		let selectedChoice: SudoApprovalChoice | undefined;

		const dialog = new SudoApprovalDialogComponent({
			tui: mockTui as unknown as TUI,
			commandText: "sudo make install",
			onSelect: (choice) => {
				selectedChoice = choice;
			},
		});

		// Down arrow twice
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		// Enter key
		dialog.handleInput("\r");
		expect(selectedChoice).toEqual({ decision: "allow-session" });
	});

	it("cancels with Deny on Escape key", () => {
		const mockTui = new MockTUI();
		let selectedChoice: SudoApprovalChoice | undefined;

		const dialog = new SudoApprovalDialogComponent({
			tui: mockTui as unknown as TUI,
			commandText: "sudo rm /tmp/test",
			onSelect: (choice) => {
				selectedChoice = choice;
			},
		});

		// Move down to Allow Once
		dialog.handleInput("\x1b[B");
		// Escape key
		dialog.handleInput("\x1b");
		expect(selectedChoice).toEqual({ decision: "deny" });
	});

	it("cancels with Deny when AbortSignal fires", () => {
		const mockTui = new MockTUI();
		let selectedChoice: SudoApprovalChoice | undefined;
		const controller = new AbortController();

		new SudoApprovalDialogComponent({
			tui: mockTui as unknown as TUI,
			commandText: "sudo id",
			signal: controller.signal,
			onSelect: (choice) => {
				selectedChoice = choice;
			},
		});

		controller.abort();
		expect(selectedChoice).toEqual({ decision: "deny" });
	});
});
