import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseTokenUsage, type TokenUsage } from "./domain.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function zeroTokens(): TokenUsage {
	return { input: 0, output: 0, total: 0 };
}

function addTokens(target: TokenUsage, usage: TokenUsage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.total = target.input + target.output;
}

/** Count only assistant messages on the active parent-session branch. */
export function sessionTokens(ctx: ExtensionContext): TokenUsage {
	const result = zeroTokens();
	for (const value of ctx.sessionManager.getBranch()) {
		const entry = record(value);
		const message = record(entry?.message);
		if (entry?.type !== "message" || message?.role !== "assistant") continue;
		const usage = parseTokenUsage(message.usage);
		if (usage) addTokens(result, usage);
	}
	return result;
}
