import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";

/** Real mod_dav_fs, isolated configuration/document root; never starts a system service. */
export async function startApache({ authenticated = false } = {}) {
	const binary = process.env.PLAIN_HTTPD ?? "/opt/homebrew/opt/httpd/bin/httpd";
	const modules =
		process.env.PLAIN_HTTPD_MODULES ??
		"/opt/homebrew/opt/httpd/lib/httpd/modules";
	await access(binary);
	await mkdir("runtime", { recursive: true });
	const root = await mkdtemp(resolve("runtime/apache-"));
	const documentRoot = join(root, "htdocs");
	await mkdir(documentRoot);
	const credentials = authenticated
		? { username: "vcs-synthetic", password: randomUUID() }
		: {};
	if (authenticated)
		await writeFile(
			join(root, "passwords"),
			`${credentials.username}:{SHA}${createHash("sha1").update(credentials.password).digest("base64")}\n`,
			{ mode: 0o600 },
		);
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((done) => listener.close(done));
	const config = [
		`ServerRoot "${root}"`,
		`Listen 127.0.0.1:${port}`,
		"ServerName 127.0.0.1",
		`PidFile "${root}/httpd.pid"`,
		`ErrorLog "${root}/error.log"`,
		...[
			"mpm_event",
			"unixd",
			"authz_core",
			"dav",
			"dav_fs",
			"dir",
			"authn_core",
			"authn_file",
			"auth_basic",
			"authz_user",
		].map((name) => `LoadModule ${name}_module "${modules}/mod_${name}.so"`),
		`DocumentRoot "${documentRoot}"`,
		`DavLockDB "${root}/DavLock"`,
		`<Directory "${documentRoot}">`,
		...(authenticated
			? [
					"AuthType Basic",
					'AuthName "Synthetic DAV"',
					`AuthUserFile "${root}/passwords"`,
					"Require valid-user",
				]
			: ["Require all granted"]),
		"Dav On",
		"Options None",
		"AllowOverride None",
		"</Directory>",
		"",
	].join("\n");
	const configPath = join(root, "httpd.conf");
	await writeFile(configPath, config);
	const child = spawn(binary, ["-f", configPath, "-DFOREGROUND"], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let errors = "";
	child.stderr.on("data", (data) => {
		errors += data.toString();
	});
	const stop = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const done = once(child, "exit");
		child.kill("SIGTERM");
		await done;
	};
	const url = `http://127.0.0.1:${port}/`;
	try {
		for (let attempt = 0; attempt < 60; attempt++) {
			if (child.exitCode !== null) throw new Error(`Apache exited: ${errors}`);
			try {
				await fetch(url, {
					method: "OPTIONS",
					signal: AbortSignal.timeout(500),
				});
				return { url, root, documentRoot, credentials, stop };
			} catch {
				await new Promise((done) => setTimeout(done, 100));
			}
		}
		throw new Error("Isolated Apache did not start");
	} catch (error) {
		await stop();
		throw error;
	}
}
