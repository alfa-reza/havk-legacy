/**
 * Havk Local Sudo Types and Interfaces.
 */

export type SudoAuthorizationState = "ASK" | "ALLOW_SUDO_SESSION";

export interface SudoCommandInvocation {
	raw: string;
	executable: string;
	sudoArgs: string[];
	targetCommand: string[];
	reservedOptions: string[];
	hasAgentAskpassEnv: boolean;
	isSudoedit: boolean;
	isInteractiveShell: boolean;
}

export interface SudoDetectionResult {
	hasSudo: boolean;
	blocked: boolean;
	blockReason?: string;
	invocations: SudoCommandInvocation[];
}

export interface SudoApprovalChoice {
	decision: "deny" | "allow-once" | "allow-session";
}
