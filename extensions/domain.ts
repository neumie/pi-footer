import { truncateToWidth } from "@earendil-works/pi-tui";

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

const MAX_SOURCE_CHARS = 4_096;
const ESC = "\x1b";
const BEL = "\x07";
const C1_ST = "\x9c";
const STRING_CONTROL_INTRODUCERS = new Set(["]", "P", "_", "^", "X"]);
const C1_STRING_CONTROL_CODES = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const SAFE_SGR = /^\x1b\[[0-9:;]*m$/;

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

function skipStringControl(input: string, start: number): number {
	for (let index = start; index < input.length; index += 1) {
		if (input[index] === BEL || input[index] === C1_ST) return index + 1;
		if (input[index] === ESC && input[index + 1] === "\\") return index + 2;
	}
	return input.length;
}

function skipCsi(input: string, start: number): { end: number; sequence: string } {
	for (let index = start; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) {
			return { end: index + 1, sequence: input.slice(start - 2, index + 1) };
		}
	}
	return { end: input.length, sequence: "" };
}

export function parseTokenUsage(value: unknown): TokenUsage | undefined {
	const raw = object(value);
	if (!raw) return undefined;
	const input = count(raw.input) ?? 0;
	const output = count(raw.output) ?? 0;
	const total = count(raw.total) ?? input + output;
	return { input, output, total };
}

export function formatTokens(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

export function formatModel(id: string): string {
	const model =
		sanitizeDisplayText(id, 160)
			.split("/")
			.at(-1)
			?.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "") ?? id;
	const tier = model.match(/^gpt-5\.6-(sol|terra|luna)$/i)?.[1];
	if (tier)
		return `GPT-5.6 ${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`;
	return model.replace(/^claude-/, "");
}

function sanitizeTerminalText(
	value: string,
	maxWidth: number,
	options: { preserveSgr: boolean; preserveWhitespace?: boolean },
): string {
	const input = value.slice(0, MAX_SOURCE_CHARS);
	let output = "";
	for (let index = 0; index < input.length;) {
		const character = input[index]!;
		const code = input.charCodeAt(index);
		if (character === ESC) {
			const next = input[index + 1];
			if (next === "[") {
				const csi = skipCsi(input, index + 2);
				if (options.preserveSgr && SAFE_SGR.test(csi.sequence)) output += csi.sequence;
				index = csi.end;
				continue;
			}
			if (next && STRING_CONTROL_INTRODUCERS.has(next)) {
				index = skipStringControl(input, index + 2);
				continue;
			}
			index += next === undefined ? 1 : 2;
			continue;
		}
		if (code === 0x9b) {
			index = skipCsi(input, index + 1).end;
			continue;
		}
		if (C1_STRING_CONTROL_CODES.has(code)) {
			index = skipStringControl(input, index + 1);
			continue;
		}
		if (character === "\r" || character === "\n" || character === "\t") {
			output += " ";
			index += 1;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			index += 1;
			continue;
		}
		output += character;
		index += 1;
	}
	if (options.preserveWhitespace) return truncateToWidth(output, maxWidth, "…");
	const clean = output.replace(/\s+/g, " ").trim();
	return clean ? truncateToWidth(clean, maxWidth, "…") : "";
}

/** Sanitize unstyled values such as paths, model IDs, and labels. */
export function sanitizeDisplayText(value: string, maxWidth: number): string {
	return sanitizeTerminalText(value, maxWidth, { preserveSgr: false });
}

/** Preserve ordinary text and complete SGR styling, never terminal controls. */
export function sanitizeStatusText(value: string, maxWidth: number): string {
	return sanitizeTerminalText(value, maxWidth, { preserveSgr: true });
}

/** Preserve line spacing and complete SGR styling, never terminal controls. */
export function sanitizeTerminalLine(value: string, maxWidth: number): string {
	return sanitizeTerminalText(value, maxWidth, {
		preserveSgr: true,
		preserveWhitespace: true,
	});
}
