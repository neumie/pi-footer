import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_STATUS_PROTOCOL_VERSION = 1 as const;
export const GOAL_STATUS_REQUEST_EVENT = "@neumie/pi-subagents-goal:v1:status-request";
export const GOAL_STATUS_EVENT = "@neumie/pi-subagents-goal:v1:status";

const PHASES = new Set([
	"active",
	"paused",
	"cancelling",
	"cancelled",
	"completed",
	"budget_exhausted",
	"faulted",
]);

export interface GoalActivityEnvelope {
	version: 1;
	providerId: string;
	sequence: number;
	sessionId: string;
	goal: { phase: string; live: boolean } | null;
}

export type GoalPulseScheduler = (handler: () => void) => () => void;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function boundedText(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		!/[\r\n\0]/u.test(value)
	);
}

function parseGoalActivityEnvelopeUnsafe(value: unknown): GoalActivityEnvelope | undefined {
	const input = record(value);
	if (
		!input ||
		input.version !== GOAL_STATUS_PROTOCOL_VERSION ||
		!boundedText(input.providerId, 128) ||
		!Number.isSafeInteger(input.sequence) ||
		(input.sequence as number) < 0 ||
		!boundedText(input.sessionId, 1_024)
	)
		return undefined;
	if (input.goal === null) {
		return {
			version: 1,
			providerId: input.providerId,
			sequence: input.sequence as number,
			sessionId: input.sessionId,
			goal: null,
		};
	}
	const goal = record(input.goal);
	if (
		!goal ||
		typeof goal.phase !== "string" ||
		!PHASES.has(goal.phase) ||
		typeof goal.live !== "boolean" ||
		goal.live !== (goal.phase !== "completed" && goal.phase !== "cancelled")
	)
		return undefined;
	return {
		version: 1,
		providerId: input.providerId,
		sequence: input.sequence as number,
		sessionId: input.sessionId,
		goal: { phase: goal.phase, live: goal.live },
	};
}

export function parseGoalActivityEnvelope(value: unknown): GoalActivityEnvelope | undefined {
	try {
		return parseGoalActivityEnvelopeUnsafe(value);
	} catch {
		return undefined;
	}
}

export class GoalActivitySource {
	private readonly unsubscribe: () => void;
	private sessionId: string | undefined;
	private status: GoalActivityEnvelope | undefined;
	private cancelPulse: (() => void) | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly requestRender: () => void,
		private readonly schedulePulse: GoalPulseScheduler,
	) {
		this.unsubscribe = pi.events.on(GOAL_STATUS_EVENT, (payload) => this.update(payload));
	}

	start(sessionId: string | undefined): void {
		this.stopPulse();
		this.status = undefined;
		this.sessionId = sessionId;
		if (sessionId) {
			try {
				this.pi.events.emit(GOAL_STATUS_REQUEST_EVENT, {
					version: GOAL_STATUS_PROTOCOL_VERSION,
					sessionId,
				});
			} catch {
				// An optional provider cannot break footer startup.
			}
		}
		this.requestRender();
	}

	stop(): void {
		this.stopPulse();
		this.status = undefined;
		this.sessionId = undefined;
		this.requestRender();
	}

	dispose(): void {
		this.stop();
		this.unsubscribe();
	}

	text(now: number): string | undefined {
		const goal = this.status?.goal;
		if (!goal?.live) return undefined;
		if (goal.phase === "active") {
			return `${Math.floor(now / 500) % 2 === 0 ? "◆" : "◇"} goal active`;
		}
		return `◇ goal ${goal.phase.replaceAll("_", " ")}`;
	}

	private update(payload: unknown): void {
		const parsed = parseGoalActivityEnvelope(payload);
		if (!parsed || parsed.sessionId !== this.sessionId) return;
		if (
			this.status?.providerId === parsed.providerId &&
			parsed.sequence <= this.status.sequence
		)
			return;
		this.status = parsed;
		if (parsed.goal?.live && parsed.goal.phase === "active") this.startPulse();
		else this.stopPulse();
		this.requestRender();
	}

	private startPulse(): void {
		if (this.cancelPulse) return;
		this.cancelPulse = this.schedulePulse(this.requestRender);
	}

	private stopPulse(): void {
		this.cancelPulse?.();
		this.cancelPulse = undefined;
	}
}
