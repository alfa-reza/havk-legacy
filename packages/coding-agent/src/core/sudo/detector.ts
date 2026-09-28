/**
 * Havk Local Sudo Command Detector.
 *
 * Inspects shell command strings at the final execution boundary for explicit
 * literal invocations of sudo/sudoedit and reserved authentication/lifecycle options.
 */

import type { SudoCommandInvocation, SudoDetectionResult } from "./types.ts";

/** Options that take an argument in sudo */
const SUDO_OPTS_WITH_ARG = new Set(["-u", "-g", "-p", "-D", "-C", "-R", "-T", "-h", "-a", "-c", "-t", "-U"]);

const SUDO_LONG_OPTS_WITH_ARG = new Set([
	"--user",
	"--group",
	"--prompt",
	"--chdir",
	"--close-from",
	"--role",
	"--type",
	"--other-user",
]);

/**
 * Tokenize a shell string while respecting quotes, substitutions, and delimiters.
 */
interface ShellToken {
	text: string;
	start: number;
	end: number;
}

function tokenize(input: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = "";
	let tokenStart = 0;
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\" && !inSingle) {
			escaped = true;
			current += ch;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}

		if (!inSingle && !inDouble) {
			// Newline is a command delimiter, treat like ;
			if (ch === "\n") {
				if (current.length > 0) {
					tokens.push({ text: current, start: tokenStart, end: i });
					current = "";
				}
				tokens.push({ text: "\n", start: i, end: i + 1 });
				tokenStart = i + 1;
				continue;
			}

			// Whitespace delimiters
			if (/\s/.test(ch)) {
				if (current.length > 0) {
					tokens.push({ text: current, start: tokenStart, end: i });
					current = "";
				}
				tokenStart = i + 1;
				continue;
			}

			// Operators and structural characters as separate tokens
			if (
				ch === ";" ||
				ch === "|" ||
				ch === "&" ||
				ch === "(" ||
				ch === ")" ||
				ch === "{" ||
				ch === "}" ||
				ch === "`"
			) {
				if (current.length > 0) {
					tokens.push({ text: current, start: tokenStart, end: i });
					current = "";
				}

				// Check for 2-char operators like &&, ||, |&
				const next = input[i + 1];
				if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || (ch === "|" && next === "&")) {
					tokens.push({ text: input.slice(i, i + 2), start: i, end: i + 2 });
					i++;
				} else {
					tokens.push({ text: ch, start: i, end: i + 1 });
				}
				tokenStart = i + 1;
				continue;
			}
		}

		current += ch;
	}

	if (current.length > 0) {
		tokens.push({ text: current, start: tokenStart, end: input.length });
	}

	return tokens;
}

/**
 * Clean quoting from a token for analysis, preserving unquoted structure.
 */
function unquote(str: string): string {
	if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
		return str.slice(1, -1);
	}
	return str;
}

/**
 * Check if token represents sudo or path to sudo.
 */
function isSudoBinary(tok: string): boolean {
	const clean = unquote(tok);
	return clean === "sudo" || clean.endsWith("/sudo");
}

/**
 * Check if token represents sudoedit or path to sudoedit.
 */
function isSudoeditBinary(tok: string): boolean {
	const clean = unquote(tok);
	return clean === "sudoedit" || clean.endsWith("/sudoedit");
}

/**
 * Extract nested commands from command substitutions $(...), `...`, <(...), >(...)
 */
function extractSubstitutions(commandText: string): string[] {
	const subCommands: string[] = [];

	// Extract $( ... )
	let depth = 0;
	let start = -1;
	for (let i = 0; i < commandText.length; i++) {
		if ((commandText[i] === "$" || commandText[i] === "<" || commandText[i] === ">") && commandText[i + 1] === "(") {
			if (depth === 0) start = i + 2;
			depth++;
			i++;
		} else if (commandText[i] === ")" && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				subCommands.push(commandText.slice(start, i));
				start = -1;
			}
		}
	}

	// Extract ` ... `
	let inBacktick = false;
	let btStart = -1;
	for (let i = 0; i < commandText.length; i++) {
		if (commandText[i] === "`" && (i === 0 || commandText[i - 1] !== "\\")) {
			if (!inBacktick) {
				inBacktick = true;
				btStart = i + 1;
			} else {
				inBacktick = false;
				subCommands.push(commandText.slice(btStart, i));
			}
		}
	}

	return subCommands;
}

/**
 * Detect explicit sudo invocations and validate reserved options.
 */
export function detectSudo(commandText: string): SudoDetectionResult {
	const invocations: SudoCommandInvocation[] = [];
	let hasExportedAskpass = false;

	// Check if the command exports or assigns SUDO_ASKPASS globally
	if (/\bexport\s+SUDO_ASKPASS=/i.test(commandText) || /(?:^|[;&|\n])\s*SUDO_ASKPASS=/i.test(commandText)) {
		hasExportedAskpass = true;
	}

	// Also inspect nested substitutions recursively
	const nested = extractSubstitutions(commandText);
	for (const sub of nested) {
		const subResult = detectSudo(sub);
		if (subResult.blocked) {
			return subResult;
		}
		invocations.push(...subResult.invocations);
	}

	const tokens = tokenize(commandText);
	const DELIMITERS = new Set([";", "&&", "||", "|", "|&", "\n", "(", ")", "{", "}"]);

	let i = 0;
	while (i < tokens.length) {
		// Skip delimiters
		while (i < tokens.length && DELIMITERS.has(tokens[i]!.text)) {
			i++;
		}
		if (i >= tokens.length) break;

		// Collect command tokens up to the next delimiter
		const cmdTokens: ShellToken[] = [];
		while (i < tokens.length && !DELIMITERS.has(tokens[i]!.text)) {
			cmdTokens.push(tokens[i]!);
			i++;
		}

		if (cmdTokens.length === 0) continue;

		// Parse simple command
		let tokenIndex = 0;
		let hasAskpassEnv = hasExportedAskpass;

		// Skip and inspect environment variable assignments preceding executable
		while (tokenIndex < cmdTokens.length) {
			const tok = unquote(cmdTokens[tokenIndex]!.text);
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
				if (tok.startsWith("SUDO_ASKPASS=")) {
					hasAskpassEnv = true;
				}
				tokenIndex++;
			} else {
				break;
			}
		}

		if (tokenIndex >= cmdTokens.length) continue;

		// Handle command prefixes: env, command, exec, nohup
		while (tokenIndex < cmdTokens.length) {
			const tok = unquote(cmdTokens[tokenIndex]!.text);
			if (tok === "command" || tok === "exec" || tok === "nohup") {
				tokenIndex++;
			} else if (tok === "env") {
				tokenIndex++;
				// Skip env options like -i or VAR=VAL
				while (tokenIndex < cmdTokens.length) {
					const envTok = unquote(cmdTokens[tokenIndex]!.text);
					if (envTok.startsWith("-")) {
						tokenIndex++;
					} else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(envTok)) {
						if (envTok.startsWith("SUDO_ASKPASS=")) {
							hasAskpassEnv = true;
						}
						tokenIndex++;
					} else {
						break;
					}
				}
			} else {
				break;
			}
		}

		if (tokenIndex >= cmdTokens.length) continue;

		const exeToken = cmdTokens[tokenIndex]!;
		const isSudo = isSudoBinary(exeToken.text);
		const isSudoedit = isSudoeditBinary(exeToken.text);

		if (!isSudo && !isSudoedit) {
			continue;
		}

		// It is a sudo or sudoedit invocation!
		const sudoArgs: string[] = [];
		const targetCommand: string[] = [];
		const reservedOptions: string[] = [];
		let isInteractiveShell = false;
		let sawEndOfOptions = false;
		let sawTargetCommand = false;

		tokenIndex++; // move past sudo/sudoedit

		if (isSudoedit) {
			reservedOptions.push("sudoedit");
		}

		while (tokenIndex < cmdTokens.length) {
			const rawTok = cmdTokens[tokenIndex]!.text;
			const tok = unquote(rawTok);

			if (sawTargetCommand || sawEndOfOptions) {
				targetCommand.push(rawTok);
				tokenIndex++;
				continue;
			}

			if (tok === "--") {
				sawEndOfOptions = true;
				sudoArgs.push(rawTok);
				tokenIndex++;
				continue;
			}

			if (tok.startsWith("-") && tok !== "-") {
				// It's a sudo option
				sudoArgs.push(rawTok);

				// Check long options
				if (tok.startsWith("--")) {
					if (tok === "--stdin") reservedOptions.push("--stdin");
					else if (tok === "--askpass") reservedOptions.push("--askpass");
					else if (tok === "--reset-timestamp") reservedOptions.push("-k");
					else if (tok === "--remove-timestamp") reservedOptions.push("-K");
					else if (tok === "--validate") reservedOptions.push("-v");
					else if (tok === "--background") reservedOptions.push("--background");
					else if (tok === "--edit") reservedOptions.push("--edit");
					else if (tok === "--login") isInteractiveShell = true;
					else if (tok === "--shell") isInteractiveShell = true;

					if (SUDO_LONG_OPTS_WITH_ARG.has(tok)) {
						tokenIndex++;
						if (tokenIndex < cmdTokens.length) {
							sudoArgs.push(cmdTokens[tokenIndex]!.text);
						}
					}
				} else {
					// Short options, e.g. -S, -u root, -Sn, -i, -s
					const flags = tok.slice(1);
					for (let f = 0; f < flags.length; f++) {
						const flag = flags[f];
						if (flag === "S") reservedOptions.push("-S");
						else if (flag === "A") reservedOptions.push("-A");
						else if (flag === "k") reservedOptions.push("-k");
						else if (flag === "K") reservedOptions.push("-K");
						else if (flag === "v") reservedOptions.push("-v");
						else if (flag === "b") reservedOptions.push("-b");
						else if (flag === "e") reservedOptions.push("-e");
						else if (flag === "i") isInteractiveShell = true;
						else if (flag === "s") isInteractiveShell = true;

						if (SUDO_OPTS_WITH_ARG.has(`-${flag}`)) {
							// Check if the argument is combined e.g. -uuser or separate e.g. -u user
							const rest = flags.slice(f + 1);
							if (rest.length > 0) {
								// Argument was attached
								break;
							}
							// Next token is the option argument
							tokenIndex++;
							if (tokenIndex < cmdTokens.length) {
								sudoArgs.push(cmdTokens[tokenIndex]!.text);
							}
							break;
						}
					}
				}
				tokenIndex++;
			} else {
				// First non-option token: start of target command!
				sawTargetCommand = true;
				targetCommand.push(rawTok);
				tokenIndex++;
			}
		}

		// Standalone -v (no target command) is reserved
		if (reservedOptions.includes("-v") && targetCommand.length === 0) {
			// Standalone -v is reserved
		} else if (reservedOptions.includes("-v") && targetCommand.length > 0) {
			// -v with a command is still invalid sudo, keep it reserved
		}

		// Interactive root shell without a command is blocked
		const interactiveWithoutCommand = isInteractiveShell && targetCommand.length === 0;

		invocations.push({
			raw: cmdTokens.map((t) => t.text).join(" "),
			executable: exeToken.text,
			sudoArgs,
			targetCommand,
			reservedOptions,
			hasAgentAskpassEnv: hasAskpassEnv,
			isSudoedit: isSudoedit || reservedOptions.includes("-e") || reservedOptions.includes("--edit"),
			isInteractiveShell: interactiveWithoutCommand,
		});
	}

	if (invocations.length === 0) {
		return { hasSudo: false, blocked: false, invocations: [] };
	}

	// Validate against reserved options
	for (const inv of invocations) {
		if (inv.hasAgentAskpassEnv) {
			return {
				hasSudo: true,
				blocked: true,
				blockReason: "Agent-controlled SUDO_ASKPASS is blocked.",
				invocations,
			};
		}

		if (inv.isSudoedit) {
			return {
				hasSudo: true,
				blocked: true,
				blockReason: "sudoedit (-e/--edit) is not supported in Havk Local mode.",
				invocations,
			};
		}

		if (inv.isInteractiveShell) {
			return {
				hasSudo: true,
				blocked: true,
				blockReason: "Persistent interactive root shell (-i/-s) is not supported in Havk Local mode.",
				invocations,
			};
		}

		for (const opt of inv.reservedOptions) {
			if (opt === "-S" || opt === "--stdin") {
				return {
					hasSudo: true,
					blocked: true,
					blockReason:
						"Agent-authored sudo stdin option (-S/--stdin) is blocked; Havk manages authentication routing.",
					invocations,
				};
			}
			if (opt === "-A" || opt === "--askpass") {
				return {
					hasSudo: true,
					blocked: true,
					blockReason:
						"Agent-authored sudo askpass option (-A/--askpass) is blocked; Havk manages authentication routing.",
					invocations,
				};
			}
			if (opt === "-k" || opt === "-K") {
				return {
					hasSudo: true,
					blocked: true,
					blockReason: "Agent-authored sudo timestamp reset (-k/-K) is blocked in Havk Local mode.",
					invocations,
				};
			}
			if (opt === "-v") {
				return {
					hasSudo: true,
					blocked: true,
					blockReason: "Agent-authored standalone sudo validate (-v) is blocked in Havk Local mode.",
					invocations,
				};
			}
			if (opt === "-b" || opt === "--background") {
				return {
					hasSudo: true,
					blocked: true,
					blockReason: "Agent-authored background sudo (-b/--background) is blocked in Havk Local mode.",
					invocations,
				};
			}
		}
	}

	return {
		hasSudo: true,
		blocked: false,
		invocations,
	};
}
