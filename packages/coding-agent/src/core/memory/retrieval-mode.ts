/**
 * Retrieval mode: vector, lexical, or disabled.
 *
 * ## Why a mode rather than a boolean
 *
 * `noEmbeddings` is one setting, but it selects between three retrieval
 * strategies that differ in more than cost:
 *
 * - **vector** — an embedding index, semantic recall, and a dependency on the
 *   embedding endpoint being reachable.
 * - **fts** — deterministic full-text search. No embeddings, no network, and
 *   *lexical* recall: it finds the words a memory uses, not the meaning.
 * - **none** — no recall at all. A user who has decided memory should not
 *   influence the conversation gets that, rather than a worse version of
 *   getting it.
 *
 * Collapsing these into a boolean is what makes the setting unreadable: "no
 * embeddings" sounds like "cheaper", not like "recall becomes exact-match".
 *
 * ## The precedence that matters
 *
 * **An explicitly configured external endpoint is authoritative.** A role
 * selection supplies only the *managed-model* path, and must not silently
 * repoint a user who configured their own Mnemopi at a provider. A key resolver
 * fills a *missing* credential; it never overrides one that is present.
 *
 * That ordering is what stops a user's self-hosted instance from being replaced
 * by a managed one because a model role happened to resolve first.
 *
 * ## Disabling is not degrading
 *
 * Choosing `none` while a backend still holds a vector index is a real
 * consequence, so it is reported rather than hidden. A backend that cannot be
 * asked to stop retrieving is not honouring the setting.
 */

/** How retrieval happens. */
export type RetrievalMode = "vector" | "fts" | "none";

/** What the user configured. */
export interface RetrievalConfig {
	/** The documented setting: force deterministic FTS-only recall. */
	readonly noEmbeddings: boolean;
	/** An explicitly configured external endpoint, if any. */
	readonly llmBaseUrl?: string;
	readonly llmMode?: "none" | "managed" | "remote";
}

/** How retrieval is actually performed. */
export interface RetrievalPlan {
	readonly mode: RetrievalMode;
	/** The endpoint to use, when one is configured and reachable. */
	readonly endpoint?: string;
	/** Where a configured credential came from, for a settings hint. */
	readonly credentialSource?: "configured" | "resolved-from-model";
	readonly reason: string;
	/** Set when a backend cannot honour the requested mode. */
	readonly warning?: string;
}

/** Resolves the mode from the settings. */
export function resolveRetrievalMode(config: RetrievalConfig): RetrievalMode {
	// Explicitly disabling memory is distinct from retrieving it more cheaply.
	if (config.llmMode === "none") return "none";
	return config.noEmbeddings ? "fts" : "vector";
}

/**
 * Decides how retrieval will run.
 *
 * The order is the point: an explicit endpoint wins, a configured credential is
 * never overridden, and a resolved one only fills a gap.
 */
export function planRetrieval(config: RetrievalConfig, options: { readonly resolvedKey?: string } = {}): RetrievalPlan {
	const mode = resolveRetrievalMode(config);

	if (mode === "none") {
		return {
			mode,
			reason: "recall is disabled, so no memory reaches the conversation",
			...(modeIsUnsupported(config)
				? { warning: "a backend holding records cannot be asked to stop retrieving them" }
				: {}),
		};
	}

	// An explicitly configured endpoint is authoritative. Role selection supplies
	// only the managed path, and repointing a user's own instance would make the
	// setting a lie.
	if (config.llmBaseUrl && config.llmBaseUrl.trim().length > 0) {
		return {
			mode,
			endpoint: config.llmBaseUrl.trim(),
			credentialSource: "configured",
			reason: "the configured endpoint is authoritative over a managed model",
		};
	}

	if (config.llmMode === "remote" && !config.llmBaseUrl) {
		// Asked for a remote endpoint and did not supply one: that is a configuration
		// error, and silently using a local one would look like it worked.
		return {
			mode,
			credentialSource: "resolved-from-model",
			reason: "remote mode is selected but no endpoint is configured",
			warning: "remote mode without llmBaseUrl falls back to the managed model",
		};
	}

	if (options.resolvedKey) {
		// A resolver fills a *missing* credential. It never overrides one.
		return {
			mode,
			credentialSource: "resolved-from-model",
			reason: "no endpoint configured, so the managed model's credential is used",
		};
	}

	return {
		mode,
		reason:
			mode === "fts"
				? "embeddings are disabled, so recall is deterministic full-text search"
				: "no endpoint configured and no managed credential resolved",
	};
}

/** Whether a backend could be asked to stop retrieving records it already holds. */
function modeIsUnsupported(config: RetrievalConfig): boolean {
	// A local store keeps records whether or not recall is asked for, so
	// disabling only stops the *query*, not the retention.
	return config.llmMode === "none";
}

/** A one-line description for a settings hint. */
export function describeRetrievalMode(mode: RetrievalMode): string {
	switch (mode) {
		case "vector":
			return "Semantic recall through an embedding index";
		case "fts":
			return "Deterministic full-text recall; finds the words a memory uses, not the meaning";
		case "none":
			return "No recall: memory does not influence the conversation";
	}
}

/**
 * Whether a lexical result should be presented differently from a vector one.
 *
 * A full-text hit is an exact term match, and saying so prevents a model from
 * reading a lexical top hit as "the most relevant memory" when it is only the
 * most lexically similar one.
 */
export function retrievalCaveat(mode: RetrievalMode): string | undefined {
	if (mode !== "fts") return undefined;
	return "Ordered by lexical similarity, not meaning: a memory that does not use these words may still be relevant.";
}
