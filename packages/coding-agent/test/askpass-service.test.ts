import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { describe, expect, it } from "vitest";
import { AskpassService } from "../src/core/sudo/askpass-service.ts";

interface ExecResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Executes a process asynchronously without blocking the Node.js event loop,
 * allowing AskpassService IPC servers in the same process to handle connections.
 */
function runAsync(cmd: string, args: string[], timeoutMs = 4000): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// Child already dead
			}
			reject(new Error(`Process timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf-8");
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (!timedOut) {
				resolve({ status: code, stdout, stderr });
			}
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			if (!timedOut) {
				reject(err);
			}
		});
	});
}

describe("AskpassService (S1A & S6 Security Invariants)", () => {
	it("successfully delivers password to askpass helper and immediately zeroes memory", async () => {
		let passwordRequested = false;
		let secretZeroed = false;

		const session = await AskpassService.createSession({
			promptPassword: async (_isRetry) => {
				passwordRequested = true;
				const buf = Buffer.from("super-secret-pass-123", "utf-8");
				// Hook fill to verify zeroization
				const origFill = buf.fill.bind(buf);
				buf.fill = ((value: string | number | Uint8Array, offset?: number, end?: number) => {
					if (value === 0) {
						secretZeroed = true;
					}
					return origFill(value as number, offset, end);
				}) as typeof buf.fill;
				return buf;
			},
		});

		try {
			expect(fs.existsSync(session.helperPath)).toBe(true);
			expect(fs.existsSync(session.binDir)).toBe(true);

			// Execute askpass helper asynchronously
			const result = await runAsync(session.helperPath, ["Password:"]);

			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("super-secret-pass-123");
			expect(passwordRequested).toBe(true);
			expect(secretZeroed).toBe(true);
		} finally {
			await session.dispose();
		}

		// Verify ephemeral directory was cleaned up
		expect(fs.existsSync(session.helperPath)).toBe(false);
	});

	it("anti-oracle: rejects connections with wrong or missing tokens", async () => {
		const session = await AskpassService.createSession({
			promptPassword: async () => Buffer.from("secret", "utf-8"),
		});

		const sockPath = session.helperPath.replace(/askpass\.sh$/, "askpass.sock");

		try {
			// Connect with wrong token with bounded timeout
			const wrongTokenResult = await new Promise<string>((resolve) => {
				let client: net.Socket;
				const timer = setTimeout(() => {
					client?.destroy();
					resolve("");
				}, 3000);

				client = net.connect(sockPath, () => {
					client.write("wrong-bogus-token\n");
				});
				let received = "";
				client.on("data", (d) => {
					received += d.toString();
				});
				client.on("close", () => {
					clearTimeout(timer);
					resolve(received);
				});
				client.on("error", () => {
					clearTimeout(timer);
					resolve(received);
				});
			});

			// Connection was destroyed with 0 bytes transferred
			expect(wrongTokenResult).toBe("");
		} finally {
			await session.dispose();
		}
	});

	it("anti-oracle: rejects replay connections after successful authentication", async () => {
		let promptCount = 0;
		const session = await AskpassService.createSession({
			maxAttempts: 1,
			promptPassword: async () => {
				promptCount++;
				return Buffer.from("pass1", "utf-8");
			},
		});

		try {
			// First run: succeeds
			const first = await runAsync(session.helperPath, []);
			expect(first.status).toBe(0);
			expect(first.stdout.trim()).toBe("pass1");
			expect(promptCount).toBe(1);

			// Second run (replay): fails
			const second = await runAsync(session.helperPath, []);
			expect(second.status).not.toBe(0);
			expect(promptCount).toBe(1); // Prompt not called again
		} finally {
			await session.dispose();
		}
	});

	it("handles cancellation without password disclosure", async () => {
		const session = await AskpassService.createSession({
			promptPassword: async () => null, // User cancelled
		});

		try {
			const result = await runAsync(session.helperPath, []);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe("");
		} finally {
			await session.dispose();
		}
	});

	it("handles AbortSignal by destroying session and removing files", async () => {
		const controller = new AbortController();
		const session = await AskpassService.createSession({
			signal: controller.signal,
			promptPassword: async () => Buffer.from("pass", "utf-8"),
		});

		try {
			expect(fs.existsSync(session.helperPath)).toBe(true);
			controller.abort();

			// Wait for abort listener to run dispose
			for (let i = 0; i < 50; i++) {
				if (!fs.existsSync(session.helperPath)) break;
				await new Promise((r) => setTimeout(r, 20));
			}
			expect(fs.existsSync(session.helperPath)).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("bounded disposal: terminates idle clients and disposes without hanging", async () => {
		const session = await AskpassService.createSession({
			promptPassword: async () => Buffer.from("pass", "utf-8"),
		});

		const sockPath = session.helperPath.replace(/askpass\.sh$/, "askpass.sock");

		try {
			// Connect an idle client that sends no data
			const idleClient = net.connect(sockPath);
			await new Promise<void>((resolve) => {
				idleClient.on("connect", () => resolve());
			});

			// session.dispose() must terminate the idle client and resolve within bounded time
			const disposePromise = session.dispose();
			const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("dispose hung")), 2000));

			await expect(Promise.race([disposePromise, timeoutPromise])).resolves.toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("provides a working PATH shim for sudo -A", async () => {
		const session = await AskpassService.createSession({
			trustedSudoPath: "/bin/echo",
		});

		try {
			const shimPath = `${session.binDir}/sudo`;
			expect(fs.existsSync(shimPath)).toBe(true);

			const result = await runAsync(shimPath, ["arg1", "arg2"]);
			expect(result.status).toBe(0);
			// echo prints "-A arg1 arg2"
			expect(result.stdout.trim()).toBe("-A arg1 arg2");
		} finally {
			await session.dispose();
		}
	});
});
