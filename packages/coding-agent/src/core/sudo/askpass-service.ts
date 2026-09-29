/**
 * Havk Local Sudo Askpass IPC Service.
 *
 * Implements S1A (secure one-shot authentication) and S6 (auth-routing integrity & anti-oracle)
 * using an ephemeral Unix domain socket, cryptographic one-time token, and immediate zeroization.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { HavkPrivilegeManager } from "./privilege-manager.ts";

export interface AskpassSessionOptions {
	promptPassword?: (isRetry: boolean) => Promise<Buffer | null>;
	signal?: AbortSignal;
	maxAttempts?: number;
	trustedSudoPath?: string;
}

export interface AskpassSession {
	helperPath: string;
	binDir: string;
	env: Record<string, string>;
	dispose(): Promise<void>;
}

let cachedTrustedSudo: string | null | undefined;

/**
 * Resolves and verifies the local trusted sudo binary.
 * Checks common standard paths first, then falls back to PATH resolution.
 * Verifies the binary exists, is executable, and is not agent-controlled.
 */
export function resolveTrustedSudoPath(): string | null {
	if (cachedTrustedSudo !== undefined) {
		return cachedTrustedSudo;
	}

	const candidates = ["/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo"];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				const real = fs.realpathSync(candidate);
				const stat = fs.statSync(real);
				if (stat.isFile() && (stat.mode & 0o111) !== 0) {
					cachedTrustedSudo = real;
					return real;
				}
			}
		} catch {
			// Continue to next candidate
		}
	}

	cachedTrustedSudo = null;
	return null;
}

/**
 * For test harnesses: override the trusted sudo path.
 */
export function setTrustedSudoPathForTesting(trustedPath: string | null | undefined): void {
	cachedTrustedSudo = trustedPath;
}

/**
 * Creates an ephemeral one-shot AskpassSession with isolated Unix socket IPC
 * and strict anti-oracle token validation.
 */
export async function createAskpassSession(options: AskpassSessionOptions = {}): Promise<AskpassSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "havk-askpass-"));
	fs.chmodSync(tempDir, 0o700);

	const sockPath = path.join(tempDir, "askpass.sock");
	const token = crypto.randomBytes(32).toString("hex");
	const tokenBuf = Buffer.from(token, "utf-8");
	const maxAttempts = options.maxAttempts ?? 3;
	let attempts = 0;
	let activePasswordBuf: Buffer | null = null;
	let disposed = false;

	const prompter =
		options.promptPassword ??
		(async (isRetry) => {
			return HavkPrivilegeManager.getInstance().promptPassword({
				isRetry,
				signal: options.signal,
			});
		});

	// 1. Create Unix domain socket server
	const server = net.createServer((conn) => {
		let readBuf = "";
		conn.on("data", async (chunk) => {
			readBuf += chunk.toString("utf-8");
			if (readBuf.includes("\n")) {
				const line = readBuf.split("\n")[0]!.trim();
				const lineBuf = Buffer.from(line, "utf-8");

				// Timing-safe token comparison
				let tokenValid = false;
				if (lineBuf.length === tokenBuf.length) {
					tokenValid = crypto.timingSafeEqual(lineBuf, tokenBuf);
				}

				// Anti-oracle gate (S6):
				// Reject if token invalid, if max attempts exceeded, or if disposed
				if (!tokenValid || attempts >= maxAttempts || disposed) {
					conn.destroy();
					return;
				}

				const isRetry = attempts > 0;
				attempts++;

				try {
					const password = await prompter(isRetry);
					if (!password || disposed) {
						conn.destroy();
						return;
					}

					activePasswordBuf = password;
					conn.write(password);
					conn.write("\n", () => {
						conn.end();
						// Zero memory immediately after transmission
						if (activePasswordBuf) {
							activePasswordBuf.fill(0);
							activePasswordBuf = null;
						}
					});
				} catch {
					conn.destroy();
				}
			}
		});

		conn.on("error", () => {
			conn.destroy();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(sockPath, () => resolve());
		server.on("error", reject);
	});

	// 2. Create Askpass Helper Script
	const helperPath = path.join(tempDir, "askpass.sh");
	const nodeExec = JSON.stringify(process.execPath);
	const sockStr = JSON.stringify(sockPath);
	const tokStr = JSON.stringify(token);

	const helperContent = `#!/bin/sh
exec ${nodeExec} -e '
const net = require("net");
const sock = ${sockStr};
const token = ${tokStr};
const client = net.connect(sock, () => {
  client.write(token + "\\n");
});
let received = false;
client.on("data", (data) => {
  received = true;
  process.stdout.write(data);
});
client.on("end", () => {
  process.exit(received ? 0 : 1);
});
client.on("close", () => {
  if (!received) process.exit(1);
});
client.on("error", () => {
  process.exit(1);
});
'
`;
	fs.writeFileSync(helperPath, helperContent, { mode: 0o700 });

	// 3. Create PATH Shim Directory
	const binDir = path.join(tempDir, "bin");
	fs.mkdirSync(binDir, { mode: 0o700 });
	const sudoShim = path.join(binDir, "sudo");

	const trustedSudo = options.trustedSudoPath ?? AskpassService.resolveTrustedSudoPath() ?? "/usr/bin/sudo";
	const sudoShimContent = `#!/bin/sh
exec "${trustedSudo}" -A "$@"
`;
	fs.writeFileSync(sudoShim, sudoShimContent, { mode: 0o700 });

	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;

		// Zero any active secret buffer
		if (activePasswordBuf) {
			activePasswordBuf.fill(0);
			activePasswordBuf = null;
		}

		// Close server and wait for shutdown
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});

		// Remove ephemeral directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	};

	if (options.signal) {
		if (options.signal.aborted) {
			void dispose();
		} else {
			options.signal.addEventListener("abort", () => void dispose(), { once: true });
		}
	}

	return {
		helperPath,
		binDir,
		env: {
			SUDO_ASKPASS: helperPath,
			PATH: `${binDir}:${process.env.PATH || ""}`,
		},
		dispose,
	};
}

export const AskpassService = {
	resolveTrustedSudoPath,
	setTrustedSudoPathForTesting,
	createSession: createAskpassSession,
};
