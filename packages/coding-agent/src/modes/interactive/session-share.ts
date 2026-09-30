import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import { type Container, type EditorComponent, hyperlink, type TUI } from "@earendil-works/pi-tui";
import { getAuthCredential } from "../../cli/auth-command.ts";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { findSecretLeak } from "../../core/security/secret-transform.ts";
import {
	collectEnvSecrets,
	detectSecrets,
	isRedactable,
	maskSecret,
	type SecretEntry,
	SecretRedactor,
} from "../../core/security/secrets.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";
import { decideShare, describeShare, type ShareDecision } from "../../core/share/policy.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

/** Trailing `pi.share` entry carrying the system prompt and tool schemas for the session viewer. */
export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "pi.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

/** Export the current branch with presentation metadata for Radius. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

/**
 * Masks every known secret in outbound text, irreversibly.
 *
 * The artifact is public output - an org-visible Radius upload or a gist - so it
 * gets `maskSecret`'s asterisks rather than `SecretRedactor`'s restorable
 * `$$TOKEN$$` placeholders. A placeholder map is process-local and worthless
 * once the artifact is published, whereas a mask needs no map in order to be
 * useless.
 *
 * Only *known* values are replaced. This is an exact-value pass, not a shape
 * sweep: a conversation that merely discusses what a token looks like must come
 * out of a share intact.
 */
function maskOutboundSecrets(text: string, entries: readonly SecretEntry[]): string {
	let result = text;
	// Longest first, so a secret that is a prefix of another is masked whole
	// rather than leaving a tail that no longer matches anything.
	const ordered = [...entries].sort((left, right) => right.value.length - left.value.length);
	for (const entry of ordered) {
		if (!isRedactable(entry.value) || !result.includes(entry.value)) continue;
		result = result.split(entry.value).join(maskSecret(entry.value));
	}
	return result;
}

/**
 * Masks a finished artifact in place, refusing it if a credential survived.
 *
 * The backstop covers what the mask pass could not have known about: a
 * credential that was never in the environment - one pasted into the
 * conversation, or read out of a file the session touched - is exactly the leak
 * nothing scrubbed, so the masked text is also swept for credential shapes
 * before it is allowed to leave. A failure here means the artifact is not
 * publishable.
 *
 * The backstop runs even when the mask pass changed nothing, because the case
 * that matters most is the one where there was nothing configured to mask.
 */
function prepareOutboundArtifact(filePath: string, entries: readonly SecretEntry[]): string | undefined {
	const original = fs.readFileSync(filePath, "utf8");
	const masked = maskOutboundSecrets(original, entries);
	if (findSecretLeak(masked, new SecretRedactor([...entries, ...detectSecrets(masked)]))) {
		return "This session still contains a credential that could not be redacted, so it was not shared. Nothing was uploaded.";
	}
	// Rewritten only when the pass changed something, so a clean session is not
	// written back for no reason and an export that matched no secret is
	// byte-identical to one that had secrets and hit none.
	if (masked !== original) fs.writeFileSync(filePath, masked);
	return undefined;
}

/**
 * Resolves the share policy against the session's own project.
 *
 * The session owns the secrets it may have recorded, so its project directory -
 * not the directory the command happened to be run from - is what governs.
 */
function resolveShareDecision(context: SessionShareContext): ShareDecision {
	const projectCwd = context.session.sessionManager.getCwd();
	return decideShare({
		projectCwd,
		redactSecrets: context.session.settingsManager.getSetting("share.redactSecrets")?.value !== false,
		secretsEnabled: context.session.settingsManager.getSetting("secrets.enabled")?.value !== false,
		// A session with no resolvable project has no policy of its own to apply,
		// and quietly borrowing the invoking directory's is the exact mistake this
		// exists to prevent - so a share that would have to do that is refused.
		obfuscatorAvailable: projectCwd.length > 0,
	});
}

/**
 * Share the current session through Radius, falling back to a private gist.
 *
 * This is the one place session content leaves the machine, so it is also the
 * one place outbound redaction happens: the policy is resolved here, both
 * artifacts are masked before either is uploaded, and a share that cannot be
 * redacted is refused rather than published looking safe.
 */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const decision = resolveShareDecision(context);
	if (decision.action === "refuse") {
		context.showError(`Share refused: ${decision.reason}`);
		return;
	}
	const outboundSecrets = collectEnvSecrets();

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
	const jsonlFile = path.join(tempDir, "session.jsonl");
	const htmlFile = path.join(tempDir, "session.html");

	try {
		try {
			exportSessionForShare(jsonlFile, context.session);
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		if (decision.redacted) {
			const refusal = prepareOutboundArtifact(jsonlFile, outboundSecrets);
			if (refusal) {
				context.showError(refusal);
				return;
			}
		}
		if (await tryShareViaRadius(jsonlFile, context, decision)) return;

		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				context.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		try {
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		if (decision.redacted) {
			const refusal = prepareOutboundArtifact(htmlFile, outboundSecrets);
			if (refusal) {
				context.showError(refusal);
				return;
			}
		}
		await shareViaGist(htmlFile, context, decision);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

async function tryShareViaRadius(
	tmpFile: string,
	context: SessionShareContext,
	decision: ShareDecision,
): Promise<boolean> {
	const provider = context.session.modelRuntime.getProvider("radius");
	if (!provider) return false;

	const token = getAuthCredential(
		await context.session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }),
	);
	if (!token) return false;

	const loader = new BorderedLoader(context.ui, theme, "Uploading to Radius...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();
	loader.onAbort = () => {
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const body = fs.readFileSync(tmpFile);
		const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
		url.searchParams.set("visibility", "organization");
		url.searchParams.set("title", "Pi session");
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				"Content-Length": String(body.byteLength),
			},
			body,
			signal: loader.signal,
		});
		if (loader.signal.aborted) return true;
		const json = (await response.json().catch(() => null)) as {
			artifact?: { canonical_url: string };
			error?: string;
		} | null;
		if (loader.signal.aborted) return true;
		restoreEditor(loader, context);
		if (!response.ok || !json?.artifact) {
			context.showError(
				`Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
			);
			return true;
		}
		const shareUrl = json.artifact.canonical_url;
		context.showStatus(describeShare(decision, hyperlink(shareUrl, shareUrl)).join("\n"));
		return true;
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(
				`Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		return true;
	}
}

async function shareViaGist(tmpFile: string, context: SessionShareContext, decision: ShareDecision): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let proc: ReturnType<typeof spawn> | null = null;
	loader.onAbort = () => {
		proc?.kill();
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		if (result.code !== 0) {
			context.showError(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
			return;
		}

		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			context.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		// describeShare rather than a bare URL, so a share that went out without
		// redaction says so here instead of only in the refusal it never got.
		const reported = describeShare(decision, hyperlink(previewUrl, previewUrl));
		context.showStatus(`${reported.join("\n")}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}
