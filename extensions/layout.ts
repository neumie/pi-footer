import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatModel,
	formatTokens,
	sanitizeDisplayText,
	sanitizeStatusText,
} from "./domain.ts";

export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface FooterViewModel {
	cwd: string;
	trusted: boolean;
	modelId: string;
	thinkingLevel: string;
	inputTokens: number;
	outputTokens: number;
	contextUsage?: { contextWindow: number; percent: number | null };
	statuses: ReadonlyMap<string, string>;
}

function effortColor(level: string): string {
	if (level === "off") return "dim";
	if (level === "minimal" || level === "low") return "muted";
	if (level === "medium") return "accent";
	if (level === "high" || level === "xhigh") return "warning";
	if (level === "max") return "error";
	return "text";
}

function alignSides(
	left: string,
	right: string,
	width: number,
	ellipsis: string,
): string {
	const leftFitted = truncateToWidth(left, width, ellipsis);
	if (!right) return leftFitted;
	const rightBudget = width - visibleWidth(leftFitted) - 2;
	if (rightBudget <= 0) return leftFitted;
	const rightFitted = truncateToWidth(right, rightBudget, ellipsis);
	const padding = " ".repeat(
		Math.max(2, width - visibleWidth(leftFitted) - visibleWidth(rightFitted)),
	);
	return truncateToWidth(
		`${leftFitted}${padding}${rightFitted}`,
		width,
		ellipsis,
	);
}

function truncateLeft(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const graphemes = [...text];
	while (graphemes.length && visibleWidth(`…${graphemes.join("")}`) > maxWidth)
		graphemes.shift();
	return `…${graphemes.join("")}`;
}

/** Unicode-safe path fitting which retains the leaf where possible. */
export function truncatePath(path: string, maxWidth: number): string {
	if (maxWidth <= 0 || !path) return "";
	if (visibleWidth(path) <= maxWidth) return path;
	const parts = path.split(/[/\\]/);
	if (parts.length <= 2) return truncateLeft(path, maxWidth);
	const separator = path.includes("\\") ? "\\" : "/";
	const head = parts[0];
	const base = `${head}${separator}…${separator}${parts.at(-1)}`;
	if (visibleWidth(base) > maxWidth) return truncateLeft(path, maxWidth);
	let best = base;
	for (let index = parts.length - 2; index >= 1; index -= 1) {
		const candidate = `${head}${separator}…${separator}${parts.slice(index).join(separator)}`;
		if (visibleWidth(candidate) <= maxWidth) best = candidate;
		else break;
	}
	return best;
}

function context(
	theme: ThemeLike,
	usage: FooterViewModel["contextUsage"],
): string {
	if (!usage) return theme.fg("muted", "—");
	const window = formatTokens(usage.contextWindow);
	if (usage.percent === null) return theme.fg("muted", `?/${window}`);
	const color =
		usage.percent > 90 ? "error" : usage.percent > 70 ? "warning" : "text";
	return (
		theme.fg(color, `${usage.percent.toFixed(0)}%`) +
		theme.fg("dim", `/${window}`)
	);
}

function isSidebarOwnedStatus(key: string): boolean {
	return key === "background-jobs" || key.startsWith("subagent-");
}

/** Pure two-row footer renderer. */
export function renderFooter(
	view: FooterViewModel,
	theme: ThemeLike,
	width: number,
): string[] {
	const divider = theme.fg("dim", " · ");
	const ellipsis = theme.fg("dim", "…");
	const trust = `${divider}${theme.fg(view.trusted ? "success" : "warning", view.trusted ? "trusted" : "untrusted")}`;
	const cwd = theme.fg(
		"muted",
		truncatePath(
			sanitizeDisplayText(view.cwd, 4_096),
			width - visibleWidth(trust),
		),
	);
	const row1 = alignSides(`${cwd}${trust}`, "", width, ellipsis);

	const model = theme.fg("accent", theme.bold(formatModel(view.modelId)));
	const safeThinkingLevel = sanitizeDisplayText(view.thinkingLevel, 20);
	const effort = theme.fg(
		effortColor(safeThinkingLevel),
		safeThinkingLevel,
	);
	const tokenText = theme.fg(
		"text",
		`↑${formatTokens(view.inputTokens)} ↓${formatTokens(view.outputTokens)}`,
	);
	const ctx = context(theme, view.contextUsage);
	const statuses = [...view.statuses.entries()]
		.filter(([key]) => !isSidebarOwnedStatus(key))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, value]) => sanitizeStatusText(value, 120))
		.filter(Boolean);
	const row2 = alignSides(
		[model, effort, ctx, tokenText].join(divider),
		theme.fg("dim", statuses.join(" · ")),
		width,
		ellipsis,
	);
	return [row1, row2];
}
