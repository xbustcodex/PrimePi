import { describe, expect, it } from "vitest";
import {
	creditsExpiringWithin,
	decideRedeem,
	isAnswered,
	mintRedeemRequestId,
	pickSoonestExpiringCredit,
	type ResetCredit,
	type StuckTurnEvidence,
} from "../src/usage/reset-credits.ts";

/**
 * Saved reset credits.
 *
 * The properties that matter: a credit is spent only for a genuine rescue, the
 * soonest-expiring one goes first, and a policy of `unset` asks *once* rather
 * than on every spend.
 */

const NOW = 1_700_000_000_000;
const hours = (n: number) => new Date(NOW + n * 3_600_000).toISOString();

const credit = (id: string, overrides: Partial<ResetCredit> = {}): ResetCredit => ({
	id,
	status: "available",
	expiresAt: hours(24),
	...overrides,
});

const stuck = (overrides: Partial<StuckTurnEvidence> = {}): StuckTurnEvidence => ({
	everyAccountBlocked: true,
	alternativeAccountAvailable: false,
	credits: [credit("c1")],
	now: NOW,
	...overrides,
});

describe("picking a credit to spend", () => {
	it("takes the one expiring soonest", () => {
		// Credits are perishable, so expiry order maximises the bank's lifetime
		// value.
		const picked = pickSoonestExpiringCredit([
			credit("late", { expiresAt: hours(72) }),
			credit("soon", { expiresAt: hours(1) }),
			credit("mid", { expiresAt: hours(24) }),
		]);
		expect(picked?.id).toBe("soon");
	});

	it("ranks an undated credit after every dated one", () => {
		// An undated credit is the one most likely to never expire, so it is the one
		// worth keeping longest.
		const picked = pickSoonestExpiringCredit([
			credit("undated", { expiresAt: undefined }),
			credit("dated", { expiresAt: hours(24) }),
		]);
		expect(picked?.id).toBe("dated");
	});

	it("prefers an undated credit to an unparseable one", () => {
		const picked = pickSoonestExpiringCredit([credit("bad", { expiresAt: "not-a-date" }), credit("undated")]);
		expect(picked?.id).toBe("undated");
	});

	it("skips credits that are not available", () => {
		const picked = pickSoonestExpiringCredit([
			credit("redeemed", { status: "redeemed", expiresAt: hours(1) }),
			credit("available", { expiresAt: hours(48) }),
		]);
		expect(picked?.id).toBe("available");
	});

	it("treats an absent status as available", () => {
		const picked = pickSoonestExpiringCredit([{ id: "implicit", expiresAt: hours(1) }]);
		expect(picked?.id).toBe("implicit");
	});

	it("returns nothing from an empty list", () => {
		expect(pickSoonestExpiringCredit([])).toBeUndefined();
	});

	it("falls back to the first credit when none are available", () => {
		// The consume then surfaces the backend's own outcome rather than this layer
		// guessing at one.
		const spent = credit("spent", { status: "redeemed" });
		expect(pickSoonestExpiringCredit([spent])?.id).toBe("spent");
	});
});

describe("the rescue gate is narrow on purpose", () => {
	it("spends when every account is blocked and none can take over", () => {
		const decision = decideRedeem("yes", stuck());
		expect(decision.action).toBe("spend");
	});

	it("does not spend when the turn was merely slow", () => {
		// A credit spent on a turn that was not stuck is a resource destroyed for
		// nothing.
		const decision = decideRedeem("yes", stuck({ everyAccountBlocked: false }));
		expect(decision.action).toBe("skip");
	});

	it("does not spend while a healthy account sits idle", () => {
		// Spending here is worse than not spending.
		const decision = decideRedeem("yes", stuck({ alternativeAccountAvailable: true }));
		expect(decision.action).toBe("skip");
		expect(decision.action === "skip" && decision.reason).toContain("another account");
	});

	it("does not spend when no credit is available", () => {
		const decision = decideRedeem("yes", stuck({ credits: [credit("x", { status: "redeemed" })] }));
		expect(decision.action).toBe("skip");
	});

	it("skips everything when the policy is no", () => {
		// `no` disables both the rescue and the salvage, so it is checked first and
		// reports as a policy rather than as a missing credit.
		const decision = decideRedeem("no", stuck());
		expect(decision.action).toBe("skip");
		expect(decision.action === "skip" && decision.reason).toContain("disabled");
	});
});

describe("unset asks once rather than on every spend", () => {
	it("asks on the first spend", () => {
		const decision = decideRedeem("unset", stuck());
		expect(decision.action).toBe("ask");
	});

	it("asks for the same credit it would have spent", () => {
		// The ask has to name the credit, or a user who says yes spends whichever one
		// the caller picked afterwards - possibly a different, better-preserved one.
		const decision = decideRedeem(
			"unset",
			stuck({ credits: [credit("late", { expiresAt: hours(72) }), credit("soon", { expiresAt: hours(1) })] }),
		);
		expect(decision.action === "ask" && decision.credit.id).toBe("soon");
	});

	it("recognises which policies have been answered", () => {
		expect(isAnswered("unset")).toBe(false);
		expect(isAnswered("yes")).toBe(true);
		expect(isAnswered("no")).toBe(true);
	});
});

describe("salvage is separate from rescue", () => {
	it("finds credits about to expire, soonest first", () => {
		// A credit nobody needs can still be worth spending before it lapses.
		// Both inside the 48-hour horizon, with the sooner one first.
		const expiring = creditsExpiringWithin(
			[credit("later", { expiresAt: hours(24) }), credit("soon", { expiresAt: hours(2) })],
			NOW,
			48 * 3_600_000,
		);
		expect(expiring.map((entry) => entry.id)).toEqual(["soon", "later"]);
	});

	it("excludes credits beyond the horizon", () => {
		expect(creditsExpiringWithin([credit("far", { expiresAt: hours(100) })], NOW, 24 * 3_600_000)).toHaveLength(0);
	});

	it("excludes credits that have already expired", () => {
		expect(creditsExpiringWithin([credit("past", { expiresAt: hours(-1) })], NOW, 24 * 3_600_000)).toHaveLength(0);
	});

	it("excludes an undated credit, which has no horizon to compare against", () => {
		expect(creditsExpiringWithin([credit("undated", { expiresAt: undefined })], NOW, 24 * 3_600_000)).toHaveLength(0);
	});

	it("excludes a credit that is not available", () => {
		expect(
			creditsExpiringWithin([credit("spent", { status: "redeemed", expiresAt: hours(1) })], NOW, 24 * 3_600_000),
		).toHaveLength(0);
	});
});

describe("the idempotency key is the mechanism", () => {
	it("produces a distinct id per call by default", () => {
		// A caller that regenerates it per retry has built a double-spend, and no
		// check at this layer can catch it.
		expect(mintRedeemRequestId()).not.toBe(mintRedeemRequestId());
	});

	it("accepts a seeded generator, so a test can pin it", () => {
		expect(mintRedeemRequestId(() => "fixed")).toBe("fixed");
	});
});
