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
		});

		await expect(tool.execute("call-5", { command: "sudo -S id" })).rejects.toThrow(
			/Agent-authored sudo stdin option/,
		);
	});

	it("promotes to ALLOW_SUDO_SESSION only after successful execution, bypassing approval for subsequent commands", async () => {
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
});
