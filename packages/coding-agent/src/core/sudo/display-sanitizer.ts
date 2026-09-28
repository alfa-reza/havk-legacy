/**
 * Havk Approval Display Sanitizer.
 *
 * Sanitizes untrusted shell command strings before rendering in the approval UI.
 * Neutralizes terminal control escapes, C0 control characters, carriage return / backspace
 * spoofing, and Unicode bidirectional formatting characters without altering the underlying
 * execution source.
 */

// Match ANSI CSI, OSC, APC, DCS, PM sequences
const ANSI_PATTERN =
	/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\^[^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Unicode Bidi_Control characters (TR9)
const BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

// Invisible formatting characters
const INVISIBLE_PATTERN = /[\u200B-\u200D\uFEFF]/g;

/**
 * Format a Unicode code point visibly, e.g. [U+202E]
 */
function formatCodePoint(codePoint: number): string {
	return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
}

/**
 * Sanitize shell command source for safe terminal display in the approval UI.
 */
export function sanitizeApprovalDisplay(commandText: string): string {
	// 1. Strip ANSI escape sequences
	let text = commandText.replace(ANSI_PATTERN, "");

	// 2. Visibly escape Unicode Bidi_Control characters
	text = text.replace(BIDI_CONTROL_PATTERN, (match) => {
		const cp = match.codePointAt(0);
		return cp !== undefined ? formatCodePoint(cp) : "";
	});

	// 3. Strip invisible format characters
	text = text.replace(INVISIBLE_PATTERN, "");

	// 4. Handle C0 control characters, carriage return, and backspace
	let result = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const code = ch.charCodeAt(0);

		if (ch === "\r") {
			result += "\\r";
		} else if (ch === "\b") {
			result += "\\b";
		} else if (ch === "\t" || ch === "\n") {
			result += ch;
		} else if (code < 0x20 || code === 0x7f) {
			result += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			result += ch;
		}
	}

	return result;
}
