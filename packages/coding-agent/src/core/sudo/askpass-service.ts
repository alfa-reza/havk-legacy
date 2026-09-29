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
	isCanceled(): boolean;
	getAttempts(): number;
	dispose(): Promise<void>;
}

let cachedTrustedSudo: string | null | undefined;

/**
 * Resolves local sudo binary candidates.
 * Checks common standard paths first (/usr/bin/sudo, /bin/sudo, /usr/local/bin/sudo).
 * Verifies the binary exists, is a regular file, and has executable bits set.
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
 * and strict token validation.
 *
 * NOTE ON SAME-UID ORACLE DEFERRAL:
 * In Havk Local mode, child processes executing under the same Unix UID can
 * read filesystem artifacts and tokens belonging to the user. To prevent
 * the askpass helper from functioning as a password oracle for unprivileged
 * agent-controlled commands, password-capable sudo is deferred in the local
 * execution engine. Sudo mediation is active for NOPASSWD and native credentials.
 */
export async function createAskpassSession(options: AskpassSessionOptions = {}): Promise<AskpassSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "havk-askpass-"));
	fs.chmodSync(tempDir, 0o700);

	const sockPath = path.join(tempDir, "askpass.sock");
	const token = crypto.randomBytes(32).toString("hex");
	const tokenBuf = Buffer.from(token, "utf-8");
	const maxAttempts = options.maxAttempts ?? 1;
	let attempts = 0;
	let canceled = false;
	let disposed = false;
	const activeSockets = new Set<net.Socket>();

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
		activeSockets.add(conn);
		let connPasswordBuf: Buffer | null = null;
		const cleanupConnBuf = () => {
			if (connPasswordBuf) {
				connPasswordBuf.fill(0);
				connPasswordBuf = null;
			}
		};

		conn.on("close", () => {
			cleanupConnBuf();
			activeSockets.delete(conn);
		});
		conn.on("error", () => {
			cleanupConnBuf();
			conn.destroy();
		});

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
						canceled = true;
						conn.destroy();
						return;
					}

					connPasswordBuf = password;
					conn.write(password);
					conn.write("\n", () => {
						conn.end();
						cleanupConnBuf();
					});
				} catch {
					cleanupConnBuf();
					conn.destroy();
				}
			}
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
client.setTimeout(3000, () => {
  client.destroy();
  process.exit(1);
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

		// Terminate all active client connections so server.close does not hang
		for (const sock of activeSockets) {
			try {
				sock.destroy();
			} catch {
				// Best-effort destroy
			}
		}
		activeSockets.clear();

		// Close server with bounded shutdown timeout
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => resolve(), 500);
			server.close(() => {
				clearTimeout(timer);
				resolve();
			});
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
		isCanceled: () => canceled,
		getAttempts: () => attempts,
		dispose,
	};
}

export const AskpassService = {
	resolveTrustedSudoPath,
	setTrustedSudoPathForTesting,
	createSession: createAskpassSession,
};
