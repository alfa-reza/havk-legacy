import {
	type Component,
	decodePrintableKey,
	type Focusable,
	getKeybindings,
	isKeyRelease,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Mutable byte storage for sensitive password input.
 * Automatically zeroes old buffers on reallocation and zeroes all bytes on completion.
 *
 * NOTE ON SIDE CHANNEL (PRD §8.3):
 * One-mask-character-per-character intentionally reveals password length to a local observer.
 * This is an accepted V1 visual side channel as specified in PRD §8.3.
 */
export class SecurePasswordBuffer {
	private buffer: Buffer;
	private length: number;

	constructor(initialCapacity = 256) {
		this.buffer = Buffer.alloc(initialCapacity);
		this.length = 0;
	}

	get charCount(): number {
		let count = 0;
		for (let i = 0; i < this.length; i++) {
			if ((this.buffer[i]! & 0xc0) !== 0x80) {
				count++;
			}
		}
		return count;
	}

	get byteLength(): number {
		return this.length;
	}

	append(text: string): void {
		const added = Buffer.from(text, "utf-8");
		if (this.length + added.length > this.buffer.length) {
			const newCapacity = Math.max(this.buffer.length * 2, this.length + added.length + 64);
			const newBuffer = Buffer.alloc(newCapacity);
			this.buffer.copy(newBuffer, 0, 0, this.length);
			this.buffer.fill(0);
			this.buffer = newBuffer;
		}
		added.copy(this.buffer, this.length);
		this.length += added.length;
		added.fill(0);
	}

	backspace(): void {
		if (this.length <= 0) return;
		let i = this.length - 1;
		while (i > 0 && (this.buffer[i]! & 0xc0) === 0x80) {
			i--;
		}
		for (let j = i; j < this.length; j++) {
			this.buffer[j] = 0;
		}
		this.length = i;
	}

	clear(): void {
		this.buffer.fill(0);
		this.length = 0;
	}

	getMask(): string {
		return "*".repeat(this.charCount);
	}

	/**
	 * Returns a copy of the password bytes.
	 * The caller is responsible for calling .fill(0) on the returned buffer when finished.
	 */
	extractSecret(): Buffer {
		const copy = Buffer.alloc(this.length);
		this.buffer.copy(copy, 0, 0, this.length);
		return copy;
	}
}

export interface PasswordPromptOptions {
	tui: TUI;
	onSubmit: (password: Buffer) => void;
	onCancel: () => void;
	signal?: AbortSignal;
	isRetry?: boolean;
}

/**
 * Interactive password prompt component implementing PRD §8.3.
 *
 * Displays masked feedback ('*') and captures input using TUI's isolated secure input path.
 * Plaintext password characters are never rendered or stored in strings.
 */
export class PasswordPromptComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly options: PasswordPromptOptions;
	private readonly secretBuffer: SecurePasswordBuffer;
	private disposed: boolean;
	private isInPaste: boolean;
	private pasteBuffer: string;
	private abortListener?: () => void;
	focused: boolean;

	constructor(options: PasswordPromptOptions) {
		this.tui = options.tui;
		this.options = options;
		this.secretBuffer = new SecurePasswordBuffer();
		this.disposed = false;
		this.isInPaste = false;
		this.pasteBuffer = "";
		this.focused = true;

		// Intercept raw terminal input via S4 secure input isolation
		this.tui.setSecureInput((data) => this.handleRawInput(data));

		if (options.signal) {
			if (options.signal.aborted) {
				this.cancel();
			} else {
				this.abortListener = () => this.cancel();
				options.signal.addEventListener("abort", this.abortListener, { once: true });
			}
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const title = this.options.isRetry
			? theme.fg("error", theme.bold("Sudo authentication failed. Please try again:"))
			: theme.fg("warning", theme.bold("Sudo authentication required"));
		const label = "Sudo password:";
		const mask = this.secretBuffer.getMask();
		const hint = theme.fg("muted", "Press Esc to cancel");

		return [border, ` ${title}`, "", ` ${label}`, ` ${mask}`, "", ` ${hint}`, border];
	}

	handleRawInput(data: string): void {
		if (this.disposed) return;

		// Handle bracketed paste mode (\x1b[200~ ... \x1b[201~)
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				const clean = pasteContent.replace(/[\r\n\t]/g, "");
				this.secretBuffer.append(clean);
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				this.tui.requestRender();
				if (remaining) {
					this.handleRawInput(remaining);
				}
			}
			return;
		}

		if (isKeyRelease(data)) {
			return;
		}

		const kb = getKeybindings();

		// Cancel on Escape or Ctrl+C
		if (data === "\x1b" || data === "\x03" || kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// Submit on Enter
		if (data === "\r" || data === "\n" || kb.matches(data, "tui.input.submit")) {
			this.submit();
			return;
		}

		// Backspace
		if (data === "\x7f" || data === "\x08" || kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.secretBuffer.backspace();
			this.tui.requestRender();
			return;
		}

		// Clear password on Ctrl+U (delete to start)
		if (data === "\x15" || kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.secretBuffer.clear();
			this.tui.requestRender();
			return;
		}

		// Printable Kitty key sequence
		const printableKitty = decodePrintableKey(data);
		if (printableKitty !== undefined) {
			this.secretBuffer.append(printableKitty);
			this.tui.requestRender();
			return;
		}

		// Regular printable characters (reject C0/C1 control codes and DEL)
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars && data.length > 0) {
			this.secretBuffer.append(data);
			this.tui.requestRender();
		}
	}

	submit(): void {
		if (this.disposed) return;
		const secret = this.secretBuffer.extractSecret();
		this.dispose();
		this.options.onSubmit(secret);
	}

	cancel(): void {
		if (this.disposed) return;
		this.dispose();
		this.secretBuffer.clear();
		this.options.onCancel();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.tui.setSecureInput(null);
		if (this.abortListener && this.options.signal) {
			this.options.signal.removeEventListener("abort", this.abortListener);
			this.abortListener = undefined;
		}
		this.secretBuffer.clear();
	}
}
