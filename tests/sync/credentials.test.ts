import { expect, it, vi } from "vitest";
import {
	Credentials,
	credentialScope,
	encryptedSecretStorage,
} from "@/sync/credentials";
import { loadSettings } from "@/sync/settings";

function setup() {
	const settings = loadSettings({
		url: "https://example.test/notes/",
		username: "a",
	});
	const secrets = new Map<string, string>();
	const storage = {
		getSecret: vi.fn((name: string) => secrets.get(name) ?? null),
		setSecret: vi.fn((name: string, value: string) => {
			secrets.set(name, value);
		}),
	};
	const credentials = new Credentials(
		() => settings,
		() => storage,
	);
	const remember = () => {
		settings.passwordMode = "secret";
		settings.secretName = `vault-content-sync-${credentialScope(settings).slice(0, 24)}-${"1".repeat(20)}`;
		settings.credentialScope = credentialScope(settings);
		secrets.set(settings.secretName, "synthetic-secret");
	};
	return { settings, secrets, storage, credentials, remember };
}
it("defaults to session and never persists a plaintext password", () => {
	const s = setup();
	s.credentials.setSession("synthetic-secret");
	expect(s.credentials.read()).toBe("synthetic-secret");
	expect(
		JSON.stringify(
			loadSettings({
				...s.settings,
				password: "synthetic-secret",
				token: "synthetic-secret",
			}),
		),
	).not.toContain("synthetic-secret");
	expect(s.storage.getSecret).not.toHaveBeenCalled();
	expect(
		new Credentials(
			() => s.settings,
			() => s.storage,
		).read(),
	).toBe("");
	s.credentials.clear();
	expect(s.credentials.read()).toBe("");
});
it("loads remembered secrets on a new instance and observes rotation/deletion", () => {
	const s = setup();
	s.remember();
	const reloaded = new Credentials(
		() => loadSettings(JSON.parse(JSON.stringify(s.settings))),
		() => s.storage,
	);
	expect(reloaded.read()).toBe("synthetic-secret");
	s.secrets.set(s.settings.secretName, "rotated");
	expect(reloaded.read()).toBe("rotated");
	s.secrets.delete(s.settings.secretName);
	expect(() => reloaded.read()).toThrow("已被删除");
});
it.each(["url", "username"] as const)(
	"does not send saved or session credentials after %s changes",
	(key) => {
		const s = setup();
		s.credentials.setSession("session-secret");
		s.remember();
		s.settings[key] = key === "url" ? "https://other.test/" : "another-account";
		expect(() => s.credentials.read()).toThrow("已改变");
		expect(s.storage.getSecret).not.toHaveBeenCalled();
		s.settings.passwordMode = "session";
		expect(s.credentials.read()).toBe("");
	},
);
it("session mode does not read, modify or remove a shared stored secret", () => {
	const s = setup();
	s.remember();
	s.settings.passwordMode = "session";
	s.credentials.setSession("temporary");
	expect(s.credentials.read()).toBe("temporary");
	expect(s.storage.getSecret).not.toHaveBeenCalled();
	expect(s.secrets.get(s.settings.secretName)).toBe("synthetic-secret");
});
it("requires explicit secret selection and a matching connection binding", () => {
	const s = setup();
	s.settings.passwordMode = "secret";
	expect(() => s.credentials.read()).toThrow("已保存密码不可用");
	s.settings.secretName = "test-password";
	expect(() => s.credentials.read()).toThrow("已改变");
});
it("refuses foreign, legacy and redirected keyring references without reading them", () => {
	const s = setup();
	s.remember();
	const oldName = s.settings.secretName;
	s.settings.url = "https://other.test/";
	s.settings.credentialScope = credentialScope(s.settings);
	for (const name of [
		oldName,
		"another-plugin",
		"vault-content-sync-00000000-0000-4000-8000-000000000000",
	]) {
		s.settings.secretName = name;
		expect(() => s.credentials.read()).toThrow("重新输入密码");
	}
	s.credentials.forget(oldName);
	s.credentials.forget("another-plugin");
	expect(s.storage.getSecret).not.toHaveBeenCalled();
	expect(s.storage.setSecret).not.toHaveBeenCalled();
});
it.each([false, true])(
	"fails safely on unavailable or locked storage (%s), without echoing errors",
	(throws) => {
		const s = setup();
		s.remember();
		const c = new Credentials(
			() => s.settings,
			() =>
				throws
					? {
							getSecret: () => {
								throw Error("sensitive-path synthetic-secret");
							},
						}
					: undefined,
		);
		expect(() => c.read()).toThrow("无法读取安全保存");
		try {
			c.read();
		} catch (e) {
			expect(String(e)).not.toMatch(/synthetic-secret|sensitive-path/);
		}
	},
);
it("sanitizes untrusted persisted modes and secret references", () => {
	const s = loadSettings({
		passwordMode: "plaintext",
		secretName: "../invalid",
		credentialScope: "garbage",
	});
	expect(s.passwordMode).toBe("session");
	expect(s.secretName).toBe("");
	expect(s.credentialScope).toBe("");
});

it.each([undefined, false, true])(
	"only uses explicitly available encryption (%s)",
	(availability) => {
		const storage = {
			getSecret: vi.fn(() => "never-read"),
			...(availability === undefined
				? {}
				: { isEncryptionAvailable: () => availability }),
		};
		expect(encryptedSecretStorage(storage)).toBe(
			availability === true ? storage : undefined,
		);
		expect(storage.getSecret).not.toHaveBeenCalled();
	},
);
it("locked encryption probe fails closed without leaking host exceptions", () => {
	const storage = {
		getSecret: vi.fn(() => "secret"),
		isEncryptionAvailable: () => {
			throw Error("private host data");
		},
	};
	expect(encryptedSecretStorage(storage)).toBeUndefined();
	expect(storage.getSecret).not.toHaveBeenCalled();
});

it("one password field can remember, update and switch back to session without a selector", async () => {
	const s = setup();
	s.credentials.setSession("first");
	await s.credentials.remember(async () => {});
	expect(s.settings.passwordMode).toBe("secret");
	expect(s.settings.secretName).toMatch(/^vault-content-sync-/);
	const name = s.settings.secretName;
	expect(
		new Credentials(
			() => s.settings,
			() => s.storage,
		).read(),
	).toBe("first");
	s.credentials.setSession("edited");
	expect(s.credentials.read()).toBe("edited");
	await s.credentials.remember(async () => {});
	expect(s.settings.secretName).not.toBe(name);
	expect(s.storage.getSecret(name)).toBe("");
	const newName = s.settings.secretName;
	expect(s.storage.getSecret(newName)).toBe("edited");
	await s.credentials.useSession(async () => {});
	expect(s.settings.passwordMode).toBe("session");
	expect(s.credentials.read()).toBe("edited");
	expect(s.storage.getSecret(newName)).toBe("");
	expect(
		new Credentials(
			() => s.settings,
			() => s.storage,
		).read(),
	).toBe("");
});
it("failed or unavailable secret writes retain the entered session password", async () => {
	const s = setup();
	const c = new Credentials(
		() => s.settings,
		() => ({
			getSecret: () => null,
			setSecret: () => {
				throw Error("synthetic-private-error");
			},
		}),
	);
	c.setSession("entered");
	await expect(c.remember(async () => {})).rejects.toThrow("无法安全记住");
	expect(c.read()).toBe("entered");
	expect(s.settings.passwordMode).toBe("session");
});
it("empty input does not silently reuse the old remembered password", async () => {
	const s = setup();
	s.credentials.setSession("before");
	await s.credentials.remember(async () => {});
	s.credentials.setSession("");
	expect(s.credentials.read()).toBe("");
	await expect(s.credentials.remember(async () => {})).rejects.toThrow(
		"请先填写密码",
	);
});

it.each(["enable", "edit", "disable", "clear"])(
	"failed config save is retryable without losing the saved credential: %s",
	async (action) => {
		const s = setup();
		let disk = loadSettings(s.settings);
		const save = async (next: typeof s.settings) => {
			disk = loadSettings(next);
		};
		if (action !== "enable") {
			s.credentials.setSession("old");
			await s.credentials.remember(save);
		}
		const before = loadSettings(s.settings),
			oldName = s.settings.secretName;
		s.credentials.setSession(action === "clear" ? "" : "new");
		const enabled = action === "enable" || action === "edit";
		const change = (persist: typeof save) =>
			enabled
				? s.credentials.remember(persist)
				: s.credentials.useSession(persist);
		await expect(
			change(async () => {
				throw new Error("disk failure");
			}),
		).rejects.toThrow("disk failure");
		expect(s.settings).toEqual(before);
		expect(disk).toEqual(before);
		if (oldName) expect(s.storage.getSecret(oldName)).toBe("old");
		expect(
			new Credentials(
				() => disk,
				() => s.storage,
			).read(),
		).toBe(action === "enable" ? "" : "old");
		await change(save);
		expect(
			new Credentials(
				() => disk,
				() => s.storage,
			).read(),
		).toBe(enabled ? "new" : "");
		if (oldName) expect(s.storage.getSecret(oldName)).toBe("");
	},
);

it("typing during a pending save preserves the new draft and a later save persists it", async () => {
	const s = setup();
	let release!: () => void;
	s.credentials.setSession("first");
	const saving = s.credentials.remember(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	s.credentials.setSession("second");
	release();
	await saving;
	expect(s.credentials.read()).toBe("second");
	await s.credentials.remember(async () => {});
	expect(
		new Credentials(
			() => s.settings,
			() => s.storage,
		).read(),
	).toBe("second");
});
