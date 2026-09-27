import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	allSettings,
	lookupSetting,
	MASKED_SETTING_VALUE,
	maskSensitiveValue,
	registerSetting,
	sensitiveSettings,
} from "../src/core/settings-registry.ts";

/**
 * Sensitive settings.
 *
 * Two claims are under test, and they are different in kind:
 *
 *  - the *stored* value is untouched, because the runtime still has to read it;
 *  - the *displayed* value is masked everywhere it would otherwise be shown.
 *
 * A redaction that rewrote storage would be a destructive change to a
 * configuration file to solve a display problem, and would break the value the
 * runtime depends on.
 */

const SECRET_VALUE = "ghp_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp0Oo";
// The registry is a module singleton, so each test registers under a distinct key.
let n = 0;
const SECRET_KEY = "testSecretCredentialValue";

describe("sensitive descriptor metadata", () => {
	it("exposes sensitive and revealLength on the descriptor", () => {
		const handle = registerSetting({
			key: SECRET_KEY,
			type: "string",
			default: "",
			sensitive: true,
			revealLength: true,
		});
		expect(handle.descriptor.sensitive).toBe(true);
		expect(handle.descriptor.revealLength).toBe(true);
	});

	it("lists sensitive settings for diagnostics", () => {
		registerSetting({ key: `${SECRET_KEY}${n++}`, type: "string", default: "", sensitive: true });
		expect(sensitiveSettings().some((handle) => handle.id === SECRET_KEY)).toBe(true);
	});

	it("treats a setting with no sensitivity flag as ordinary", () => {
		const handle = registerSetting({ key: `${SECRET_KEY}Plain${n++}`, type: "string", default: "visible" });
		expect(handle.descriptor.sensitive).toBeUndefined();
		expect(maskSensitiveValue(handle, "visible")).toBe("visible");
	});
});

describe("masking for display and serialization", () => {
	it("replaces a sensitive string with a fixed placeholder", () => {
		const handle = registerSetting({ key: `${SECRET_KEY}${n++}`, type: "string", default: "", sensitive: true });
		expect(maskSensitiveValue(handle, SECRET_VALUE)).toBe(MASKED_SETTING_VALUE);
	});

	it("does not disclose the length of the masked value", () => {
		const handle = registerSetting({ key: `${SECRET_KEY}${n++}`, type: "string", default: "", sensitive: true });
		const short = maskSensitiveValue(handle, "abc");
		const long = maskSensitiveValue(handle, `${SECRET_VALUE}${"x".repeat(500)}`);
		// Identical output regardless of input length: a length is itself a
		// disclosure, because it narrows a brute force.
		expect(short).toBe(long);
	});

	it("preserves length only when explicitly opted in", () => {
		const handle = registerSetting({
			key: `${SECRET_KEY}Len${n++}`,
			type: "string",
			default: "",
			sensitive: true,
			revealLength: true,
		});
		const masked = maskSensitiveValue(handle, "abcd") as string;
		expect(masked).toHaveLength(4);
		expect(masked).not.toContain("abcd");
	});

	it("keeps a record's shape while masking its values", () => {
		const handle = registerSetting({
			key: `${SECRET_KEY}Map${n++}`,
			type: "record",
			default: {},
			sensitive: true,
			revealLength: true,
		});
		const masked = maskSensitiveValue(handle, { a: SECRET_VALUE, b: "other" }) as Record<string, unknown>;
		expect(Object.keys(masked).sort()).toEqual(["a", "b"]);
		expect(masked.a).toBe(MASKED_SETTING_VALUE);
		expect(masked.b).toBe(MASKED_SETTING_VALUE);
	});

	it("keeps a list's size while masking its entries", () => {
		const handle = registerSetting({
			key: `${SECRET_KEY}List${n++}`,
			type: "stringList",
			default: [],
			sensitive: true,
			revealLength: true,
		});
		const masked = maskSensitiveValue(handle, ["one", "two"]) as unknown[];
		expect(masked).toHaveLength(2);
		expect(masked[0]).toBe(MASKED_SETTING_VALUE);
	});

	it("passes an unset value through unchanged", () => {
		const handle = registerSetting({ key: `${SECRET_KEY}${n++}`, type: "string", default: "", sensitive: true });
		expect(maskSensitiveValue(handle, undefined)).toBeUndefined();
		expect(maskSensitiveValue(handle, null)).toBeNull();
	});

	it("leaves an unregistered key alone", () => {
		expect(maskSensitiveValue(undefined, SECRET_VALUE)).toBe(SECRET_VALUE);
	});
});

describe("the stored value is never masked", () => {
	it("reads back exactly what was written", () => {
		const settings = SettingsManager.inMemory({});
		settings.setSetting(SECRET_KEY, SECRET_VALUE);
		// The runtime must still be able to read the real value; masking is a
		// rendering concern, not a storage one.
		expect(settings.getSetting(SECRET_KEY)?.value).toBe(SECRET_VALUE);
	});

	it("keeps the value across a reload", () => {
		const settings = SettingsManager.inMemory({});
		settings.setSetting(SECRET_KEY, SECRET_VALUE);
		return settings.reload().then(() => {
			expect(settings.getSetting(SECRET_KEY)?.value).toBe(SECRET_VALUE);
		});
	});
});

describe("project trust is unaffected by sensitive settings", () => {
	it("refuses a project write when the project is untrusted", () => {
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		registerSetting({ key: `${SECRET_KEY}${n++}`, type: "string", default: "", sensitive: true });
		expect(() => settings.setSetting(SECRET_KEY, SECRET_VALUE, "project")).toThrow(/not trusted/);
	});

	it("does not let sensitivity change which layer a value comes from", () => {
		const settings = SettingsManager.inMemory({ [SECRET_KEY]: "global-value" } as never);
		settings.setSetting(SECRET_KEY, "project-value", "project");
		// The project layer still outranks global, sensitivity notwithstanding.
		expect(settings.getSetting(SECRET_KEY)?.source).toBe("project");
		expect(settings.getSetting(SECRET_KEY)?.value).toBe("project-value");
	});
});

describe("existing model and credential authorities are untouched", () => {
	it("keeps the model-control descriptors unregistered as sensitive", () => {
		// Model controls are configuration, not credentials. Marking them sensitive
		// would hide a setting the operator needs to see and edit.
		for (const key of ["disabledProviders", "enabledModels", "modelProviderOrder", "retry.fallbackChains"]) {
			expect(lookupSetting(key)?.descriptor.sensitive).toBeUndefined();
		}
	});

	it("declares the approval and secrets settings without marking them sensitive", () => {
		for (const key of ["tools.approvalMode", "tools.approval", "secrets.enabled"]) {
			expect(lookupSetting(key)).toBeDefined();
			expect(lookupSetting(key)?.descriptor.sensitive).toBeUndefined();
		}
	});

	it("keeps the approval-mode values valid", () => {
		expect(lookupSetting("tools.approvalMode")?.descriptor.values).toEqual(["always-ask", "write", "yolo"]);
	});

	it("reads approval settings through the registry", () => {
		const settings = SettingsManager.inMemory({});
		settings.setSetting("tools.approvalMode", "always-ask");
		settings.setSetting("tools.approval", { bash: "deny" });
		expect(settings.getSetting("tools.approvalMode")?.value).toBe("always-ask");
		expect(settings.getSetting("tools.approval")?.value).toEqual({ bash: "deny" });
	});

	it("defaults redaction on and approval to yolo", () => {
		const settings = SettingsManager.inMemory({});
		// Leaving redaction off would silently ship credentials; leaving approval
		// non-yolo would break every existing session, so each takes the safe side
		// for a different reason.
		expect(settings.getSetting("secrets.enabled")?.value).toBe(true);
		expect(settings.getSetting("tools.approvalMode")?.value).toBe("yolo");
	});

	it("adds no production descriptor holding a credential", () => {
		// Sensitive metadata is a display flag on an existing descriptor, not a new
		// persistence path. Provider authentication is untouched: no descriptor
		// introduced here stores a credential, so none is marked sensitive. The
		// test-only descriptors this file registers are excluded by key prefix.
		for (const handle of allSettings()) {
			if (handle.id.startsWith(SECRET_KEY)) continue;
			expect(handle.descriptor.sensitive ?? false).toBe(false);
		}
	});
});
