import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	GOAL_PULSE_INTERVAL_MS,
	GOAL_STATUS_EVENT,
	GOAL_STATUS_REQUEST_EVENT,
	GoalActivitySource,
	parseGoalActivityEnvelope,
} from "../extensions/goals.ts";

class EventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}
	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

function envelope(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		providerId: "provider-1",
		sequence: 1,
		sessionId: "session-1",
		goal: { phase: "active", live: true },
		...overrides,
	};
}

describe("goal footer activity", () => {
	it("strictly parses the session-scoped activity subset", () => {
		assert.equal(parseGoalActivityEnvelope(envelope())?.goal?.phase, "active");
		assert.equal(parseGoalActivityEnvelope({ ...envelope(), version: 2 }), undefined);
		assert.equal(
			parseGoalActivityEnvelope({ ...envelope(), goal: { phase: "completed", live: true } }),
			undefined,
		);
		const hostile = new Proxy({}, { get: () => { throw new Error("hostile"); } });
		assert.doesNotThrow(() => parseGoalActivityEnvelope(hostile));
		assert.equal(parseGoalActivityEnvelope(hostile), undefined);
	});

	it("requests state, pulses while active, and clears terminal goals", () => {
		const events = new EventBus();
		const requests: unknown[] = [];
		events.on(GOAL_STATUS_REQUEST_EVENT, (value) => requests.push(value));
		let renders = 0;
		let pulse: (() => void) | undefined;
		let pulseCancels = 0;
		const source = new GoalActivitySource(
			{ events } as unknown as ExtensionAPI,
			() => { renders += 1; },
			(handler) => {
				pulse = handler;
				return () => { pulseCancels += 1; pulse = undefined; };
			},
		);

		source.start("session-1");
		assert.deepEqual(requests, [{ version: 1, sessionId: "session-1" }]);
		events.emit(GOAL_STATUS_EVENT, envelope({ sessionId: "foreign" }));
		assert.equal(source.text(0), undefined);
		events.emit(GOAL_STATUS_EVENT, envelope());
		assert.equal(source.text(0), "◆ goal active");
		assert.equal(source.text(GOAL_PULSE_INTERVAL_MS), "◇ goal active");
		assert.equal(typeof pulse, "function");
		const beforePulse = renders;
		pulse?.();
		assert.equal(renders, beforePulse + 1);

		events.emit(
			GOAL_STATUS_EVENT,
			envelope({ sequence: 2, goal: { phase: "paused", live: true } }),
		);
		assert.equal(source.text(0), "◇ goal paused");
		assert.equal(pulse, undefined);
		assert.equal(pulseCancels, 1);
		events.emit(GOAL_STATUS_EVENT, envelope({ goal: { phase: "active", live: true } }));
		assert.equal(source.text(0), "◇ goal paused");

		events.emit(
			GOAL_STATUS_EVENT,
			envelope({ providerId: "replacement-provider", goal: { phase: "active", live: true } }),
		);
		assert.equal(source.text(0), "◆ goal active");
		events.emit(
			GOAL_STATUS_EVENT,
			envelope({
				providerId: "replacement-provider",
				sequence: 2,
				goal: { phase: "completed", live: false },
			}),
		);
		assert.equal(source.text(0), undefined);
		source.dispose();
	});
});
