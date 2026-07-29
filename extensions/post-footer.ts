import { randomUUID } from "node:crypto";
import { sanitizeTerminalLine } from "./domain.ts";

export const POST_FOOTER_SLOT_REQUEST_EVENT =
	"pi-footer:post-footer:v1:request";
export const POST_FOOTER_SLOT_READY_EVENT = "pi-footer:post-footer:v1:ready";

const MAX_SLOTS = 4;
const MAX_SLOT_ID_LENGTH = 128;
const MAX_SLOT_TOKEN_LENGTH = 128;
const MAX_SLOT_ROWS = 16;
const MAX_TOTAL_ROWS = 16;

export interface PostFooterSlot {
	id: string;
	token: string;
	order: number;
	maxRows: number;
	render(width: number): readonly string[];
}

export interface PostFooterSlotHandle {
	isActive(): boolean;
	dispose(): void;
}

export interface PostFooterSlotReadyPayload {
	version: 1;
	sessionId: string;
	token: string;
	register(slot: PostFooterSlot): PostFooterSlotHandle | undefined;
}

interface SlotRegistration {
	slot: PostFooterSlot;
	active: boolean;
	handle: PostFooterSlotHandle;
}

export interface PostFooterSlotHost {
	payload: PostFooterSlotReadyPayload;
	render(width: number): string[];
	deactivate(): void;
}

interface PostFooterSlotHostOptions {
	sessionId: string;
	isCurrent(): boolean;
	requestRender(): void;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maximum
		? value
		: undefined;
}

function parseSlot(value: unknown): PostFooterSlot | undefined {
	try {
		const source = object(value);
		if (!source) return undefined;
		const id = boundedText(source.id, MAX_SLOT_ID_LENGTH);
		const token = boundedText(source.token, MAX_SLOT_TOKEN_LENGTH);
		if (!id || !token) return undefined;
		if (typeof source.order !== "number" || !Number.isFinite(source.order))
			return undefined;
		if (
			typeof source.maxRows !== "number" ||
			!Number.isInteger(source.maxRows) ||
			source.maxRows < 1 ||
			source.maxRows > MAX_SLOT_ROWS
		) return undefined;
		if (typeof source.render !== "function") return undefined;
		const render = source.render;
		return Object.freeze({
			id,
			token,
			order: Math.trunc(source.order),
			maxRows: source.maxRows,
			render: (width: number) => render.call(source, width),
		});
	} catch {
		return undefined;
	}
}

function safeWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

/** Owns bounded trailing rows for one mounted footer generation. */
class ActivePostFooterSlotHost implements PostFooterSlotHost {
	readonly payload: PostFooterSlotReadyPayload;
	private readonly registrations = new Map<string, SlotRegistration>();
	private active = true;

	constructor(private readonly options: PostFooterSlotHostOptions) {
		this.payload = Object.freeze({
			version: 1 as const,
			sessionId: options.sessionId,
			token: randomUUID(),
			register: (slot: PostFooterSlot) => this.register(slot),
		});
	}

	private isActive(): boolean {
		return this.active && this.options.isCurrent();
	}

	private register(value: PostFooterSlot): PostFooterSlotHandle | undefined {
		if (!this.isActive()) return undefined;
		const slot = parseSlot(value);
		if (!slot) return undefined;
		const previous = this.registrations.get(slot.id);
		if (!previous && this.registrations.size >= MAX_SLOTS) return undefined;
		if (previous?.slot.token === slot.token) return previous.handle;
		if (previous) previous.active = false;
		let registration: SlotRegistration | undefined;
		const handle: PostFooterSlotHandle = Object.freeze({
			isActive: () =>
				this.isActive() &&
				registration?.active === true &&
				this.registrations.get(slot.id) === registration,
			dispose: () => {
				if (!registration?.active) return;
				registration.active = false;
				if (this.registrations.get(slot.id) !== registration) return;
				this.registrations.delete(slot.id);
				this.options.requestRender();
			},
		});
		registration = { slot, active: true, handle };
		this.registrations.set(slot.id, registration);
		this.options.requestRender();
		return handle;
	}

	private renderRegistration(
		registration: SlotRegistration,
		width: number,
		available: number,
	): string[] {
		try {
			const rendered = registration.slot.render(width);
			if (!Array.isArray(rendered)) return [];
			const lines: string[] = [];
			for (const line of rendered.slice(0, available)) {
				if (typeof line === "string")
					lines.push(sanitizeTerminalLine(line, width));
			}
			return lines;
		} catch {
			return [];
		}
	}

	render(width: number): string[] {
		if (!this.isActive()) return [];
		const fittedWidth = safeWidth(width);
		if (fittedWidth === 0) return [];
		const lines: string[] = [];
		const ordered = [...this.registrations.values()].sort(
			(left, right) =>
				left.slot.order - right.slot.order ||
				left.slot.id.localeCompare(right.slot.id),
		);
		for (const registration of ordered) {
			if (!registration.active || lines.length >= MAX_TOTAL_ROWS) continue;
			const available = Math.min(
				registration.slot.maxRows,
				MAX_TOTAL_ROWS - lines.length,
			);
			lines.push(
				...this.renderRegistration(registration, fittedWidth, available),
			);
		}
		return lines;
	}

	deactivate(): void {
		if (!this.active) return;
		this.active = false;
		for (const registration of this.registrations.values())
			registration.active = false;
		this.registrations.clear();
	}
}

export function createPostFooterSlotHost(
	options: PostFooterSlotHostOptions,
): PostFooterSlotHost {
	return new ActivePostFooterSlotHost(options);
}
