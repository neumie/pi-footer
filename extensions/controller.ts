import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TokenUsage } from "./domain.ts";
import { renderFooter, type ThemeLike } from "./layout.ts";
import { sessionTokens } from "./tokens.ts";

interface FooterDataLike {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export interface FooterRuntimeDependencies {
	scheduleMount(handler: () => void): () => void;
}

export const FOOTER_MOUNTED_EVENT = "pi-footer:mounted";
export const FOOTER_ROWS = 2;

function defaultDependencies(): FooterRuntimeDependencies {
	return {
		scheduleMount(handler) {
			const immediate = setImmediate(handler);
			return () => clearImmediate(immediate);
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

/** One extension instance owns one session-scoped footer component. */
export class FooterController {
	private readonly dependencies: FooterRuntimeDependencies;
	private session: SessionRuntime | undefined;
	private cancelPendingMount: (() => void) | undefined;
	private requestRender: (() => void) | undefined;
	private nextGeneration = 0;
	private registered = false;

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<FooterRuntimeDependencies> = {},
	) {
		this.dependencies = { ...defaultDependencies(), ...dependencies };
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
		this.cancelPendingMount?.();
		this.cancelPendingMount = undefined;
		this.requestRender = undefined;
		this.session = undefined;
	}

	private createFooter(
		generation: number,
		tui: TUI,
		theme: ThemeLike,
		footerData: FooterDataLike,
	): Component & { dispose(): void } {
		const callback = () => tui.requestRender();
		if (this.isCurrent(generation)) this.requestRender = callback;
		return {
			render: (width: number) => {
				const current = this.session;
				if (!current || current.generation !== generation) return [];
				return renderFooter(
					{
						cwd: displayCwd(current.ctx.cwd),
						trusted: current.ctx.isProjectTrusted(),
						modelId: current.modelId ?? current.ctx.model?.id ?? "no-model",
						thinkingLevel: thinkingLevel(this.pi),
						inputTokens: current.mainTokens.input,
						outputTokens: current.mainTokens.output,
						contextUsage: current.ctx.getContextUsage(),
						statuses: footerData.getExtensionStatuses(),
					},
					theme,
					width,
				);
			},
			invalidate() {},
			dispose: () => {
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
