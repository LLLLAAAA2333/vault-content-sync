import { createHash, randomBytes } from "node:crypto";
import { AuthenticationError } from "./auth";
import type { SyncSettings } from "./settings";

export interface SecretReader {
	getSecret(id: string): string | null;
	setSecret?(id: string, value: string): void;
}
// The installed desktop host exposes this capability probe, but the current
// public typings do not declare it. Fail closed if it is absent or not true.
function hasEncryptionProbe(
	storage: SecretReader,
): storage is SecretReader & { isEncryptionAvailable(): boolean } {
	return (
		"isEncryptionAvailable" in storage &&
		typeof storage.isEncryptionAvailable === "function"
	);
}
export function encryptedSecretStorage(
	storage: SecretReader | undefined,
): SecretReader | undefined {
	try {
		if (
			storage &&
			hasEncryptionProbe(storage) &&
			storage.isEncryptionAvailable() === true
		)
			return storage;
	} catch {
		/* Locked or unsupported keyring: session mode remains available. */
	}
	return undefined;
}
export function credentialScope(
	settings: Pick<SyncSettings, "url" | "username">,
) {
	return createHash("sha256")
		.update(JSON.stringify([settings.url, settings.username]))
		.digest("hex");
}
// The host stores the password under a connection-specific name. Editing the
// unencrypted settings cannot redirect that entry to another endpoint or user.
function secretPrefix(scope: string) {
	return `vault-content-sync-${scope.slice(0, 24)}-`;
}
function scopedSecret(name: string, scope: string) {
	return (
		name.startsWith(secretPrefix(scope)) &&
		/^[a-f0-9]{20}$/.test(name.slice(secretPrefix(scope).length))
	);
}
const legacySecret =
	/^vault-content-sync-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Session values never enter settings; remembered values are read on demand. */
export class Credentials {
	private session: string | undefined;
	private sessionScope = "";
	private revision = 0;
	constructor(
		private settings: () => SyncSettings,
		private storage: () => SecretReader | undefined,
	) {}
	setSession(value: string) {
		this.revision++;
		this.session = value;
		this.sessionScope = credentialScope(this.settings());
	}
	clear() {
		this.revision++;
		this.session = undefined;
		this.sessionScope = "";
	}
	/** New keys are staged; an existing saved value is never changed before config commits. */
	async remember(save: (next: SyncSettings) => Promise<void>) {
		const value = this.read();
		if (!value) throw new AuthenticationError("请先填写密码，再开启记住密码。");
		const settings = this.settings(),
			revision = this.revision;
		const oldName = settings.secretName;
		const name =
			secretPrefix(credentialScope(settings)) + randomBytes(10).toString("hex");
		try {
			const storage = this.storage();
			if (!storage?.setSecret) throw new Error("Unavailable");
			storage.setSecret(name, value);
			if (storage.getSecret(name) !== value) throw new Error("Unconfirmed");
		} catch {
			this.forget(name);
			throw new AuthenticationError(
				"无法安全记住密码，本次密码仍可使用。请检查系统凭据存储后重试。",
			);
		}
		const next: SyncSettings = {
			...settings,
			secretName: name,
			credentialScope: credentialScope(settings),
			passwordMode: "secret",
		};
		try {
			await save(next);
		} catch (error) {
			this.forget(name);
			throw error;
		}
		Object.assign(settings, next);
		if (revision === this.revision) this.clear();
		this.forget(oldName);
	}
	async useSession(save: (next: SyncSettings) => Promise<void>) {
		let value = "";
		try {
			value = this.read();
		} catch {
			/* Opt out even when storage is unavailable. */
		}
		const settings = this.settings(),
			revision = this.revision,
			oldName = settings.secretName;
		const next: SyncSettings = {
			...settings,
			passwordMode: "session",
			secretName: "",
			credentialScope: "",
		};
		await save(next);
		Object.assign(settings, next);
		if (revision === this.revision) this.setSession(value);
		this.forget(oldName);
	}
	forget(name: string, scope = credentialScope(this.settings())) {
		if (!scopedSecret(name, scope) && !legacySecret.test(name)) return;
		try {
			this.storage()?.setSecret?.(name, "");
		} catch {
			/* A committed config no longer references an inaccessible old key. */
		}
	}

	read(): string {
		const settings = this.settings();
		if (
			this.session !== undefined &&
			this.sessionScope === credentialScope(settings)
		)
			return this.session;
		if (settings.passwordMode === "session") return "";
		if (!settings.secretName)
			throw new AuthenticationError(
				"已保存密码不可用，请在设置中重新填写密码。",
			);
		if (settings.credentialScope !== credentialScope(settings))
			throw new AuthenticationError("服务器或用户名已改变，请重新填写密码。");
		if (!scopedSecret(settings.secretName, credentialScope(settings)))
			throw new AuthenticationError(
				"请核对 WebDAV 地址并重新输入密码，以绑定此连接。",
			);
		let value: string | null | undefined;
		try {
			const storage = this.storage();
			if (!storage) throw new Error("Unavailable");
			value = storage.getSecret(settings.secretName);
		} catch {
			throw new AuthenticationError(
				"无法读取安全保存的密码，请检查系统凭据存储，或改用仅本次使用。",
			);
		}
		if (!value)
			throw new AuthenticationError(
				"已保存密码不存在或已被删除，请在设置中重新填写密码。",
			);
		return value;
	}
}
