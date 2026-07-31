import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TokenUsage } from "./domain.ts";
import { GoalActivitySource, type GoalPulseScheduler } from "./goals.ts";
import { renderFooter, type ThemeLike } from "./layout.ts";
import {
	createPostFooterSlotHost,
	POST_FOOTER_SLOT_READY_EVENT,
	POST_FOOTER_SLOT_REQUEST_EVENT,
	type PostFooterSlotHost,
} from "./post-footer.ts";
import { sessionTokens } from "./tokens.ts";

export {
	POST_FOOTER_SLOT_READY_EVENT,
	POST_FOOTER_SLOT_REQUEST_EVENT,
} from "./post-footer.ts";
export type {
	PostFooterSlot,
	PostFooterSlotHandle,
	PostFooterSlotReadyPayload,
} from "./post-footer.ts";

interface FooterDataLike {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export interface FooterRuntimeDependencies {
	scheduleMount(handler: () => void): () => void;
	schedulePulse: GoalPulseScheduler;
}

export const FOOTER_MOUNTED_EVENT = "pi-footer:mounted";
export const FOOTER_STATUS_SOURCE_REQUEST_EVENT = "pi-footer:status-source:v1:request";
export const FOOTER_STATUS_SOURCE_READY_EVENT = "pi-footer:status-source:v1:ready";
export const FOOTER_ROWS = 2;

export interface FooterStatusEntry {
	key: string;
	text: string;
}

export interface FooterStatusSourceReadyPayload {
	version: 1;
	sessionId: string;
	token: string;
	readStatuses(): readonly FooterStatusEntry[];
}

interface ActiveStatusSource {
	payload: FooterStatusSourceReadyPayload;
	deactivate(): void;
}

const MAX_STATUS_ENTRIES = 64;
const MAX_STATUS_KEY_LENGTH = 128;
const MAX_STATUS_TEXT_LENGTH = 2_048;

function defaultDependencies(): FooterRuntimeDependencies {
	return {
		scheduleMount(handler) {
			const immediate = setImmediate(handler);
			return () => clearImmediate(immediate);
		},
		schedulePulse(handler) {
			const timer = setInterval(handler, 500);
			timer.unref?.();
			return () => clearInterval(timer);
		},
	};
}

interface SessionRuntime {
	generation: number;
	ctx: ExtensionContext;
	sessionManager: ExtensionContext["sessionManager"];
	modelId?: string;
	mainTokens: TokenUsage;
}

function displayCwd(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const insideHome =
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	return insideHome ? (rel ? `~${sep}${rel}` : "~") : cwd;
}

function thinkingLevel(pi: ExtensionAPI): string {
	try {
		return pi.getThinkingLevel();
	} catch {
		return "off";
	}
}

function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function copyStatuses(footerData: FooterDataLike): readonly FooterStatusEntry[] {
	try {
		const entries: FooterStatusEntry[] = [];
		for (const [key, text] of footerData.getExtensionStatuses()) {
			if (typeof key !== "string" || typeof text !== "string") continue;
			entries.push({
				key: key.slice(0, MAX_STATUS_KEY_LENGTH),
				text: text.slice(0, MAX_STATUS_TEXT_LENGTH),
			});
			if (entries.length >= MAX_STATUS_ENTRIES) break;
		}
		return entries;
	} catch {
		return [];
	}
}

/** One extension instance owns one session-scoped footer component. */
export class FooterController {
	private readonly dependencies: FooterRuntimeDependencies;
	private session: SessionRuntime | undefined;
	private cancelPendingMount: (() => void) | undefined;
	private requestRender: (() => void) | undefined;
	private statusSource: ActiveStatusSource | undefined;
	private postFooterSource: PostFooterSlotHost | undefined;
	private readonly goalActivity: GoalActivitySource;
	private nextGeneration = 0;
	private registered = false;

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<FooterRuntimeDependencies> = {},
	) {
		this.dependencies = { ...defaultDependencies(), ...dependencies };
		this.goalActivity = new GoalActivitySource(
			pi,
			() => this.repaint(),
			this.dependencies.schedulePulse,
		);
	}

	register(): void {
		if (this.registered) return;
		this.registered = true;
		this.pi.on("session_start", (event, ctx) => {
			const deferMount = event.reason === "reload";
			const runtime = this.start(ctx, deferMount);
			if (deferMount) this.deferMount(runtime);
		});
		this.pi.on("session_shutdown", () => this.stop());
		this.pi.on("model_select", (event, ctx) => {
			const current = this.currentSessionFor(ctx);
			if (!current) return;
			current.modelId = event.model.id;
			this.repaint();
		});
		this.pi.on("thinking_level_select", (_event, ctx) => this.repaintFor(ctx));
		this.pi.on("turn_end", (_event, ctx) => this.updateMainTokens(ctx));
		this.pi.on("message_end", (_event, ctx) => this.updateMainTokens(ctx));
		this.pi.events.on(FOOTER_STATUS_SOURCE_REQUEST_EVENT, (payload) => {
			try {
				const request = payload as { version?: unknown; sessionId?: unknown } | undefined;
				const source = this.statusSource;
				if (request?.version !== 1 || !source) return;
				if (request.sessionId !== source.payload.sessionId) return;
				this.pi.events.emit(FOOTER_STATUS_SOURCE_READY_EVENT, source.payload);
			} catch {
				// Cross-extension payloads are untrusted; malformed requests are ignored.
			}
		});
		this.pi.events.on(POST_FOOTER_SLOT_REQUEST_EVENT, (payload) => {
			try {
				const request = payload as { version?: unknown; sessionId?: unknown } | undefined;
				const source = this.postFooterSource;
				if (request?.version !== 1 || !source) return;
				if (request.sessionId !== source.payload.sessionId) return;
				this.pi.events.emit(POST_FOOTER_SLOT_READY_EVENT, source.payload);
			} catch {
				// Cross-extension payloads are untrusted; malformed requests are ignored.
			}
		});
	}

	start(ctx: ExtensionContext, deferMount = false): SessionRuntime {
		this.resetSession();
		const runtime: SessionRuntime = {
			generation: ++this.nextGeneration,
			ctx,
			sessionManager: ctx.sessionManager,
			modelId: ctx.model?.id,
			mainTokens: sessionTokens(ctx),
		};
		this.session = runtime;
		this.goalActivity.start(sessionId(ctx));
		if (!deferMount) this.mount(runtime);
		return runtime;
	}

	private deferMount(runtime: SessionRuntime): void {
		if (!this.isCurrent(runtime.generation)) return;
		this.cancelPendingMount?.();
		this.cancelPendingMount = this.dependencies.scheduleMount(() => {
			this.cancelPendingMount = undefined;
			this.mount(runtime);
		});
	}

	private mount(runtime: SessionRuntime): void {
		if (!this.isCurrent(runtime.generation)) return;
		runtime.ctx.ui.setFooter((tui, theme, footerData) =>
			this.createFooter(
				runtime.generation,
				tui,
				theme as ThemeLike,
				footerData as FooterDataLike,
			),
		);
		this.pi.events.emit(FOOTER_MOUNTED_EVENT, { rows: FOOTER_ROWS });
		this.repaint();
	}

	stop(): void {
		this.resetSession();
	}

	private resetSession(): void {
		++this.nextGeneration;
		this.goalActivity.stop();
		this.cancelPendingMount?.();
		this.cancelPendingMount = undefined;
		this.clearStatusSource();
		this.clearPostFooterSource();
		this.requestRender = undefined;
		this.session = undefined;
	}

	private clearStatusSource(): void {
		this.statusSource?.deactivate();
		this.statusSource = undefined;
	}

	private clearPostFooterSource(): void {
		this.postFooterSource?.deactivate();
		this.postFooterSource = undefined;
	}

	private createFooter(
		generation: number,
		tui: TUI,
		theme: ThemeLike,
		footerData: FooterDataLike,
	): Component & { dispose(): void } {
		const callback = () => tui.requestRender();
		const current = this.session;
		let currentSessionId: string | undefined;
		if (current?.generation === generation) currentSessionId = sessionId(current.ctx);
		let active = currentSessionId !== undefined;
		const token = randomUUID();
		let payload: FooterStatusSourceReadyPayload | undefined;
		if (currentSessionId) {
			payload = Object.freeze({
				version: 1 as const,
				sessionId: currentSessionId,
				token,
				readStatuses: () => {
					if (!active || !this.isCurrent(generation)) return [];
					return copyStatuses(footerData);
				},
			});
		}
		if (payload) {
			this.clearStatusSource();
			this.statusSource = { payload, deactivate: () => { active = false; } };
			this.pi.events.emit(FOOTER_STATUS_SOURCE_READY_EVENT, payload);
		}
		let postFooter: PostFooterSlotHost | undefined;
		if (currentSessionId) {
			postFooter = createPostFooterSlotHost({
				sessionId: currentSessionId,
				isCurrent: () => active && this.isCurrent(generation),
				requestRender: callback,
			});
			this.clearPostFooterSource();
			this.postFooterSource = postFooter;
			this.pi.events.emit(POST_FOOTER_SLOT_READY_EVENT, postFooter.payload);
		}
		if (this.isCurrent(generation)) this.requestRender = callback;
		return {
			render: (width: number) => {
				const runtime = this.session;
				if (!runtime || runtime.generation !== generation) return [];
				const statuses = new Map(footerData.getExtensionStatuses());
				const goalStatus = this.goalActivity.text(Date.now());
				if (goalStatus) statuses.set("@neumie/pi-subagents-goal", goalStatus);
				const footer = renderFooter(
					{
						cwd: displayCwd(runtime.ctx.cwd),
						trusted: runtime.ctx.isProjectTrusted(),
						modelId: runtime.modelId ?? runtime.ctx.model?.id ?? "no-model",
						thinkingLevel: thinkingLevel(this.pi),
						inputTokens: runtime.mainTokens.input,
						outputTokens: runtime.mainTokens.output,
						contextUsage: runtime.ctx.getContextUsage(),
						statuses,
					},
					theme,
					width,
				);
				return [...footer, ...(postFooter?.render(width) ?? [])];
			},
			invalidate() {},
			dispose: () => {
				active = false;
				postFooter?.deactivate();
				if (this.postFooterSource === postFooter) this.postFooterSource = undefined;
				if (this.statusSource?.payload.token === token) this.statusSource = undefined;
				if (this.requestRender === callback) this.requestRender = undefined;
			},
		};
	}

	private updateMainTokens(ctx: ExtensionContext): void {
		const current = this.currentSessionFor(ctx);
		if (!current) return;
		current.mainTokens = sessionTokens(ctx);
		this.repaint();
	}

	private repaintFor(ctx: ExtensionContext): void {
		if (this.currentSessionFor(ctx)) this.repaint();
	}

	private repaint(): void {
		this.requestRender?.();
	}

	private currentSessionFor(ctx: ExtensionContext): SessionRuntime | undefined {
		const current = this.session;
		return current?.sessionManager === ctx.sessionManager ? current : undefined;
	}

	private isCurrent(generation: number): boolean {
		return this.session?.generation === generation;
	}
}
