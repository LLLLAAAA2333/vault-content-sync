/** Safe, user-facing failures. Never include credentials or response bodies. */
export class AuthenticationError extends Error {
	constructor(
		message = "认证失败（HTTP 401）：用户名或密码无效，请在设置中重新输入或更新已保存密码。",
	) {
		super(message);
		this.name = "AuthenticationError";
	}
}
