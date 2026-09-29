import { describe, expect, it } from "vitest";
import { DENY_GUIDANCE_MESSAGE, HavkPrivilegeManager } from "../src/core/sudo/privilege-manager.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

describe("Bash tool sudo approval boundary", () => {
	it("allows non-sudo commands without approval", async () => {
		const executedCommands: string[] = [];
		const mockOps: BashOperations = {
			exec: async (command) => {
				executedCommands.push(command);
				return { exitCode: 0 };
			},
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => {
			throw new Error("Approval handler should not be called for non-sudo!");
		});

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
		});

		const res = await tool.execute("call-1", { command: "echo hello" });
		expect(res.content[0]?.type).toBe("text");
		expect(executedCommands).toEqual(["echo hello"]);
	});

	it("fails closed when no approval handler is registered", async () => {
		const mockOps: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(undefined);

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		await expect(tool.execute("call-2", { command: "sudo apt update" })).rejects.toThrow(
			/Sudo approval requires an interactive TUI session/,
		);
	});

	it("blocks execution and returns anti-retry guidance on denial", async () => {
		const executedCommands: string[] = [];
		const mockOps: BashOperations = {
			exec: async (command) => {
				executedCommands.push(command);
				return { exitCode: 0 };
			},
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => ({ decision: "deny" }));

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		await expect(tool.execute("call-3", { command: "sudo apt update" })).rejects.toThrow(DENY_GUIDANCE_MESSAGE);
		expect(executedCommands).toHaveLength(0);
	});

	it("binds approval at the final mutable boundary including commandPrefix and spawnHook", async () => {
		const executedCommands: string[] = [];
		const executedEnvs: NodeJS.ProcessEnv[] = [];
		const approvedCommands: string[] = [];

		const mockOps: BashOperations = {
			exec: async (command, _cwd, opts) => {
				executedCommands.push(command);
				if (opts.env) executedEnvs.push(opts.env);
				return { exitCode: 0 };
			},
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async ({ commandText }) => {
			approvedCommands.push(commandText);
			return { decision: "allow-once" };
		});

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
			commandPrefix: "source /etc/profile",
			spawnHook: (context) => ({
				...context,
				command: `${context.command}\necho post_hook`,
				env: { ...context.env, BASH_ENV: "/tmp/evil_bash_env.sh", CUSTOM_VAR: "1" },
			}),
		});

		await tool.execute("call-4", { command: "sudo id" });

		// Verify that what the user approved was the final command after prefix and hook
		expect(approvedCommands).toHaveLength(1);
		expect(approvedCommands[0]).toBe("source /etc/profile\nsudo id\necho post_hook");

		// Verify that what was executed matches exactly what was approved
		expect(executedCommands).toEqual(["source /etc/profile\nsudo id\necho post_hook"]);

		// Verify that BASH_ENV was stripped from execution env for safety
		expect(executedEnvs).toHaveLength(1);
		expect(executedEnvs[0]!.BASH_ENV).toBeUndefined();
		expect(executedEnvs[0]!.CUSTOM_VAR).toBe("1");
	});

	it("blocks reserved sudo options before execution", async () => {
		const mockOps: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => ({ decision: "allow-once" }));

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		await expect(tool.execute("call-5", { command: "sudo -S id" })).rejects.toThrow(
			/Agent-authored sudo stdin option/,
		);
	});

	it("promotes to ALLOW_SUDO_SESSION only after successful execution (exitCode 0)", async () => {
		const executedCommands: string[] = [];
		const mockOps: BashOperations = {
			exec: async (command) => {
				executedCommands.push(command);
				return { exitCode: 0 };
			},
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		let approvalPrompts = 0;
		manager.setApprovalHandler(async () => {
			approvalPrompts++;
			return { decision: "allow-session" };
		});

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		// First command prompts approval and selects allow-session
		expect(manager.getState()).toBe("ASK");
		await tool.execute("call-6", { command: "sudo apt update" });
		expect(approvalPrompts).toBe(1);
		expect(manager.getState()).toBe("ALLOW_SUDO_SESSION");

		// Second command in same session bypasses approval
		await tool.execute("call-7", { command: "sudo apt install -y curl" });
		expect(approvalPrompts).toBe(1); // Not incremented!
		expect(executedCommands).toEqual(["sudo apt update", "sudo apt install -y curl"]);

		// Session reset restores ASK state
		manager.reset();
		expect(manager.getState()).toBe("ASK");

		// Third command after reset requires approval again
		await tool.execute("call-8", { command: "sudo systemctl status" });
		expect(approvalPrompts).toBe(2);
	});

	it("does not promote to ALLOW_SUDO_SESSION if command execution fails with nonzero code", async () => {
		const mockOps: BashOperations = {
			exec: async () => ({ exitCode: 1 }),
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		let approvalPrompts = 0;
		manager.setApprovalHandler(async () => {
			approvalPrompts++;
			return { decision: "allow-session" };
		});

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		expect(manager.getState()).toBe("ASK");
		await expect(tool.execute("call-9", { command: "sudo failing_cmd" })).rejects.toThrow();
		expect(approvalPrompts).toBe(1);
		// Crucial security invariant: state remains ASK because exitCode was nonzero!
		expect(manager.getState()).toBe("ASK");
	});

	it("preserves pre-feature semantics for custom/remote operations by skipping local sudo mediation", async () => {
		const executedCommands: string[] = [];
		const mockRemoteOps: BashOperations = {
			exec: async (command) => {
				executedCommands.push(command);
				return { exitCode: 0 };
			},
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => {
			throw new Error("Local approval handler should NEVER be invoked for custom/remote operations!");
		});

		// Custom operations without enableSudoMediation represents out-of-scope (e.g. remote SSH) execution
		const remoteTool = createBashTool(process.cwd(), {
			operations: mockRemoteOps,
		});

		const res = await remoteTool.execute("remote-1", { command: "sudo apt update" });
		expect(res.content[0]?.type).toBe("text");
		expect(executedCommands).toEqual(["sudo apt update"]);
	});

	it("serializes concurrent sudo requests and prevents overlapping approval dialogs", async () => {
		let activeHandlers = 0;
		let maxConcurrentHandlers = 0;

		const mockOps: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => {
			activeHandlers++;
			maxConcurrentHandlers = Math.max(maxConcurrentHandlers, activeHandlers);
			await new Promise((r) => setTimeout(r, 50));
			activeHandlers--;
			return { decision: "allow-once" };
		});

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		// Run two sudo commands concurrently
		await Promise.all([tool.execute("c1", { command: "sudo id" }), tool.execute("c2", { command: "sudo whoami" })]);

		// Approval handlers must have run strictly one at a time
		expect(maxConcurrentHandlers).toBe(1);
	});

	it("allows second queued sudo request to proceed when first request is aborted", async () => {
		const controller1 = new AbortController();
		const mockOps: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};

		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		let callCount = 0;
		manager.setApprovalHandler(async ({ signal }) => {
			callCount++;
			if (signal?.aborted) {
				return { decision: "deny" };
			}
			await new Promise((r) => setTimeout(r, 20));
			return { decision: "allow-once" };
		});

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		// Start request 1 and abort it
		const p1 = tool.execute("c1", { command: "sudo cmd1" }, controller1.signal);
		controller1.abort();

		// Start request 2 concurrently
		const p2 = tool.execute("c2", { command: "sudo cmd2" });

		await expect(p1).rejects.toThrow();
		const r2 = await p2;
		expect(r2.content[0]?.type).toBe("text");
		expect(callCount).toBe(1);
	});

	it("executes non-sudo commands concurrently without waiting for sudo lock", async () => {
		let concurrentExecutions = 0;
		let maxConcurrent = 0;

		const mockOps: BashOperations = {
			exec: async () => {
				concurrentExecutions++;
				maxConcurrent = Math.max(maxConcurrent, concurrentExecutions);
				await new Promise((r) => setTimeout(r, 30));
				concurrentExecutions--;
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), {
			operations: mockOps,
			enableSudoMediation: true,
		});

		await Promise.all([
			tool.execute("ns1", { command: "echo a" }),
			tool.execute("ns2", { command: "echo b" }),
			tool.execute("ns3", { command: "echo c" }),
		]);

		expect(maxConcurrent).toBeGreaterThan(1);
	});
});
