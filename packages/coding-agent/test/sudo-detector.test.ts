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

	it("detects sudo through command wrappers, options, and quote-removal bypasses", () => {
		const bypassCases = [
			"command -p sudo id",
			"command -- sudo id",
			"exec -- sudo id",
			"env -u FOO sudo id",
			"s\\udo id",
			's""udo id',
			"\\sudo id",
			"nice sudo id",
			"time sudo id",
			"builtin command sudo id",
			"builtin command -p env -u FOO nice -n 10 sudo id",
			"nice -n 5 sudo id",
			"time -p sudo id",
			"s\"u\"d'o' id",
			'"/usr/bin/sudo" id',
			"'/usr/bin/sudo' id",
		];

		for (const cmd of bypassCases) {
			const res = detectSudo(cmd);
			expect(res.hasSudo, `Expected hasSudo=true for: ${cmd}`).toBe(true);
			expect(res.blocked, `Expected blocked=false for: ${cmd}`).toBe(false);
		}
	});

	it("blocks reserved sudo options when invoked via wrappers or quotes", () => {
		const blockedBypassCases = [
			{ cmd: "command -p sudo -S id", reason: "stdin" },
			{ cmd: "exec -- sudo -A id", reason: "askpass" },
			{ cmd: "env -u FOO sudo -k id", reason: "timestamp" },
			{ cmd: "s\\udo -S id", reason: "stdin" },
			{ cmd: 's""udo --askpass id', reason: "askpass" },
			{ cmd: "nice sudoedit /etc/hosts", reason: "sudoedit" },
			{ cmd: "builtin command sudo -i", reason: "interactive" },
		];

		for (const { cmd, reason } of blockedBypassCases) {
			const res = detectSudo(cmd);
			expect(res.hasSudo, `Expected hasSudo=true for: ${cmd}`).toBe(true);
			expect(res.blocked, `Expected blocked=true for: ${cmd}`).toBe(true);
			expect(res.blockReason?.toLowerCase()).toContain(reason.toLowerCase());
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

	it("resets privilege authorization state from ALLOW_SUDO_SESSION back to ASK on session boundary", () => {
		const manager = HavkPrivilegeManager.getInstance();
		manager.setState("ALLOW_SUDO_SESSION");
		expect(manager.getState()).toBe("ALLOW_SUDO_SESSION");

		// Simulate logical session boundary (clear, new session, resume, tree navigation)
		manager.reset();
		expect(manager.getState()).toBe("ASK");
	});

	it("queues concurrent authorization requests through serial mutex", async () => {
		const manager = new HavkPrivilegeManager();
		const order: number[] = [];

		const p1 = manager.withLock(async () => {
			await new Promise((r) => setTimeout(r, 40));
			order.push(1);
		});

		const p2 = manager.withLock(async () => {
			await new Promise((r) => setTimeout(r, 10));
			order.push(2);
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});
});
