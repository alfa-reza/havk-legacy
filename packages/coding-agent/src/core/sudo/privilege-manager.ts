/**
 * Havk Local Privilege Manager.
 *
 * Manages in-memory privilege authorization state (ASK vs ALLOW_SUDO_SESSION),
 * serializes approval/authentication workflows, and returns strict anti-retry guidance
 * upon denial.
 */

import type { SudoApprovalChoice, SudoAuthorizationState } from "./types.ts";

export const DENY_GUIDANCE_MESSAGE =
	"Sudo access denied by the user. Do not retry the same or an equivalent sudo request unless the user explicitly asks you to retry or the task requirements materially change. Continue with a non-sudo alternative if possible.";

export const UNSUPPORTED_AUTH_MESSAGE =
	"Sudo authentication requires an unsupported interactive method.\nThe privileged command was not run.";

export interface ApprovalPromptParams {
	commandText: string;
	signal?: AbortSignal;
}

export interface PasswordPromptParams {
	isRetry: boolean;
	signal?: AbortSignal;
}

export type SudoPasswordPromptHandler = (params: PasswordPromptParams) => Promise<Buffer | null>;

export type SudoApprovalHandler = (params: ApprovalPromptParams) => Promise<SudoApprovalChoice>;

export interface AuthorizationResult {
	approved: boolean;
	reason?: string;
	commitSession?: () => void;
}

export class HavkPrivilegeManager {
	private static instance: HavkPrivilegeManager | undefined;

	private state: SudoAuthorizationState = "ASK";
	private approvalHandler: SudoApprovalHandler | undefined;
	private passwordPromptHandler: SudoPasswordPromptHandler | undefined;
	private mutexQueue: Promise<void> = Promise.resolve();

	static getInstance(): HavkPrivilegeManager {
		if (!HavkPrivilegeManager.instance) {
			HavkPrivilegeManager.instance = new HavkPrivilegeManager();
		}
		return HavkPrivilegeManager.instance;
	}

	getState(): SudoAuthorizationState {
		return this.state;
	}

	setState(nextState: SudoAuthorizationState): void {
		this.state = nextState;
	}

	reset(): void {
		this.state = "ASK";
	}

	isAlreadyRoot(): boolean {
		return typeof process.geteuid === "function" && process.geteuid() === 0;
	}

	setApprovalHandler(handler: SudoApprovalHandler | undefined): void {
		this.approvalHandler = handler;
	}

	setPasswordPromptHandler(handler: SudoPasswordPromptHandler | undefined): void {
		this.passwordPromptHandler = handler;
	}

	async promptPassword(params: PasswordPromptParams): Promise<Buffer | null> {
		if (!this.passwordPromptHandler) {
			return null;
		}
		return this.passwordPromptHandler(params);
	}

	/**
	 * Run an operation holding the serial mutex so concurrent sudo requests
	 * never interleave approval or authentication UI.
	 */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		let release: () => void = () => {};
		const nextLock = new Promise<void>((resolve) => {
			release = resolve;
		});

		const previous = this.mutexQueue;
		this.mutexQueue = (async () => {
			try {
				await previous;
			} catch {
				// Ignore errors from earlier queued tasks
			}
			await nextLock;
		})();

		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/**
	 * Request authorization for an approved execution context.
	 */
	async requestAuthorization(commandText: string, signal?: AbortSignal): Promise<AuthorizationResult> {
		return this.withLock(async () => {
			if (signal?.aborted) {
				return { approved: false, reason: "aborted" };
			}

			// In ALLOW_SUDO_SESSION, approval dialog is bypassed
			if (this.state === "ALLOW_SUDO_SESSION") {
				return { approved: true };
			}

			if (!this.approvalHandler) {
				// If no interactive UI is available, fail closed per PRD §19.4
				return {
					approved: false,
					reason: "Sudo approval requires an interactive TUI session. The privileged command was not run.",
				};
			}

			const result = await this.approvalHandler({ commandText, signal });

			if (result.decision === "deny") {
				return {
					approved: false,
					reason: DENY_GUIDANCE_MESSAGE,
				};
			}

			let commitSession: (() => void) | undefined;
			if (result.decision === "allow-session") {
				commitSession = () => {
					this.state = "ALLOW_SUDO_SESSION";
				};
			}

			return { approved: true, commitSession };
		});
	}
}
