import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

function toolNames(tools: Array<{ name: string }>): string[] {
	return tools.map((tool) => tool.name).sort();
}

describe("regression #5109: exclude tools", () => {
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			pi.on("session_start", () => {
				pi.registerTool({
					name: "ask_question",
					label: "Ask Question",
					description: "Ask a question",
					promptSnippet: "Ask a question",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
				pi.registerTool({
					name: "dynamic_tool",
					label: "Dynamic Tool",
					description: "Dynamic test tool",
					promptSnippet: "Run dynamic test behavior",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
			});
		},
	];

	it("filters built-in and extension tools from available and active tools", async () => {
		const harness = await createHarness({
			excludedToolNames: ["read", "ask_question"],
			extensionFactories,
		});
		try {
			await harness.session.bindExtensions({});

			const allToolNames = toolNames(harness.session.getAllTools());
			expect(allToolNames).not.toContain("read");
			expect(allToolNames).not.toContain("ask_question");
			expect(allToolNames).toContain("bash");
			expect(allToolNames).toContain("dynamic_tool");
			// Asserted by relation, not by literal. This harness passes no `tools`, so the
			// active set is the product default (`sdk.ts:276`), which now includes `task`
			// and `todo` and will include whatever is added next. Hardcoding it made a test
			// about *exclusion* fail whenever the default set changed.
			//
			// What #5109 is about: the excluded names are gone from availability and from
			// the prompt, and an allowed built-in and the extension tool both survive.
			const active = harness.session.getActiveToolNames().sort();
			expect(active).not.toContain("read");
			expect(active).not.toContain("ask_question");
			expect(active).toContain("bash");
			expect(active).toContain("dynamic_tool");
			expect(active).toContain("edit");
			expect(active).toContain("write");
			expect(harness.session.systemPrompt).not.toContain("- read:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
			expect(harness.session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		} finally {
			harness.cleanup();
		}
	});

	it("lets excluded tools override the allowlist", async () => {
		const harness = await createHarness({
			allowedToolNames: ["read", "bash", "ask_question"],
			excludedToolNames: ["read", "ask_question"],
			initialActiveToolNames: ["read", "bash", "ask_question"],
			extensionFactories,
		});
		try {
			await harness.session.bindExtensions({});

			expect(toolNames(harness.session.getAllTools())).toEqual(["bash"]);
			expect(harness.session.getActiveToolNames()).toEqual(["bash"]);
			expect(harness.session.systemPrompt).toContain("- bash:");
			expect(harness.session.systemPrompt).not.toContain("- read:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
		} finally {
			harness.cleanup();
		}
	});
});
