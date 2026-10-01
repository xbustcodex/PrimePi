import { describe, expect, it } from "vitest";
import { SecretRedactor } from "../src/core/security/secrets.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Credentials on a human-visible surface.
 *
 * The session redacts the *outbound* projection and, deliberately, never touches
 * stored history — restoring a placeholder is how a tool receives its real argument.
 * That left a gap with a shape nothing covered: what the model *echoes back* was never
 * masked on its way to the screen. A credential the model read from a file arrived in
 * `message_update` and was rendered in full.
 *
 * These drive the real component and read what it actually renders, because the
 * defect was only observable at that boundary — the unit tests above it were green.
 */

initTheme();

const SECRET = "sk-live-ABCDEF0123456789ABCDEF0123456789";

function assistantWith(...texts: string[]) {
	return {
		role: "assistant" as const,
		content: texts.map((text) => ({ type: "text" as const, text })),
	};
}

function render(message: unknown, redactor?: SecretRedactor, width = 100): string {
	const component = new AssistantMessageComponent(
		undefined,
		false,
		getMarkdownTheme(),
		undefined,
		1,
		[],
		redactor ? (text: string) => redactor.redact(text) : undefined,
	);
	component.updateContent(message as never, false);
	return component.render(width).join("\n");
}

const redactor = () => new SecretRedactor([{ name: "TEST", value: SECRET }]);

describe("a credential echoed by the model is masked before it is rendered", () => {
	it("does not put the secret on screen", () => {
		const message = assistantWith(`I found the key: ${SECRET}`);
		// Established first: without a redactor the secret does reach the screen, so
		// this is not a test that passes because nothing was ever rendered.
		expect(render(message)).toContain(SECRET);

		const rendered = render(message, redactor());
		expect(rendered).not.toContain(SECRET);
	});

	it("still shows the surrounding text, so the message stays readable", () => {
		const rendered = render(assistantWith(`I found the key: ${SECRET} in .env`), redactor());
		expect(rendered).toContain("I found the key");
		expect(rendered).toContain("in .env");
		expect(rendered).not.toContain(SECRET);
	});

	it("masks a credential in a thinking block too", () => {
		const message = {
			role: "assistant" as const,
			content: [
				{ type: "text" as const, text: "checking" },
				{ type: "thinking" as const, thinking: `the token is ${SECRET}` },
			],
		};
		expect(render(message)).toContain(SECRET);
		expect(render(message, redactor())).not.toContain(SECRET);
	});

	it("leaves the session's own message intact", () => {
		// The tool layer and the transcript still need real values; only the rendered
		// copy is masked. A fix that mutated the message would break tool arguments.
		const message = assistantWith(`value: ${SECRET}`);
		render(message, redactor());
		expect((message.content[0] as { text: string }).text).toContain(SECRET);
	});

	it("is a no-op when the feature is off", () => {
		const message = assistantWith("nothing secret here");
		expect(render(message)).toContain("nothing secret here");
	});
});
