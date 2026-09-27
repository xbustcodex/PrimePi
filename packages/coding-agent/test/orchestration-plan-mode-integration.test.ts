import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveRoleChain } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Orchestration, planIndicator } from "../src/core/orchestration/orchestration.ts";
import {
	planRoleEligibility,
	resolvePlanExitTransition,
	resolvePlanModelTransition,
} from "../src/core/orchestration/plan-model-transition.ts";

/**
 * The wired behaviour: entering and leaving plan mode moves the model *and* the
 * state together.
 *
 * The coordinator tests prove the state machine; the transition tests prove the
 * model policy. This file pins that the two are actually connected, and that the
 * connection does not let a plan role reach a model the gates exclude.
 */

const T0 = 1_000_000;

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		api: "anthropic-messages",
		name: id,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as Model<Api>;
}

const freeModel = model("openrouter", "vendor/a:free", { free: true });
const planModel = model("anthropic", "claude-sonnet-4-5");
const paidModel = model("anthropic", "claude-opus-5", { cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } });

/**
 * A stand-in for the session's two responsibilities: hold the model, and run the
 * transition. Mirrors `enterPlanMode`/`leavePlanMode` without constructing a
 * session, which needs file storage and a runtime.
 */
class PlanSessionHarness {
	orchestration = new Orchestration();
	model: Model<Api> | undefined;
	streaming = false;
	/** Set when the model changed, mirroring `setModel`. */
	modelChanges: string[] = [];

	private readonly configured: Record<string, string>;
	private readonly availableModels: Model<Api>[];
	private readonly policy: "off" | "same-provider" | "free-only" | "compatible";
	private readonly hasAuth: (provider: string) => boolean;
	private readonly disabled: ReadonlySet<string>;

	constructor(
		configured: Record<string, string>,
		available: Model<Api>[],
		policy: "off" | "same-provider" | "free-only" | "compatible",
		hasAuth: (provider: string) => boolean,
		disabled: ReadonlySet<string> = new Set(),
	) {
		this.configured = configured;
		this.availableModels = available;
		this.policy = policy;
		this.hasAuth = hasAuth;
		this.disabled = disabled;
	}

	async enter(now: number) {
		if (this.orchestration.plan.phase === "planning") return;
		this.orchestration.beginPlanning(now);
		this.#applyEntry();
	}
	async leave(now: number) {
		if (this.orchestration.plan.phase === "planning") this.orchestration.leavePlanning(now);
		this.#applyExit();
	}

	async approve(now: number) {
		this.orchestration.approvePlan(now);
		// Approval lifts the barrier, so planning ends and the model is restored —
		// the same two steps the session performs.
		await this.leave(now);
	}

	#prePlanModel?: Model<Api>;

	#applyEntry() {
		this.#prePlanModel = this.model;
		const resolution = resolveRoleChain({
			role: "plan",
			configured: this.configured,
			available: this.availableModels,
			eligibility: planRoleEligibility({
				sessionModel: this.model,
				policy: this.policy,
				credentialMissing: (provider) => !this.hasAuth(provider),
				disabledProviders: this.disabled,
			}),
		});
		const transition = resolvePlanModelTransition({
			current: this.model,
			candidates: resolution.candidates,
			isStreaming: this.streaming,
		});
		if (transition.kind === "apply" && !transition.deferred) this.#setModel(transition.model);
	}

	#applyExit() {
		const transition = resolvePlanExitTransition({
			current: this.model,
			restoreTo: this.#prePlanModel,
			isStreaming: this.streaming,
		});
		if (transition.kind === "apply" && !transition.deferred) this.#setModel(transition.model);
		this.#prePlanModel = undefined;
	}

	#setModel(next: Model<Api>) {
		this.model = next;
		this.modelChanges.push(`${next.provider}/${next.id}`);
	}
}

function harness(
	over: Partial<{ policy: "off" | "same-provider" | "free-only" | "compatible"; auth: (p: string) => boolean }> = {},
) {
	const h = new PlanSessionHarness(
		{ plan: "anthropic/claude-sonnet-4-5" },
		[freeModel, planModel, paidModel],
		over.policy ?? "compatible",
		over.auth ?? (() => true),
	);
	h.model = freeModel;
	return h;
}

describe("entering and leaving plan mode", () => {
	it("switches to the plan model on entry and back on exit", async () => {
		const h = harness();
		await h.enter(T0);
		expect(h.model).toBe(planModel);

		await h.leave(T0 + 10);
		expect(h.model).toBe(freeModel);
		expect(h.modelChanges).toEqual(["anthropic/claude-sonnet-4-5", "openrouter/vendor/a:free"]);
	});

	it("keeps the current model when the role is unconfigured", async () => {
		const h = new PlanSessionHarness({}, [freeModel, planModel], "compatible", () => true);
		h.model = freeModel;

		await h.enter(T0);
		expect(h.model).toBe(freeModel);
		expect(h.modelChanges).toEqual([]);
	});

	it("keeps the current model when the plan provider has no credential", async () => {
		const h = new PlanSessionHarness(
			{ plan: "anthropic/claude-sonnet-4-5" },
			[freeModel, planModel],
			"compatible",
			() => false,
		);
		h.model = freeModel;

		await h.enter(T0);
		expect(h.model).toBe(freeModel);
	});

	it("keeps the current model when the plan provider is disabled", async () => {
		const h = new PlanSessionHarness(
			{ plan: "anthropic/claude-sonnet-4-5" },
			[freeModel, planModel],
			"compatible",
			() => true,
			new Set(["anthropic"]),
		);
		h.model = freeModel;

		await h.enter(T0);
		expect(h.model).toBe(freeModel);
	});

	it("cannot reach a paid plan model under a free-only policy", async () => {
		const h = new PlanSessionHarness(
			{ plan: "anthropic/claude-opus-5" },
			[freeModel, paidModel],
			"free-only",
			() => true,
		);
		h.model = freeModel;

		await h.enter(T0);
		// Configuration names exactly the model the policy forbids.
		expect(h.model).toBe(freeModel);
	});

	it("skips a deferred switch while streaming rather than queueing it", async () => {
		const h = harness();
		h.streaming = true;
		await h.enter(T0);
		// A queued model change would land at some later settle and could override
		// a deliberate user choice made in the meantime.
		expect(h.model).toBe(freeModel);
		expect(h.modelChanges).toEqual([]);
	});
});

describe("approval connects state and model", () => {
	it("restores the pre-plan model while keeping the plan as guidance", async () => {
		const h = harness();
		await h.enter(T0);
		h.orchestration.recordDraft({ title: "Add auth", content: "# Plan", now: T0 + 5 });

		await h.approve(T0 + 10);

		// The model is restored...
		expect(h.model).toBe(freeModel);
		// ...and the plan survives, still authoritative as guidance.
		expect(h.orchestration.hasApprovedPlan).toBe(true);
		expect(h.orchestration.plan.plan?.content).toBe("# Plan");
		expect(planIndicator(h.orchestration.state)).toBe("APPROVED PLAN GUIDING IMPLEMENTATION");
	});

	it("still reports an unapproved draft as non-authority after exit", async () => {
		const h = harness();
		await h.enter(T0);
		h.orchestration.recordDraft({ title: "Draft", content: "# Draft", now: T0 + 5 });

		// Exited without approval.
		await h.leave(T0 + 10);

		expect(h.orchestration.hasApprovedPlan).toBe(false);
		expect(h.orchestration.hasUnapprovedDraft).toBe(true);
		expect(planIndicator(h.orchestration.state)).toBe("NO ACTIVE PLAN");
	});
});
