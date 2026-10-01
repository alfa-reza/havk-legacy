import {
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { sanitizeApprovalDisplay } from "../../../core/sudo/display-sanitizer.ts";
import type { SudoApprovalChoice } from "../../../core/sudo/types.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface SudoApprovalDialogOptions {
	tui: TUI;
	commandText: string;
	onSelect: (choice: SudoApprovalChoice) => void;
	signal?: AbortSignal;
}

/**
 * Interactive approval dialog for mediated explicit sudo requests.
 * Implements PRD §8.1 with complete sanitized effective command display.
 */
export class SudoApprovalDialogComponent extends Container implements Focusable {
	private readonly selectList: SelectList;
	private readonly onSelectCallback: (choice: SudoApprovalChoice) => void;
	private readonly signal?: AbortSignal;
	private abortListener?: () => void;
	private disposed = false;
	focused = true;

	constructor(options: SudoApprovalDialogOptions) {
		super();
		this.onSelectCallback = options.onSelect;
		this.signal = options.signal;

		const sanitizedCmd = sanitizeApprovalDisplay(options.commandText);

		// Top border
		this.addChild(new DynamicBorder());

		// Title per PRD §8.1
		this.addChild(new Text(theme.fg("warning", theme.bold("Sudo access requested")), 1, 0));
		this.addChild(new Spacer(1));

		// Sanitized command text
		this.addChild(new Text(theme.fg("accent", sanitizedCmd), 1, 0));
		this.addChild(new Spacer(1));

		// Session warning per PRD §8.1
		this.addChild(
			new Text(
				theme.fg("muted", "Session approval may allow full root access if permitted by your sudo policy."),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Choices per PRD §8.1 (Deny is default selected item)
		const items: SelectItem[] = [
			{ label: "Deny", value: "deny", description: "Block this request and remain in ask mode" },
			{ label: "Allow this sudo command", value: "allow-once", description: "Approve only this command" },
			{
				label: "Allow sudo for this session",
				value: "allow-session",
				description: "Approve for the rest of this session",
			},
		];

		this.selectList = new SelectList(items, items.length, getSelectListTheme());
		this.selectList.onSelect = (item) => {
			this.choose({ decision: item.value as SudoApprovalChoice["decision"] });
		};
		this.selectList.onCancel = () => {
			this.choose({ decision: "deny" });
		};
		this.addChild(this.selectList);

		// Bottom border
		this.addChild(new DynamicBorder());

		if (options.signal) {
			if (options.signal.aborted) {
				this.choose({ decision: "deny" });
			} else {
				this.abortListener = () => this.choose({ decision: "deny" });
				options.signal.addEventListener("abort", this.abortListener, { once: true });
			}
		}
	}

	private choose(choice: SudoApprovalChoice): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.abortListener && this.signal) {
			this.signal.removeEventListener("abort", this.abortListener);
			this.abortListener = undefined;
		}
		this.onSelectCallback(choice);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.choose({ decision: "deny" });
			return;
		}
		this.selectList.handleInput(data);
	}
}
