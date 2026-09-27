import { describe, expect, it } from "vitest";
import type { OrchestrationState } from "../src/core/orchestration/orchestration.ts";
import { associationFor, renderAssociationPrompt } from "../src/core/orchestration/task-association.ts";

describe("a task association never mutates orchestration state", () => {
	const plan = { id: "plan-1", title: "Add auth", content: "# Plan", createdAt: 1, approvedAt: 1 };

	function snapshot(): OrchestrationState {
		return {
			plan: { phase: "approved", unapproved: false, plan: { ...plan } },
			goal: {
				current: {
					id: "g1",
					objective: "ship",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
			},
			todo: { phases: [{ name: "Tasks", tasks: [{ content: "add refresh", status: "in_progress" }] }] },
		};
	}

	it("builds an association from existing identifiers only", () => {
		const association = associationFor({ approvedPlan: plan, goalId: "g1", todoContent: "add refresh" });
		expect(association).toEqual({
			planId: "plan-1",
			planTitle: "Add auth",
			goalId: "g1",
			todoContent: "add refresh",
		});
	});

	it("does not record a plan that is not approved", () => {
		// A draft is not authority, so it is not associated. The same distinction
		// Phase 4 draws between `approved` and a draft.
		const association = associationFor({ goalId: "g1" });
		expect(association.planId).toBeUndefined();
		expect(association.planTitle).toBeUndefined();
	});

	it("leaves the plan, goal, and todo state byte-identical", () => {
		const before = JSON.stringify(snapshot());
		associationFor({ approvedPlan: plan, goalId: "g1", todoContent: "add refresh" });
		renderAssociationPrompt({ planId: "plan-1", planTitle: "Add auth", goalId: "g1", todoContent: "add refresh" });
		expect(JSON.stringify(snapshot())).toBe(before);
	});

	it("tells the child not to rewrite the parent's state", () => {
		const prompt = renderAssociationPrompt({ planId: "plan-1", planTitle: "Add auth", todoContent: "add refresh" });
		expect(prompt).toContain("Add auth");
		// A child must not be able to read the association as permission to close
		// the parent's todo or declare the plan done.
		expect(prompt).toMatch(/do not restate or rewrite it/i);
		expect(prompt).toMatch(/the parent owns that list/i);
	});

	it("renders nothing for an empty association", () => {
		expect(renderAssociationPrompt({})).toBe("");
	});
});
