import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const RESET = "\x1b[0m";

/**
 * The Havk wordmark: 4 cells wide and 2 lines tall.
 *
 *   HAVK
 *   ━━━━
 *
 * The brand colors follow the terminal's color mode.
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	const top = `${fg(CORAL)}HAVK${RESET}`;
	const bottom = `${fg(BLUE)}━━━━${RESET}`;
	return [top, bottom];
}
