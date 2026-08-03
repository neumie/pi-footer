import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	FOOTER_MOUNTED_EVENT,
	FOOTER_ROWS,
	FOOTER_STATUS_SOURCE_READY_EVENT,
	FOOTER_STATUS_SOURCE_REQUEST_EVENT,
	POST_FOOTER_SLOT_READY_EVENT,
	POST_FOOTER_SLOT_REQUEST_EVENT,
	FooterController,
	type FooterRuntimeDependencies,
	type FooterStatusSourceReadyPayload,
} from "../extensions/controller.ts";
import {
	formatModel,
	formatTokens,
	parseTokenUsage,
	sanitizeDisplayText,
	sanitizeStatusText,
} from "../extensions/domain.ts";
import {
	GOAL_STATUS_EVENT,
	GOAL_STATUS_REQUEST_EVENT,
} from "../extensions/goals.ts";
import extension from "../extensions/footer.ts";
import { renderFooter, type ThemeLike } from "../extensions/layout.ts";
import { sessionTokens } from "../extensions/tokens.ts";

type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;
type BusHandler = (payload: unknown) => void;

class FakePi {
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly bus = new Map<string, BusHandler[]>();
	readonly events = {
		on: (name: string, handler: BusHandler) => {
			this.bus.set(name, [...(this.bus.get(name) ?? []), handler]);
			return () =>
				this.bus.set(
					name,
					(this.bus.get(name) ?? []).filter((item) => item !== handler),
				);
		},
		emit: (name: string, payload: unknown) => {
			for (const handler of this.bus.get(name) ?? []) handler(payload);
		},
	};
	on(name: string, handler: LifecycleHandler): void {
		this.lifecycle.set(name, [...(this.lifecycle.get(name) ?? []), handler]);
	}
	getThinkingLevel(): "high" {
		return "high";
	}
	api(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

interface FakeUI {
	footerFactory?: (
		tui: TUI,
		theme: ThemeLike,
		footerData: { getExtensionStatuses(): ReadonlyMap<string, string> },
	) => { render(width: number): string[]; dispose?(): void };
	statusWrites: unknown[];
	widgetWrites: unknown[];
}

function makeContext(
	ui: FakeUI,
	branchEntries: unknown[] = [],
	sessionId = "footer-test-session",
	sessionName?: string,
): ExtensionContext {
	return {
		cwd: "/tmp/project/emoji-🧪",
		model: { id: "gpt-5.6-sol" },
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		sessionManager: {
			getBranch: () => branchEntries,
			getSessionFile: () => sessionId,
			getSessionId: () => sessionId,
			getSessionName: () => sessionName,
		},
		ui: {
			setStatus(...args: unknown[]) {
				ui.statusWrites.push(args);
			},
			setWidget(...args: unknown[]) {
				ui.widgetWrites.push(args);
			},
			setFooter(factory: unknown) {
				ui.footerFactory = factory as FakeUI["footerFactory"];
			},
		},
	} as unknown as ExtensionContext;
}

function theme(): ThemeLike {
	return { fg: (_name, text) => text, bold: (text) => text };
}

function dependencies(
	overrides: Partial<FooterRuntimeDependencies> = {},
): FooterRuntimeDependencies {
	return {
		scheduleMount(handler) {
			const immediate = setImmediate(handler);
			return () => clearImmediate(immediate);
		},
		schedulePulse: () => () => undefined,
		...overrides,
	};
}

function createFooter(
	ui: FakeUI,
	requestRender: () => void,
	statuses = new Map<string, string>(),
) {
	assert.ok(ui.footerFactory);
	return ui.footerFactory!({ requestRender } as unknown as TUI, theme(), {
		getExtensionStatuses: () => statuses,
	});
}

test("domain formats footer values and removes terminal controls", () => {
	assert.deepEqual(parseTokenUsage({ input: 12, output: 8 }), {
		input: 12,
		output: 8,
		total: 20,
	});
	assert.equal(formatTokens(1_234), "1.2k");
	assert.equal(formatModel("anthropic/claude-opus-4-8:high"), "opus-4-8");
	assert.equal(formatModel("openai/gpt-5.6-sol"), "GPT-5.6 Sol");
	assert.equal(formatModel("openai/safe\x1b[2J\nmodel"), "safe model");
	assert.equal(sanitizeDisplayText("safe\x1b[31m red\x1b[0m", 80), "safe red");
	assert.equal(
		sanitizeStatusText("safe\x1b[31m red\x1b[0m\x1b[2J\x1b]title\x07", 80),
		"safe\x1b[31m red\x1b[0m",
	);
	assert.equal(sanitizeStatusText("a\x1bPpayload\x1b\\b\x1b", 80), "ab");
});

test("session token totals ignore subagent snapshots and count only parent messages", () => {
	const entries = [
		{
			type: "message",
			message: { role: "assistant", usage: { input: 12, output: 8 } },
		},
		{
			type: "custom",
			customType: "pi-session-footer:async-tokens",
			data: { totalTokens: { input: 900, output: 100 } },
		},
		{
			type: "custom_message",
			customType: "subagent-notify",
			content: "Session file: /tmp/child/session.jsonl",
		},
		{
			type: "message",
			message: { role: "assistant", usage: { input: 3, output: 2 } },
		},
	];
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	assert.deepEqual(sessionTokens(makeContext(ui, entries)), {
		input: 15,
		output: 10,
		total: 25,
	});
});

test("layout fits Unicode and keeps sidebar activity out of the footer", () => {
	const lines = renderFooter(
		{
			cwd: "~/proj/🧪/e\u0301/very-long-leaf",
			trusted: true,
			sessionName: "named-session",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
			inputTokens: 1_234,
			outputTokens: 99,
			contextUsage: { contextWindow: 200_000, percent: 75 },
			statuses: new Map([
				["zeta", "Z status"],
				["alpha", "A status"],
			]),
		},
		theme(),
		28,
	);
	assert.equal(lines.length, FOOTER_ROWS);
	assert.ok(lines.every((line) => visibleWidth(line) <= 28));
	assert.match(lines[0], /named-session/);

	const themed = renderFooter(
		{
			cwd: "~/x",
			trusted: true,
			sessionName: "Named work",
			modelId: "x",
			thinkingLevel: "off",
			inputTokens: 0,
			outputTokens: 0,
			statuses: new Map([
				["alpha", "\x1b[31mA styled\x1b[0m\n\x1b]unsafe\x07"],
				["background-jobs", "1 background job: Test suite"],
				["subagent-slash", "2 tools | live detail"],
				["mcp", "MCP: 0/4 servers"],
				["mcp-auth", "Authenticating calendar..."],
				["pi-lens-lsp", "LSP Active: typescript"],
				["zeta", "Z status"],
			]),
		},
		{
			fg: (color, text) => `<${color}>${text}</${color}>`,
			bold: (text) => `<bold>${text}</bold>`,
		},
		500,
	);
	assert.match(
		themed[0],
		/<muted>~\/x<\/muted><dim> · <\/dim><text>Named work<\/text>/,
	);
	assert.doesNotMatch(themed[0], /trusted|untrusted/);
	assert.match(themed[1], /A styled.*Z status/);
	assert.doesNotMatch(
		themed.join("\n"),
		/background job|live detail|MCP:|Authenticating calendar|LSP Active:/,
	);
	assert.doesNotMatch(themed.join("\n"), /agents|shells|\x1b\]/);

	const untrusted = renderFooter(
		{
			cwd: "~/unsafe",
			trusted: false,
			sessionName: "Audit",
			modelId: "x",
			thinkingLevel: "off",
			inputTokens: 0,
			outputTokens: 0,
			statuses: new Map(),
		},
		{
			fg: (color, text) => `<${color}>${text}</${color}>`,
			bold: (text) => `<bold>${text}</bold>`,
		},
		500,
	);
	assert.match(untrusted[0], /<error>~\/unsafe<\/error>/);
	assert.doesNotMatch(untrusted[0], /trusted|untrusted/);

	const hostile = renderFooter(
		{
			cwd: "/tmp/good\nINJECTED\x1b]title\x07",
			trusted: true,
			sessionName: "safe\nNAME\x1b]title\x07",
			modelId: "openai/safe\x1b[2J-model",
			thinkingLevel: "high\x1b[2J\nINJECTED",
			inputTokens: 0,
			outputTokens: 0,
			statuses: new Map(),
		},
		theme(),
		120,
	);
	assert.match(hostile.join("\n"), /good INJECTED/);
	assert.match(hostile[0], /safe NAME/);
	assert.match(hostile.join("\n"), /safe-model/);
	assert.doesNotMatch(hostile.join("\n"), /\x1b|\nINJECTED/);
});

test("named row stays bounded on tiny terminal widths", () => {
	for (let width = 1; width <= 16; width += 1) {
		const lines = renderFooter(
			{
				cwd: "~/very/long/project/path",
				trusted: false,
				sessionName: "Very long session name",
				modelId: "gpt-5.6-sol",
				thinkingLevel: "max",
				inputTokens: 1_000,
				outputTokens: 2_000,
				statuses: new Map([["notice", "Long extension status"]]),
			},
			theme(),
			width,
		);
		assert.equal(lines.length, FOOTER_ROWS);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(lines.join("\n"), /trusted|untrusted/);
	}
});

test("controller renders goal activity without writing extension statuses", async () => {
	const pi = new FakePi();
	const goalRequests: unknown[] = [];
	pi.events.on(GOAL_STATUS_REQUEST_EVENT, (payload) => goalRequests.push(payload));
	const controller = new FooterController(pi.api(), dependencies());
	controller.register();
	controller.register();
	assert.deepEqual([...pi.bus.keys()], [
		GOAL_STATUS_REQUEST_EVENT,
		GOAL_STATUS_EVENT,
		FOOTER_STATUS_SOURCE_REQUEST_EVENT,
		POST_FOOTER_SLOT_REQUEST_EVENT,
	]);
	let mountedRows: unknown;
	const stopMountedListener = pi.events.on(FOOTER_MOUNTED_EVENT, (payload) => {
		mountedRows = (payload as { rows?: unknown }).rows;
	});
	const branch = [
		{
			type: "message",
			message: { role: "assistant", usage: { input: 12, output: 8 } },
		},
	];
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const ctx = makeContext(ui, branch, "footer-test-session", "Initial name");
	controller.start(ctx);
	assert.deepEqual(goalRequests, [{ version: 1, sessionId: "footer-test-session" }]);
	assert.equal(mountedRows, FOOTER_ROWS);
	stopMountedListener();
	let renderRequests = 0;
	const footer = createFooter(
		ui,
		() => { renderRequests += 1; },
		new Map([["other-extension", "kept"]]),
	);
	assert.match(footer.render(120).join("\n"), /↑12 ↓8/);
	assert.match(footer.render(120).join("\n"), /kept/);
	assert.match(footer.render(120)[0], /Initial name/);
	pi.events.emit(GOAL_STATUS_EVENT, {
		version: 1,
		providerId: "goal-provider",
		sequence: 1,
		sessionId: "footer-test-session",
		goal: { phase: "active", live: true },
	});
	assert.match(footer.render(120).join("\n"), /goal active/);
	assert.deepEqual(ui.statusWrites, []);
	assert.deepEqual(ui.widgetWrites, []);
	assert.equal(pi.bus.get("subagent:async-started"), undefined);
	assert.equal(pi.bus.get("background-jobs:changed"), undefined);
	const before = renderRequests;
	pi.events.emit("subagent:async-started", { id: "run" });
	pi.events.emit("background-jobs:changed", { runningCount: 1 });
	assert.equal(renderRequests, before);

	const modelSelect = pi.lifecycle.get("model_select")?.[0];
	assert.ok(modelSelect);
	await modelSelect({ model: { id: "claude-opus-4-8" } }, ctx);
	assert.match(footer.render(120).join("\n"), /opus-4-8/);
	assert.ok(renderRequests > before);

	const sessionInfoChanged = pi.lifecycle.get("session_info_changed")?.[0];
	assert.ok(sessionInfoChanged);
	await sessionInfoChanged({ name: "Named from command" }, ctx);
	assert.match(footer.render(120)[0], /Named from command/);
	await sessionInfoChanged({ name: undefined }, ctx);
	assert.doesNotMatch(footer.render(120)[0], /Named from command/);
	footer.dispose?.();
	controller.stop();
});

test("status source replays across load order and becomes inert after disposal", () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), dependencies());
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, [], "status-session"));
	const statuses = new Map([
		["pi-lens-lsp", "LSP Failed: ruby-lsp"],
		["other", "kept"],
	]);
	const footer = createFooter(ui, () => undefined, statuses);

	const sources: FooterStatusSourceReadyPayload[] = [];
	pi.events.on(FOOTER_STATUS_SOURCE_READY_EVENT, (payload) => {
		sources.push(payload as FooterStatusSourceReadyPayload);
	});
	assert.doesNotThrow(() => pi.events.emit(
		FOOTER_STATUS_SOURCE_REQUEST_EVENT,
		new Proxy({}, { get() { throw new Error("hostile request"); } }),
	));
	pi.events.emit(FOOTER_STATUS_SOURCE_REQUEST_EVENT, { version: 1 });
	pi.events.emit(FOOTER_STATUS_SOURCE_REQUEST_EVENT, { version: 1, sessionId: "wrong-session" });
	assert.equal(sources.length, 0);
	pi.events.emit(FOOTER_STATUS_SOURCE_REQUEST_EVENT, { version: 1, sessionId: "status-session" });
	assert.equal(sources.length, 1);
	const source = sources[0]!;
	assert.equal(source.version, 1);
	assert.equal(source.sessionId, "status-session");
	assert.deepEqual(source.readStatuses(), [
		{ key: "pi-lens-lsp", text: "LSP Failed: ruby-lsp" },
		{ key: "other", text: "kept" },
	]);

	statuses.set("pi-lens-lsp", "LSP Active: ruby-lsp");
	assert.deepEqual(source.readStatuses()[0], {
		key: "pi-lens-lsp",
		text: "LSP Active: ruby-lsp",
	});
	assert.notEqual(source.readStatuses(), source.readStatuses());

	controller.start(makeContext(ui, [], "replacement-session"));
	assert.deepEqual(source.readStatuses(), []);
	footer.dispose?.();
	assert.deepEqual(source.readStatuses(), []);
	controller.stop();
});

test("a registered post-footer shelf renders after the footer rows", () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), dependencies());
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, [], "slot-session"));
	const capabilities: Array<{
		register(slot: {
			id: string;
			token: string;
			order: number;
			maxRows: number;
			render(width: number): readonly string[];
		}): { isActive(): boolean; dispose(): void } | undefined;
	}> = [];
	pi.events.on(POST_FOOTER_SLOT_READY_EVENT, (payload) => {
		capabilities.push(payload as (typeof capabilities)[number]);
	});
	const footer = createFooter(ui, () => undefined);
	assert.equal(capabilities.length, 1);
	assert.doesNotThrow(() => pi.events.emit(
		POST_FOOTER_SLOT_REQUEST_EVENT,
		new Proxy({}, { get() { throw new Error("hostile request"); } }),
	));
	pi.events.emit(POST_FOOTER_SLOT_REQUEST_EVENT, { version: 1 });
	pi.events.emit(POST_FOOTER_SLOT_REQUEST_EVENT, {
		version: 1,
		sessionId: "wrong-slot-session",
	});
	assert.equal(capabilities.length, 1);
	pi.events.emit(POST_FOOTER_SLOT_REQUEST_EVENT, {
		version: 1,
		sessionId: "slot-session",
	});
	assert.equal(capabilities.length, 2);
	const handle = capabilities.at(-1)?.register({
		id: "neumie.sidebar.narrow",
		token: "sidebar-slot",
		order: 100,
		maxRows: 7,
		render: () => ["─".repeat(80), "narrow sidebar"],
	});
	assert.ok(handle);
	assert.equal(handle.isActive(), true);
	const lines = footer.render(80);
	assert.equal(lines.length, 4);
	assert.match(lines[0] ?? "", /project/);
	assert.match(lines[1] ?? "", /GPT-5.6 Sol/);
	assert.equal(lines[2], "─".repeat(80));
	assert.equal(lines[3], "narrow sidebar");

	handle.dispose();
	assert.equal(handle.isActive(), false);
	assert.equal(footer.render(80).length, FOOTER_ROWS);
	footer.dispose?.();
	controller.stop();
});

test("post-footer slot handles survive a failing render request", () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), dependencies());
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, [], "throwing-render-session"));
	let capability: {
		register(slot: unknown): { isActive(): boolean; dispose(): void } | undefined;
	} | undefined;
	pi.events.on(POST_FOOTER_SLOT_READY_EVENT, (payload) => {
		capability = payload as typeof capability;
	});
	const footer = createFooter(ui, () => { throw new Error("render request failed"); });
	assert.ok(capability);
	let handle: { isActive(): boolean; dispose(): void } | undefined;
	assert.doesNotThrow(() => {
		handle = capability?.register({
			id: "neumie.sidebar.narrow",
			token: "throwing-render-slot",
			order: 100,
			maxRows: 1,
			render: () => ["still active"],
		});
	});
	assert.ok(handle);
	assert.equal(handle.isActive(), true);
	assert.equal(footer.render(80).at(-1), "still active");
	assert.doesNotThrow(() => handle?.dispose());
	assert.equal(handle.isActive(), false);
	footer.dispose?.();
	controller.stop();
});

test("post-footer slots are bounded, terminal-safe, replaceable, and session-scoped", () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), dependencies());
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(ui, [], "bounded-slot-session"));
	const capabilities: Array<{
		register(slot: unknown): { isActive(): boolean; dispose(): void } | undefined;
	}> = [];
	pi.events.on(POST_FOOTER_SLOT_READY_EVENT, (payload) => {
		capabilities.push(payload as (typeof capabilities)[number]);
	});
	const footer = createFooter(ui, () => undefined);
	const capability = capabilities.at(-1);
	assert.ok(capability);
	assert.equal(capability.register({ id: "", token: "bad" }), undefined);
	const first = capability.register({
		id: "neumie.sidebar.narrow",
		token: "first-slot",
		order: 100,
		maxRows: 3,
		render: () => [
			"  safe\x1b[31m red\x1b[0m  ",
			"\x1b[2Jsecond\nline",
			"x".repeat(100),
			"overflow",
		],
	});
	assert.ok(first);
	const shelf = footer.render(12).slice(FOOTER_ROWS);
	assert.equal(shelf.length, 3);
	assert.ok(shelf.every((line) => visibleWidth(line) <= 12));
	assert.match(shelf[0] ?? "", /^  safe/);
	assert.match(shelf[0] ?? "", /\x1b\[31m/);
	assert.doesNotMatch(shelf.join("\n"), /\x1b\[2J|second\nline/);

	const replacement = capability.register({
		id: "neumie.sidebar.narrow",
		token: "replacement-slot",
		order: 100,
		maxRows: 1,
		render: () => ["replacement"],
	});
	assert.ok(replacement);
	assert.equal(first.isActive(), false);
	assert.equal(replacement.isActive(), true);
	assert.equal(footer.render(80).at(-1), "replacement");

	controller.start(makeContext(ui, [], "next-slot-session"));
	assert.equal(replacement.isActive(), false);
	assert.deepEqual(footer.render(80), []);
	controller.stop();
});

test("reload defers mounting until Pi settles its final layout", async () => {
	const pi = new FakePi();
	let pendingMount: (() => void) | undefined;
	let mountCancelled = false;
	const controller = new FooterController(pi.api(), dependencies({
		scheduleMount(handler) {
			pendingMount = handler;
			return () => { mountCancelled = true; };
		},
	}));
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	let mountedRows: unknown;
	pi.events.on(FOOTER_MOUNTED_EVENT, (payload) => {
		mountedRows = (payload as { rows?: unknown }).rows;
	});
	const start = pi.lifecycle.get("session_start")?.[0];
	assert.ok(start);
	await start({ reason: "reload" }, makeContext(ui));
	assert.equal(ui.footerFactory, undefined);
	assert.equal(mountedRows, undefined);
	assert.ok(pendingMount);
	assert.equal(mountCancelled, false);
	pendingMount();
	assert.ok(ui.footerFactory);
	assert.equal(mountedRows, FOOTER_ROWS);
	controller.stop();
});

test("shutdown cancels a pending reload mount", async () => {
	const pi = new FakePi();
	let pendingMount: (() => void) | undefined;
	let mountCancelled = false;
	const controller = new FooterController(pi.api(), dependencies({
		scheduleMount(handler) {
			pendingMount = handler;
			return () => { mountCancelled = true; };
		},
	}));
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const ctx = makeContext(ui);
	const start = pi.lifecycle.get("session_start")?.[0];
	const shutdown = pi.lifecycle.get("session_shutdown")?.[0];
	assert.ok(start);
	assert.ok(shutdown);
	await start({ reason: "reload" }, ctx);
	assert.ok(pendingMount);
	await shutdown({ reason: "reload" }, ctx);
	assert.equal(mountCancelled, true);
	pendingMount();
	assert.equal(ui.footerFactory, undefined);
});

test("token updates accept fresh context wrappers only for the current session", async () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), dependencies());
	controller.register();
	const ui: FakeUI = { statusWrites: [], widgetWrites: [] };
	const branch: unknown[] = [];
	const startContext = makeContext(ui, branch);
	controller.start(startContext);
	const footer = createFooter(ui, () => undefined);
	const turnEnd = pi.lifecycle.get("turn_end")?.[0];
	assert.ok(turnEnd);
	await turnEnd({}, makeContext(ui, [
		{ type: "message", message: { role: "assistant", usage: { input: 999, output: 999 } } },
	], "foreign-session"));
	assert.match(footer.render(200).join("\n"), /↑0 ↓0/);

	branch.push({
		type: "message",
		message: { role: "assistant", usage: { input: 12, output: 18 } },
	});
	const freshWrapper = { ...startContext } as ExtensionContext;
	await turnEnd({}, freshWrapper);
	assert.match(footer.render(200).join("\n"), /↑12 ↓18/);
	controller.stop();
});

test("a replaced footer generation becomes inert", () => {
	const pi = new FakePi();
	const controller = new FooterController(pi.api(), dependencies());
	const firstUi: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(firstUi));
	const firstFooter = createFooter(firstUi, () => undefined);
	const secondUi: FakeUI = { statusWrites: [], widgetWrites: [] };
	controller.start(makeContext(secondUi, [], "second-session"));
	assert.deepEqual(firstFooter.render(120), []);
	assert.ok(secondUi.footerFactory);
	controller.stop();
});

test("runtime integrations remain event-only and artifact-free", async () => {
	const source = await Promise.all([
		readFile(new URL("../extensions/controller.ts", import.meta.url), "utf8"),
		readFile(new URL("../extensions/goals.ts", import.meta.url), "utf8"),
		readFile(new URL("../extensions/post-footer.ts", import.meta.url), "utf8"),
		readFile(new URL("../extensions/tokens.ts", import.meta.url), "utf8"),
	]);
	const combined = source.join("\n");
	assert.match(combined, /@neumie\/pi-subagents-goal:v1:status/u);
	assert.doesNotMatch(
		combined,
		/node:fs|appendEntry|status\.json|subagent:async|background-jobs:changed|asyncDir|pi-subagents-uid/,
	);
});

test("default export registers the renamed extension entry point", () => {
	const pi = new FakePi();
	extension(pi.api());
	assert.equal(pi.lifecycle.get("session_start")?.length, 1);
	assert.equal(pi.lifecycle.get("session_info_changed")?.length, 1);
	assert.deepEqual([...pi.bus.keys()], [
		GOAL_STATUS_EVENT,
		FOOTER_STATUS_SOURCE_REQUEST_EVENT,
		POST_FOOTER_SLOT_REQUEST_EVENT,
	]);
});
