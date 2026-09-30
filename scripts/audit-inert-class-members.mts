/**
 * Reports public class members that no production file calls.
 *
 * The detector lives in `lib/inert-class-members.ts` so it can be regression
 * tested; this file is the report. Run from the repo root:
 *
 *     npx tsx scripts/audit-inert-class-members.mts
 *
 * Every hit is a candidate, not a verdict: a member reached through a value the
 * audit cannot see — an interface default, a string-keyed dispatch table — will
 * appear here while being genuinely live. The cost of a false positive is a human
 * read; the cost of a false negative is a capability that reports itself wired and
 * governs nothing.
 */

import { findInertClassMembers } from "./lib/inert-class-members.ts";

const found = findInertClassMembers(process.cwd());

const testedOnly = found.filter((member) => member.testRefs > 0);
const unmentioned = found.filter((member) => member.testRefs === 0);

console.log(`public class members with no production caller: ${found.length}`);
console.log(`  tested but never wired: ${testedOnly.length}`);
console.log(`  nothing references them at all: ${unmentioned.length}`);

for (const [heading, group] of [
	["tested but never wired (the archetype)", testedOnly],
	["no references at all", unmentioned],
] as const) {
	if (group.length === 0) continue;
	console.log(`\n=== ${heading} (${group.length}) ===`);
	const byFile = new Map<string, string[]>();
	for (const member of group) {
		const list = byFile.get(member.declaredIn) ?? [];
		list.push(`${member.owner}.${member.name}${member.testRefs > 0 ? ` [t${member.testRefs}]` : ""}`);
		byFile.set(member.declaredIn, list);
	}
	for (const [file, members] of [...byFile].sort(
		(left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
	)) {
		console.log(`  ${String(members.length).padStart(3)}  ${file}`);
		console.log(`       ${members.join(" ")}`);
	}
}