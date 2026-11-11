/** Narrow external values before using them as settings, JSON or stream data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dictionary<T>(): Record<string, T> {
	// This assertion describes a newly created empty container, not external data.
	return Object.create(null) as Record<string, T>;
}

export function hasErrorCode(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
}

export async function* byteChunks(stream: AsyncIterable<unknown>) {
	for await (const chunk of stream) {
		if (typeof chunk === "string") yield Buffer.from(chunk);
		else if (chunk instanceof Uint8Array) yield Buffer.from(chunk);
		else throw new Error("Expected a byte stream");
	}
}
