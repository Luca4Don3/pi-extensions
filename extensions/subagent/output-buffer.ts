import { StringDecoder } from "node:string_decoder";

// 固定资源上限：字节均按 UTF-8 编码计量，不接受模型覆盖。
export const OUTPUT_LIMITS = Object.freeze({ lineBytes: 1024 * 1024, stderrBytes: 64 * 1024,
	messageCount: 256, messageBytes: 2 * 1024 * 1024, toolIds: 1024, toolIdBytes: 4096 });

export class LineBuffer {
	private decoder = new StringDecoder("utf8");
	private pending = "";
	private bytes = 0;
	private failed = false;
	constructor(private onLine: (line: string) => void, private onOverflow: () => void) {}
	write(chunk: Buffer) {
		if (this.failed) return;
		let start = 0;
		for (let i = 0; i <= chunk.length; i++) {
			if (i !== chunk.length && chunk[i] !== 10) continue;
			const part = chunk.subarray(start, i);
			this.bytes += part.length;
			if (this.bytes > OUTPUT_LIMITS.lineBytes) {
				this.failed = true;
				this.pending = "";
				this.onOverflow();
				return;
			}
			this.pending += this.decoder.write(part);
			if (i < chunk.length) {
				this.onLine(this.pending + this.decoder.end());
				this.decoder = new StringDecoder("utf8");
				this.pending = "";
				this.bytes = 0;
			}
			start = i + 1;
		}
	}
	end() {
		if (this.failed) return;
		const line = this.pending + this.decoder.end();
		this.pending = "";
		this.bytes = 0;
		if (line) this.onLine(line);
	}
}

const STDERR_MARKER = "[stderr 已截断，仅保留尾部]\n";

export class TailBuffer {
	private decoder = new StringDecoder("utf8");
	private tail = "";
	truncated = false;
	write(chunk: Buffer) { this.append(this.decoder.write(chunk)); }
	end() { this.append(this.decoder.end()); }
	private append(text: string) {
		const bytes = Buffer.from(this.tail + text);
		let start = Math.max(0, bytes.length - (OUTPUT_LIMITS.stderrBytes - Buffer.byteLength(STDERR_MARKER)));
		if (start) {
			this.truncated = true;
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		}
		this.tail = bytes.subarray(start).toString("utf8");
	}
	get text() { return (this.truncated ? STDERR_MARKER : "") + this.tail; }
}

export class MessageBuffer<T> {
	private sizes: number[] = [];
	bytes = 0;
	truncated = false;
	constructor(readonly messages: T[]) {}
	push(message: T) {
		const size = Buffer.byteLength(JSON.stringify(message));
		if (size > OUTPUT_LIMITS.messageBytes) { this.truncated = true; return; }
		this.messages.push(message);
		this.sizes.push(size);
		this.bytes += size;
		while (this.messages.length > OUTPUT_LIMITS.messageCount || this.bytes > OUTPUT_LIMITS.messageBytes) {
			this.messages.shift();
			this.bytes -= this.sizes.shift()!;
			this.truncated = true;
		}
	}
}

export class ToolIdBuffer {
	private ids = new Set<string>();
	truncated = false;
	get size() { return this.ids.size; }
	has(id: string) { return this.ids.has(id); }
	add(id: string): boolean {
		if (this.truncated) return false;
		if (Buffer.byteLength(id) > OUTPUT_LIMITS.toolIdBytes ||
			(!this.ids.has(id) && this.ids.size >= OUTPUT_LIMITS.toolIds)) {
			this.truncated = true;
			return false;
		}
		this.ids.add(id);
		return true;
	}
}
