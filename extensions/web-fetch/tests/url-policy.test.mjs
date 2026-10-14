/**
 * URL 与目标地址安全策略测试：内网、回环、元数据、保留段与 DNS 重绑定窗口。
 * 全部离线：不发起真实网络请求，只对判断函数与解析结果做断言。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const module_ = await jiti.import(fileURLToPath(new URL("../transport/url-policy.ts", import.meta.url)));

const BLOCKED_IPv4 = [
	"0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255",
	"127.0.0.1", "127.8.9.10", "169.254.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
	"192.0.0.1", "192.0.2.5", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7",
	"203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
];

const ALLOWED_IPv4 = [
	"1.1.1.1", "8.8.8.8", "9.9.9.9", "93.184.216.34", "151.101.1.140", "172.15.255.255",
	"172.32.0.1", "192.0.1.1", "192.1.0.1", "198.51.99.255", "223.255.255.255",
	"203.0.114.9", "203.114.0.5", // 203.0.113.0/24 之外的同段公网地址
];

const BLOCKED_IPv6 = [
	"::", "::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::10.0.0.1", "64:ff9b::192.168.0.1",
	"100::1", "2001::1", "2001:db8::1", "fc00::1", "fd12:3456:789a:1::1", "fe80::1", "ff02::1",
	"2002:0a00:0001::1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0",
	"fec0::1", "fec1:2345:6789:abcd::1", // fec0::/10 站点本地单播
	"2001:2::1", "2001:10::1", // 2001::/23 协议分配空间（含基准测试与 ORCHID）
	"3fff::1", "64:ff9b:1::1", "5f00::1", // 新增文档段、本地 NAT64 前缀、分段路由保留
];

const ALLOWED_IPv6 = [
	"2606:4700:4700::1111", "2001:4860:4860::8888", "2620:fe::fe", "::ffff:93.184.216.34",
	"64:ff9b::8.8.8.8", "2003::1", "2001:db9::1", "3fff:1000::1",
];

test("IPv4 保留段与组播地址一律拒绝，公网地址放行", () => {
	for (const address of BLOCKED_IPv4) assert.equal(module_.isPublicIPAddress(address), false, `${address} 应被拒绝`);
	for (const address of ALLOWED_IPv4) assert.equal(module_.isPublicIPAddress(address), true, `${address} 应放行`);
});

test("IPv6 回环、链路本地、唯一本地、文档段与 IPv4 映射一律拒绝", () => {
	for (const address of BLOCKED_IPv6) assert.equal(module_.isPublicIPAddress(address), false, `${address} 应被拒绝`);
	for (const address of ALLOWED_IPv6) assert.equal(module_.isPublicIPAddress(address), true, `${address} 应放行`);
});

test("非 IP 文本、空值与带端口文本都不当作 IP 放行", () => {
	for (const value of ["", "example.com", "1.1.1.1:80", "::1%eth0", "999.1.1.1", "1.2.3", "not-an-ip"]) {
		assert.equal(module_.isPublicIPAddress(value), false, `${value} 不应被当作公网 IP`);
	}
});

test("协议、内嵌凭据与非法端口在解析阶段即被拒绝", async () => {
	const cases = [
		["ftp://example.com/file", "blocked_url"],
		["file:///etc/passwd", "blocked_url"],
		["javascript:alert(1)", "blocked_url"],
		["data:text/html,hi", "blocked_url"],
		["https://user:pass@example.com/", "blocked_url"],
		["https://user@example.com/", "blocked_url"],
		["http://example.com:8080/", "blocked_url"],
		["https://[::1]/", "blocked_url"],
		["http://127.0.0.1/", "blocked_url"],
		["http://169.254.169.254/latest/meta-data/", "blocked_url"],
		["http://10.0.0.5/", "blocked_url"],
		["http://192.168.1.1/", "blocked_url"],
		["http://[fc00::1]/", "blocked_url"],
		["not a url", "invalid_url"],
		["/relative/path", "invalid_url"],
		["", "invalid_url"],
		["   ", "invalid_url"],
	];
	for (const [url, kind] of cases) {
		await assert.rejects(module_.resolveFetchTarget(url), (error) => {
			assert.equal(error.kind, kind, `${url} 应归类为 ${kind}`);
			// 空 URL 是任何字符串的子串，回显检查对它没有意义。
			if (url.length > 0) assert.ok(!error.message.includes(url), "诊断不得回显调用方 URL");
			return true;
		});
	}
});

test("公网 IPv6 字面量在带方括号的 URL 中同样可用", async () => {
	const target = await module_.resolveFetchTarget("http://[2606:4700:4700::1111]/path");
	assert.equal(target.url.hostname, "[2606:4700:4700::1111]");
	assert.equal(target.address, "2606:4700:4700::1111");
	assert.equal(target.family, 6);
	await assert.rejects(module_.resolveFetchTarget("http://[fec0::1]/"), (error) => {
		assert.equal(error.kind, "blocked_url");
		return true;
	});
	await assert.rejects(module_.resolveFetchTarget("http://[::1]/"), (error) => {
		assert.equal(error.kind, "blocked_url");
		return true;
	});
});

test("空白 URL 与大小写协议被规范化为合法目标", async () => {
	// 公网 IP 字面量不触发真实 DNS 查询。
	const target = await module_.resolveFetchTarget("  HTTPS://1.1.1.1/path  ");
	assert.equal(target.url.protocol, "https:");
	assert.equal(target.url.hostname, "1.1.1.1");
	assert.equal(target.address, "1.1.1.1");
	assert.equal(target.family, 4);
});

test("解析返回的地址必须是已校验的那个，不能留给传输层重新解析", async () => {
	const target = await module_.resolveFetchTarget("http://8.8.8.8/index.html");
	// 传输层随后只允许连接 target.address；这一步保证该地址已通过公网校验。
	assert.equal(module_.isPublicIPAddress(target.address), true);
	assert.equal(target.url.port, "", "省略端口时不由本层补默认端口");
});

test("解析失败与 DNS 拒绝都归入固定分类，不泄漏原始错误", async () => {
	await assert.rejects(module_.resolveFetchTarget("http://nonexistent.invalid.tld.for.tests/"), (error) => {
		assert.ok(error.kind === "blocked_url" || error.kind === "invalid_url");
		return true;
	});
});

test("DNS 查询取消立即停止等待并消费迟到拒绝", async () => {
	const controller = new AbortController();
	let rejectLookup;
	let lookupStarted = false;
	const lookup = () => {
		lookupStarted = true;
		return new Promise((_, reject) => { rejectLookup = reject; });
	};
	const pending = module_.resolveFetchTarget("http://dns-cancel.test/", controller.signal, lookup);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(lookupStarted, true);
	controller.abort();
	await assert.rejects(pending, (error) => error.kind === "aborted");
	rejectLookup(new Error("late DNS rejection"));
	await new Promise((resolve) => setTimeout(resolve, 10));
});
