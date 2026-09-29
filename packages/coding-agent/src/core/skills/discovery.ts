/**
 * Skill and command discovery: which directories a session will read.
 *
 * ## This is a trust boundary, not a feature list
 *
 * Loading a skill means executing code from a directory. A project-level
 * directory is under the control of whoever last committed to the repository,
 * which is not necessarily the person running it — so loading one is a decision
 * the user makes about a codebase they did not write.
 *
 * That asymmetry drives the whole design.
 *
 * ## User and project sources are not symmetric
 *
 * A **user** source lives in the user's own home directory, which they control
 * and can read at any time. If its per-provider flag is off but the user has
 * enabled that provider's sources more generally, the broader flag still
 * admits them.
 *
 * A **project** source gets no such fallback. `enableClaudeProject` alone
 * decides, because a repository's `.claude/commands/` is the one place where
 * "the user turned this off" and "a project ships this anyway" are otherwise
 * indistinguishable, and silently honouring the repository is how an untrusted
 * checkout gains the ability to run code.
 *
 * ## A global off beats everything
 *
 * The master `enabled` flag gates all sources before any per-provider
 * evaluation, so a user who disables skills has no discovery path regardless of
 * what the individual flags say.
 *
 * ## A managed provider is always admitted
 *
 * Some skills are shipped by the runtime rather than discovered from a
 * directory. They are not a trust question, and gating them on a discovery flag
 * would let an unrelated setting remove capability the build provides.
 */

/** Which tool's directory layout a source uses. */
export type SkillProvider = "native" | "claude" | "codex" | "agents";

/** User-controlled, or controlled by whoever committed the repository. */
export type SourceLevel = "user" | "project";

export interface SkillDiscoveryOptions {
	/** The master switch. Off means nothing is discovered. */
	readonly enabled: boolean;
	readonly enableNativeUser: boolean;
	readonly enableNativeProject: boolean;
	readonly enableClaudeUser: boolean;
	readonly enableClaudeProject: boolean;
	readonly enableCodexUser: boolean;
	readonly enableAgentsUser: boolean;
	readonly enableAgentsProject: boolean;
	/**
	 * Whether a provider's user sources are enabled more generally, consulted only
	 * for a user-level per-provider flag that is off.
	 */
	readonly isUserSourceEnabled: (provider: SkillProvider) => boolean;
	/** A provider the runtime ships rather than discovers. */
	readonly managedProviderId?: string;
}

/**
 * Whether one source is admitted.
 *
 * The asymmetry is the point: only user-level flags consult the broader setting.
 */
export function isSourceAdmitted(provider: SkillProvider, level: SourceLevel, options: SkillDiscoveryOptions): boolean {
	// The master switch gates everything before any per-provider evaluation, so
	// disabling skills leaves no discovery path at all.
	if (!options.enabled) return false;
	// A managed provider is shipped by the runtime rather than discovered, so it is
	// not a trust question and an unrelated flag must not remove it.
	if (options.managedProviderId !== undefined && provider === options.managedProviderId) return true;
	if (provider === "native" && level === "user") return options.enableNativeUser;
	if (provider === "native" && level === "project") return options.enableNativeProject;
	if (provider === "agents" && level === "user") return options.enableAgentsUser;
	if (provider === "agents" && level === "project") return options.enableAgentsProject;
	if (provider === "codex" && level === "user") {
		// A user directory is the user's own; the broader setting may admit it even
		// when this provider's flag is off.
		return options.enableCodexUser || options.isUserSourceEnabled("codex");
	}
	if (provider === "claude" && level === "user") {
		return options.enableClaudeUser || options.isUserSourceEnabled("claude");
	}
	// A project directory gets no fallback. Otherwise "the user turned this off"
	// and "a repository ships this anyway" are indistinguishable, and honouring
	// the repository is how an untrusted checkout gains the ability to run code.
	if (provider === "claude" && level === "project") return options.enableClaudeProject;
	return false;
}

export interface DiscoveryReport {
	readonly admitted: readonly { provider: SkillProvider; level: SourceLevel }[];
	/** Sources excluded, with the rule that excluded them. */
	readonly excluded: readonly { provider: SkillProvider; level: SourceLevel; reason: string }[];
}

/** Every source and whether it is admitted, for a settings panel or a diagnostic. */
export function reportDiscovery(options: SkillDiscoveryOptions): DiscoveryReport {
	const admitted: { provider: SkillProvider; level: SourceLevel }[] = [];
	const excluded: { provider: SkillProvider; level: SourceLevel; reason: string }[] = [];
	for (const provider of ["native", "claude", "codex", "agents"] as SkillProvider[]) {
		for (const level of ["user", "project"] as SourceLevel[]) {
			if (isSourceAdmitted(provider, level, options)) admitted.push({ provider, level });
			else excluded.push({ provider, level, reason: exclusionReason(provider, level, options) });
		}
	}
	return { admitted, excluded };
}

function exclusionReason(provider: SkillProvider, level: SourceLevel, options: SkillDiscoveryOptions): string {
	if (!options.enabled) return "skill discovery is switched off";
	if (level === "project") return `project ${provider} commands are not enabled for this project`;
	return `user ${provider} commands are not enabled`;
}

/** One line for a settings hint, naming the trust consequence. */
export function describeSourceTrust(level: SourceLevel): string {
	return level === "project"
		? "Shipped by the repository, so loading it runs code whoever last committed controls."
		: "Lives in your own home directory, which you control and can read at any time.";
}
