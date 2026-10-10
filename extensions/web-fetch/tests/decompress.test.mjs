/** gzip / deflate / br 解压与超大压缩流测试：本地服务器，不访问外网。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const client = await jiti.import(fileURLToPath(new URL("../transport/http-client.ts", import.meta.url)));

async function withServer(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function localResolver(base) {
	return async (rawUrl) => {
		const url = new URL(rawUrl);
		if (url.origin !== new URL(base).origin) throw new Error("blocked");
		return { url, address: "127.0.0.1", family: 4 };
	};
}

const request = (base, path) => ({
	url: new URL(`${base}${path}`),
	target: { url: new URL(`${base}${path}`), address: "127.0.0.1", family: 4 },
	timeoutMs: 3_000,
	maxResponseBytes: 1024 * 1024,
	resolveTarget: localResolver(base),
});

test("gzip 与 deflate 响应被解压为可读正文", async () => {
	const text = "中文正文".repeat(200);
	await withServer((request, response) => {
		const encoding = new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/gzip" ? "gzip" : "deflate";
		const body = encoding === "gzip" ? gzipSync(text) : deflateSync(text);
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": encoding });
		response.end(body);
	}, async (base) => {
		for (const path of ["/gzip", "/deflate"]) {
			const result = await client.httpFetch(request(base, path));
			assert.equal(result.body, text, `${path} 应解压为原文`);
		}
	});
});

test("brotli 响应被解压", async () => {
	const text = "brotli 正文".repeat(100);
	await withServer((request, response) => {
		response.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" });
		response.end(brotliCompressSync(text));
	}, async (base) => {
		const result = await client.httpFetch(request(base, "/"));
		assert.equal(result.body, text);
	});
});

test("压缩炸弹：解压后仍受字节上限约束", async () => {
	const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x61));
	await withServer((request, response) => {
		response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
		response.end(bomb);
	}, async (base) => {
		await assert.rejects(client.httpFetch({ ...request(base, "/"), maxResponseBytes: 4096 }), (error) => {
			assert.equal(error.kind, "response_too_large");
			return true;
		});
	});
});

test("不支持的 content-encoding 按原文处理并明确失败", async () => {
	await withServer((request, response) => {
		response.writeHead(200, { "content-type": "text/plain", "content-encoding": "weird" });
		response.end("plain body");
	}, async (base) => {
		// 未声明解压方式时按原文读，读到的是可用正文而不是乱码。
		const result = await client.httpFetch(request(base, "/"));
		assert.equal(result.body, "plain body");
	});
});
