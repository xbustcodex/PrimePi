import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * The todo lifecycle, driven through the session.
 *
 * ## What makes these behavioural rather than unit
 *
 * Every test here calls `session.prompt`, which is what a user does. The
 * settings are changed through the settings manager, the same way the settings
 * panel changes them, and the observation is a message the model would have
 * read or a tool call that would or would not have run.
 *
 * The specific thing this file guards is the *join*. `decideNudge` and
 * `applyTodoOperation` are each correct in isolation and were each unit tested
 * that way; what can be wrong is that the session never asks the question, or
 * asks it with the wrong inputs, and every test below fails in exactly that
 * way while both units keep passing.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses) harness.cleanup();
	harnesses.length = 0;
});

/**
 * Builds a session with the named settings applied.
 *
 * Applied after construction through `setSetting` rather than passed to
 * `createHarness`, because the harness takes the nested legacy `Settings`
 * shape and a dotted key passed there is silently dropped — which is a way to
 * write a test that proves nothing. Going through `setSetting` is also what the
 * settings panel does, so this is the same path a user's toggle takes.
 */
async function harnessWith(settings: Record<string, boolean | number> = {}): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	for (const [key, value] of Object.entries(settings)) harness.settingsManager.setSetting(key, value);
	return harness;
}

/**
 * The custom messages a session persisted, in branch order.
 *
 * `appendMessage` records a custom message as a `message` entry carrying a
 * `custom` role, not as a `custom_message` entry — the latter is what
 * `appendCustomMessageEntry` writes. Filtering on the entry type alone reads an
 * empty branch and would pass for "no reminder fired".
 */
function customEntries(harness: Harness): { type: string; content: string }[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as { message: { role: string; customType?: string } }).message)
		.filter((message) => message.role === "custom")
		.map((message) => ({ type: message.customType ?? "", content: getMessageText(message) }));
}

/** Every message the provider would be given, flattened to text. */
function projectedText(harness: Harness): string {
	return harness.sessionManager
		.buildSessionProjection()
		.messages.map((message) => getMessageText(message))
		.join("\n");
}

describe("todo.enabled as it is read at construction", () => {
	// A session that STARTS disabled is the case a change-subscription cannot
	// cover: `onEffectiveChange` fires on change, never at construction, so a gate
	// implemented only in the subscription would leave this tool registered and
	// callable. Seeded through the harness's nested shape because that is the
	// only way to be disabled before the first registry build.
	it("does not register the tool for a session that starts disabled", async () => {
		const harness = await createHarness({ settings: { todo: { enabled: false } } as never });
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.session.getToolDefinition("todo")).toBeUndefined();
	});
});

describe("todo.enabled decides whether todos exist at all", () => {
	it("registers the todo tool and declares it to the model when on", async () => {
		const harness = await harnessWith({ "todo.enabled": true });

		expect(harness.session.getActiveToolNames()).toContain("todo");
		expect(harness.session.getToolDefinition("todo")?.name).toBe("todo");
	});

	it("withholds the todo tool from the model when off", async () => {
		const harness = await harnessWith({ "todo.enabled": false });

		expect(harness.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.session.getToolDefinition("todo")).toBeUndefined();
	});

	it("refuses a todo call the model makes anyway, rather than silently dropping it", async () => {
		const harness = await harnessWith({ "todo.enabled": false });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["sneaky"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("track this");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(getMessageText(toolResults[0])).toContain("not found");
		expect(harness.session.orchestration.todo.phases).toEqual([]);
	});

	it("applies a todo call when on, through the same prompt", async () => {
		const harness = await harnessWith({ "todo.enabled": true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["first", "second"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("planned"),
		]);

		await harness.session.prompt("track this");

		expect(harness.session.orchestration.todo.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"first",
			"second",
		]);
	});

	it("removes the tool when the setting is flipped off mid-session, without a restart", async () => {
		const harness = await harnessWith({ "todo.enabled": true });
		expect(harness.session.getActiveToolNames()).toContain("todo");

		harness.settingsManager.setSetting("todo.enabled", false);
		await Promise.resolve();

		expect(harness.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.session.getToolDefinition("todo")).toBeUndefined();
	});

	it("restores the tool when the setting is flipped back on", async () => {
		const harness = await harnessWith({ "todo.enabled": false });
		harness.settingsManager.setSetting("todo.enabled", true);
		await Promise.resolve();

		expect(harness.session.getActiveToolNames()).toContain("todo");
	});
});

describe("reminders come from a finished turn, not from a helper", () => {
	/**
	 * Drives a turn in which the model mutates the working tree enough to have
	 * stopped rather than still been thinking, then writes a todo plan and a
	 * final answer with the plan unfinished.
	 *
	 * The mutation count is real: each `bash` call is a tool result the loop
	 * reports, and `decideNudge` refuses to nudge a model that has not stopped
	 * making progress. Twelve is the threshold, so twelve is what this does.
	 */
	async function turnThatStopsMidPlan(
		settings: Record<string, boolean | number>,
		promptText = "do the work",
	): Promise<Harness> {
		const harness = await harnessWith(settings);
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["ship it"] }), { stopReason: "toolUse" }),
			// A plain text answer: the turn ends here with the plan unfinished.
			fauxAssistantMessage("I stopped early."),
			// The reminder sends the model back; it finishes the item this time.
			fauxAssistantMessage(fauxToolCall("todo", { op: "done", task: "ship it" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished."),
		]);
		await harness.session.prompt(promptText);
		return harness;
	}

	it("reminds the model when a turn ends with work outstanding", async () => {
		const harness = await turnThatStopsMidPlan({ "todo.reminders": true, "todo.remindersMax": 5 });

		const reminders = customEntries(harness).filter((entry) => entry.type === "todo-reminder");
		expect(reminders).toHaveLength(1);
		expect(reminders[0]?.content).toContain("1 incomplete todo item");
		expect(reminders[0]?.content).toContain("ship it");
	});

	it("the reminder reaches the model, not only the transcript", async () => {
		const harness = await turnThatStopsMidPlan({ "todo.reminders": true, "todo.remindersMax": 5 });

		expect(projectedText(harness)).toContain("You stopped with 1 incomplete todo item");
	});

	it("stays silent when the setting is off", async () => {
		const harness = await turnThatStopsMidPlan({ "todo.reminders": false, "todo.remindersMax": 5 });

		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
		// The turn still finished, and the plan is still unfinished: the silence is
		// the setting, not a completed plan.
		expect(harness.session.orchestration.todo.phases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	it("stays silent when todo.enabled is off, even with reminders on", async () => {
		const harness = await turnThatStopsMidPlan({
			"todo.enabled": false,
			"todo.reminders": true,
			"todo.remindersMax": 5,
		});

		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
	});

	it("ignores a plan larger than remindersMax rather than nagging about all of it", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 2 });
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["a", "b", "c", "d", "e"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("stopped"),
		]);

		await harness.session.prompt("do the work");

		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
		expect(harness.session.orchestration.todo.phases[0]?.tasks).toHaveLength(5);
	});

	it("stays silent when the user is mid-question, because a model answering is working", async () => {
		const harness = await turnThatStopsMidPlan(
			{ "todo.reminders": true, "todo.remindersMax": 5 },
			"can you explain why the retry budget is three?",
		);

		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
	});

	it("gives up after the per-cycle cap rather than looping", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		// Twelve mutations, a plan, an answer — then an endless run of answers that
		// never touch the plan. Without a cap this is an infinite loop.
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["unfinished"] }), { stopReason: "toolUse" }),
			...Array.from({ length: 8 }, () => fauxAssistantMessage("still going")),
		]);

		await harness.session.prompt("do the work");

		// Two is the mid-run cap; the third answer ends the run on an empty queue.
		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder").length).toBeLessThanOrEqual(2);
	});
});

describe("boundaries and failure", () => {
	it("says nothing for an empty list", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "view" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("nothing to do"),
		]);

		await harness.session.prompt("check");

		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
	});

	it("stays silent once every item is closed, and spends no budget doing so", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["one", "two"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "done", task: "one" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "drop", task: "two" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("All done."),
		]);

		await harness.session.prompt("do the work");

		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
	});

	it("reminds about a single open item", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["only"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped"),
		]);

		await harness.session.prompt("do the work");

		const reminders = customEntries(harness).filter((entry) => entry.type === "todo-reminder");
		expect(reminders).toHaveLength(1);
		expect(reminders[0]?.content).toContain("1 incomplete todo item");
	});

	it("handles a large plan without losing the turn", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 500 });
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		const items = Array.from({ length: 200 }, (_, index) => `item ${index}`);
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items }), { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped"),
		]);

		await harness.session.prompt("do the work");

		expect(harness.session.orchestration.todo.phases[0]?.tasks).toHaveLength(200);
		const reminders = customEntries(harness).filter((entry) => entry.type === "todo-reminder");
		expect(reminders).toHaveLength(1);
		expect(reminders[0]?.content).toContain("200 incomplete todo item(s)");
		expect(reminders[0]?.content).toContain("item 199");
	});

	it("a malformed todo call fails the tool, not the turn", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		harness.setResponses([
			// `done` on a task that does not exist: a real model error, not a
			// synthetic one, and the shape a malformed transcript entry produces.
			fauxAssistantMessage(fauxToolCall("todo", { op: "done", task: "never existed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("do the work");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect((toolResults[0] as { isError: boolean }).isError).toBe(true);
		expect(harness.session.orchestration.todo.phases).toEqual([]);
		// The turn completed anyway, which is the property that matters.
		expect(getAssistantLastText(harness)).toBe("recovered");
	});

	it("a corrupt persisted todo record does not break the turn", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		// A snapshot whose phases are the wrong shape entirely, which is what a
		// truncated or hand-edited session file produces.
		harness.session.orchestration.restore({ todo: { phases: "not-an-array" } });
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("carry on");

		expect(harness.session.orchestration.todo.phases).toEqual([]);
		expect(getAssistantLastText(harness)).toBe("ok");
	});
});

describe("THE invariant: a reminder never pushes against the planning barrier", () => {
	it("does not remind while the barrier is up", async () => {
		const harness = await harnessWith({ "todo.reminders": true, "todo.remindersMax": 5 });
		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["plan the work"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Here is the plan."),
		]);

		await harness.session.enterPlanMode();
		await harness.session.prompt("plan this");

		// The plan is unfinished and the agent stopped. A reminder here would be a
		// push toward mutation, which the barrier refuses, so the reminder must not
		// fire at all.
		expect(harness.session.orchestration.writeBarrierActive).toBe(true);
		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);
	});

	it("still refuses a todo mutation while planning, the way any write is refused", async () => {
		const harness = await harnessWith({ "todo.enabled": true, "todo.reminders": true, "todo.remindersMax": 5 });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["mutate during planning"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("understood"),
		]);

		await harness.session.enterPlanMode();
		await harness.session.prompt("plan this");

		// `todo` is a write-tier tool, so the barrier denies it. This is the
		// regression this whole file exists to protect: wiring reminders must not
		// have made a todo operation a way around the read-only guarantee.
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect((toolResults[0] as { isError: boolean }).isError).toBe(true);
		expect(getMessageText(toolResults[0])).toMatch(/plan mode/i);
		expect(harness.session.orchestration.todo.phases).toEqual([]);
	});

	it("resumes reminding once planning ends and the plan is still open", async () => {
		const harness = await harnessWith({ "todo.enabled": true, "todo.reminders": true, "todo.remindersMax": 5 });
		// Seed a plan while the barrier is down, so the state exists before planning.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo", { op: "init", items: ["later"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("planned"),
		]);
		await harness.session.prompt("track this");

		const mutations = Array.from({ length: 12 }, () => fauxToolCall("bash", { command: "true" }));
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped again"),
		]);
		await harness.session.enterPlanMode();
		await harness.session.prompt("keep planning");
		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder")).toHaveLength(0);

		await harness.session.leavePlanMode();
		// Real work in this turn, then a stop with the item still open. A turn that
		// changed nothing has not demonstrated it finished, and `decideNudge`
		// declines it — so the reminder has to be earned here too, not merely
		// unblocked by leaving plan mode.
		harness.setResponses([
			fauxAssistantMessage(mutations, { stopReason: "toolUse" }),
			fauxAssistantMessage("still open"),
		]);
		await harness.session.prompt("implement it");

		expect(harness.session.orchestration.writeBarrierActive).toBe(false);
		expect(customEntries(harness).filter((entry) => entry.type === "todo-reminder").length).toBeGreaterThan(0);
	});
});

function getAssistantLastText(harness: Harness): string {
	const assistants = harness.session.messages.filter((message) => message.role === "assistant");
	return getMessageText(assistants.at(-1));
}
