import { describe, expect, it } from "vitest";
import { detectSudo } from "../src/core/sudo/detector.ts";
import { DENY_GUIDANCE_MESSAGE, HavkPrivilegeManager } from "../src/core/sudo/privilege-manager.ts";

describe("sudo detector", () => {
	it("detects explicit literal sudo commands", () => {
		const cases = [
			"sudo apt update",
			"/usr/bin/sudo apt update",
			"env sudo command",
			"command sudo command",
			"exec sudo command",
			"cd /tmp && sudo command",
			"sudo command1 && sudo command2",
			"printf x | sudo command",
			"( sudo command )",
			"{ sudo command; }",
			'echo "$(sudo id)"',
			"x=$(sudo command)",
			"`sudo command`",
			"cat <(sudo command)",
			"echo x > >(sudo command)",
			"echo before\nsudo command",
		];

		for (const cmd of cases) {
			const res = detectSudo(cmd);
			expect(res.hasSudo, `Expected hasSudo=true for: ${cmd}`).toBe(true);
			expect(res.blocked, `Expected blocked=false for: ${cmd}`).toBe(false);
		}
	});

	it("returns false for non-sudo commands", () => {
		const cases = ["ls -la", "echo sudo", "cat file.txt", "grep -i sudo /etc/group", "python3 -c 'print(\"hello\")'"];

		for (const cmd of cases) {
			const res = detectSudo(cmd);
			expect(res.hasSudo, `Expected hasSudo=false for: ${cmd}`).toBe(false);
		}
	});

	it("blocks agent-authored reserved options", () => {
		const reservedCases = [
			{ cmd: "sudo -S command", reason: "stdin" },
			{ cmd: "sudo --stdin command", reason: "stdin" },
			{ cmd: "sudo -Sn command", reason: "stdin" },
			{ cmd: "sudo -A command", reason: "askpass" },
			{ cmd: "sudo --askpass command", reason: "askpass" },
			{ cmd: "sudo -k command", reason: "timestamp" },
			{ cmd: "sudo -K", reason: "timestamp" },
			{ cmd: "sudo -v", reason: "validate" },
			{ cmd: "sudo -b command", reason: "background" },
			{ cmd: "sudo --background command", reason: "background" },
			{ cmd: "sudoedit file.txt", reason: "sudoedit" },
			{ cmd: "sudo -e file.txt", reason: "sudoedit" },
			{ cmd: "sudo --edit file.txt", reason: "sudoedit" },
			{ cmd: "/usr/bin/sudoedit file.txt", reason: "sudoedit" },
			{ cmd: "sudo -i", reason: "interactive" },
			{ cmd: "sudo --login", reason: "interactive" },
			{ cmd: "sudo -s", reason: "interactive" },
			{ cmd: "sudo --shell", reason: "interactive" },
			{ cmd: "SUDO_ASKPASS=/tmp/evil sudo command", reason: "SUDO_ASKPASS" },
			{ cmd: "env SUDO_ASKPASS=/tmp/evil sudo command", reason: "SUDO_ASKPASS" },
			{ cmd: "export SUDO_ASKPASS=/tmp/evil; sudo command", reason: "SUDO_ASKPASS" },
		];

		for (const { cmd, reason } of reservedCases) {
			const res = detectSudo(cmd);
			expect(res.hasSudo, `Expected hasSudo=true for: ${cmd}`).toBe(true);
			expect(res.blocked, `Expected blocked=true for: ${cmd}`).toBe(true);
			expect(res.blockReason?.toLowerCase()).toContain(reason.toLowerCase());
		}
	});

	it("respects -- and does not misclassify target command options", () => {
		const allowedCases = [
			"sudo -- command -S",
			"sudo -u root -- command -A",
			"sudo grep -S pattern file",
			"sudo echo -A",
		];

		for (const cmd of allowedCases) {
			const res = detectSudo(cmd);
			expect(res.hasSudo, `Expected hasSudo=true for: ${cmd}`).toBe(true);
			expect(res.blocked, `Expected blocked=false for: ${cmd}`).toBe(false);
		}
	});
});

describe("HavkPrivilegeManager", () => {
	it("defaults to ASK state and supports one-time and session approval", async () => {
		const manager = new HavkPrivilegeManager();
		expect(manager.getState()).toBe("ASK");

		// Deny case
		manager.setApprovalHandler(async () => ({ decision: "deny" }));
		const denyResult = await manager.requestAuthorization("sudo apt update");
		expect(denyResult.approved).toBe(false);
		expect(denyResult.reason).toBe(DENY_GUIDANCE_MESSAGE);
		expect(manager.getState()).toBe("ASK");

		// Allow-once case
		manager.setApprovalHandler(async () => ({ decision: "allow-once" }));
		const allowOnceResult = await manager.requestAuthorization("sudo apt update");
		expect(allowOnceResult.approved).toBe(true);
		expect(manager.getState()).toBe("ASK");

		// Allow-session case
		manager.setApprovalHandler(async () => ({ decision: "allow-session" }));
		const allowSessionResult = await manager.requestAuthorization("sudo apt update");
		expect(allowSessionResult.approved).toBe(true);
		expect(allowSessionResult.commitSession).toBeDefined();
		expect(manager.getState()).toBe("ASK");
		allowSessionResult.commitSession!();
		expect(manager.getState()).toBe("ALLOW_SUDO_SESSION");

		// In ALLOW_SUDO_SESSION, handler should not even be called
		let handlerCalled = false;
		manager.setApprovalHandler(async () => {
			handlerCalled = true;
			return { decision: "deny" };
		});
		const subsequentResult = await manager.requestAuthorization("sudo ls");
		expect(subsequentResult.approved).toBe(true);
		expect(handlerCalled).toBe(false);

		// Reset returns to ASK
		manager.reset();
		expect(manager.getState()).toBe("ASK");
	});
});
