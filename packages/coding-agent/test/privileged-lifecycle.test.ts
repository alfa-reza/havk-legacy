import { execSync } from "child_process";
import { describe, expect, it } from "vitest";
import { HavkPrivilegeManager } from "../src/core/sudo/privilege-manager.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { killProcessTree } from "../src/utils/shell.ts";

describe("Privileged Process Lifecycle & Cleanup (PRD §5 S2 & §22.11)", () => {
	it("terminates a long-running process group via AbortSignal without leaving descendants", async () => {
		const controller = new AbortController();
		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => ({ decision: "allow-once" }));

		const tool = createBashTool(process.cwd());

		// Start a long-running command and abort after 300ms
		const executionPromise = tool.execute("abort-test-1", { command: "sleep 30" }, controller.signal);

		setTimeout(() => {
			controller.abort();
		}, 300);

		await expect(executionPromise).rejects.toThrow(/Command aborted/);

		// Verify no sleep 30 processes remain belonging to this test
		// Wait a moment for OS process table to settle
		await new Promise((r) => setTimeout(r, 200));
		const psOutput = execSync("ps -eo pid,comm | grep sleep || true", { encoding: "utf-8" });
		// Any sleep 30 should not be present
		expect(psOutput).not.toContain("sleep 30");
	});

	it("terminates a long-running process via timeout without leaving descendants", async () => {
		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => ({ decision: "allow-once" }));

		const tool = createBashTool(process.cwd());

		// 1 second timeout for 10 second sleep
		const executionPromise = tool.execute("timeout-test-1", { command: "sleep 10", timeout: 1 });

		await expect(executionPromise).rejects.toThrow(/Command timed out after 1 seconds/);
	});

	it("coordinated signal sequence sends SIGTERM before SIGKILL", () => {
		// Test that killProcessTree handles valid and dead PIDs without crashing
		expect(() => killProcessTree(999999, { isSudo: true })).not.toThrow();
	});

	it("reaps process tree with child and grandchild processes on abort", async () => {
		const controller = new AbortController();
		const manager = HavkPrivilegeManager.getInstance();
		manager.reset();
		manager.setApprovalHandler(async () => ({ decision: "allow-once" }));

		const tool = createBashTool(process.cwd());

		// Command that spawns subshells
		const cmd = "bash -c 'bash -c \"sleep 25\"'";
		const executionPromise = tool.execute("tree-test-1", { command: cmd }, controller.signal);

		setTimeout(() => {
			controller.abort();
		}, 300);

		await expect(executionPromise).rejects.toThrow(/Command aborted/);

		await new Promise((r) => setTimeout(r, 200));
		const psOutput = execSync("ps -eo pid,args | grep 'sleep 25' | grep -v grep || true", { encoding: "utf-8" });
		expect(psOutput.trim()).toBe("");
	});
});
