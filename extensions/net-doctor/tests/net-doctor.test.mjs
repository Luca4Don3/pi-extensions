/**
 * net-doctor 的离线测试。
 *
 * 只测纯函数与路由装配，不发起真实网络请求：
 * 这个扩展的价值在于"判断哪条路对"，判断逻辑必须可以在没有网络时验证。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const load = (name) => jiti.import(new URL(`../${name}`, import.meta.url).pathname);

const hosts = await load('hosts.ts');
const router = await load('router.ts');
const probe = await load('probe.ts');
const report = await load('report.ts');
const dispatchers = await load('dispatchers.ts');

const { normalizeHostname, matchRoute, isActiveRoute, ROUTES } = hosts;
const { hostnameOf, pickDispatcher, createRoutedFetch } = router;
const { parseColo, formatOutcome } = probe;
const { displayWidth, padDisplay, formatReport, summarize } = report;
const { resolveProxyUrl, DEFAULT_PROXY_URL } = dispatchers;

test('hostname 归一化：小写并去掉末尾点', () => {
	assert.equal(normalizeHostname('AMR-Link.Open-Design.AI.'), 'amr-link.open-design.ai');
	assert.equal(normalizeHostname('opencode.ai'), 'opencode.ai');
});

test('注册表精确匹配，不做子域通配', () => {
	assert.equal(matchRoute('amr-link.open-design.ai')?.provider, 'opendesign');
	assert.equal(matchRoute('AMR-LINK.OPEN-DESIGN.AI')?.provider, 'opendesign');
	// 子域属于不同 provider，不能被父域策略吞掉
	assert.equal(matchRoute('evil.amr-link.open-design.ai'), undefined);
	assert.equal(matchRoute('open-design.ai.evil.com'), undefined);
	assert.equal(matchRoute('unknown.example.com'), undefined);
});

test('只有非 passthrough 的路由才会被注入 dispatcher', () => {
	assert.equal(isActiveRoute(matchRoute('amr-link.open-design.ai')), true);
	assert.equal(isActiveRoute(matchRoute('opencode.ai')), false);
	// opencode 由另一个扩展接管，这里不能重复干预
	assert.equal(matchRoute('opencode.ai')?.mode, 'passthrough');
});

test('pickDispatcher：passthrough 与未注册一律不干预', () => {
	const directV4 = { id: 'v4' };
	const dispatchers = { 'direct-v4': directV4 };
	assert.equal(pickDispatcher('amr-link.open-design.ai', dispatchers), directV4);
	assert.equal(pickDispatcher('opencode.ai', dispatchers), undefined);
	assert.equal(pickDispatcher('unknown.example.com', dispatchers), undefined);
	assert.equal(pickDispatcher(undefined, dispatchers), undefined);
});

test('pickDispatcher：模式对应的 agent 缺失时不退化成其他模式', () => {
	// 缺 direct-v4 时必须返回 undefined（保持 Pi 原行为），而不是拿 direct 顶替
	assert.equal(pickDispatcher('amr-link.open-design.ai', { direct: { id: 'd' } }), undefined);
});

test('hostnameOf 支持字符串、URL 与 Request 形状', () => {
	assert.equal(hostnameOf('https://amr-link.open-design.ai/v1/chat'), 'amr-link.open-design.ai');
	assert.equal(hostnameOf(new URL('https://opencode.ai/x')), 'opencode.ai');
	assert.equal(hostnameOf({ url: 'https://api.x.ai/v1' }), 'api.x.ai');
	assert.equal(hostnameOf('not a url'), undefined);
	assert.equal(hostnameOf(undefined), undefined);
});

test('createRoutedFetch：命中注入 dispatcher，未命中完整透传', async () => {
	const calls = [];
	const original = async (input, init) => {
		calls.push({ input, init });
		return { ok: true };
	};
	const dispatcher = { id: 'v4' };
	const fetch = createRoutedFetch(original, { 'direct-v4': dispatcher });

	await fetch('https://amr-link.open-design.ai/v1/models', { method: 'POST', body: '{}' });
	assert.equal(calls[0].init.dispatcher, dispatcher);
	// 除 dispatcher 外的字段必须原样保留
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.body, '{}');

	await fetch('https://example.com/x', { method: 'GET' });
	assert.equal(calls[1].init.dispatcher, undefined);
	assert.equal(calls[1].init.method, 'GET');
});

test('createRoutedFetch：init 为 undefined 时只补 dispatcher', async () => {
	const calls = [];
	const fetch = createRoutedFetch(async (input, init) => { calls.push(init); return {}; },
		{ 'direct-v4': { id: 'v4' } });
	await fetch('https://amr-link.open-design.ai/x');
	assert.deepEqual(Object.keys(calls[0]), ['dispatcher']);
});

test('parseColo 只认行首 colo=', () => {
	assert.equal(parseColo('fl=abc\ncolo=SJC\nloc=CN\n'), 'SJC');
	assert.equal(parseColo('colo=\n'), undefined);
	assert.equal(parseColo('h=amr-link\nuag=curl\n'), undefined);
	assert.equal(parseColo(''), undefined);
});

test('formatOutcome 明确区分成功与失败', () => {
	assert.equal(formatOutcome({ mode: 'direct-v4', ok: true, ms: 718, colo: 'SJC' }), '718ms SJC');
	assert.equal(formatOutcome({ mode: 'proxy', ok: false, ms: 5000, error: 'ECONNRESET' }), '✗ ECONNRESET');
});

test('显示宽度：CJK 占两格，表格才对得齐', () => {
	assert.equal(displayWidth('abc'), 3);
	assert.equal(displayWidth('直连v4'), 6);
	assert.equal(displayWidth('代理'), 4);
	assert.equal(padDisplay('代理', 6), '代理  ');
});

test('formatReport：只输出实际测量的列', () => {
	const reports = [{
		route: matchRoute('amr-link.open-design.ai'),
		outcomes: {
			direct: { mode: 'direct', ok: true, ms: 2815, colo: 'LAX' },
			'direct-v4': { mode: 'direct-v4', ok: true, ms: 718, colo: 'SJC' },
		},
	}];
	const twoCols = formatReport(reports, ['direct', 'direct-v4']);
	assert.match(twoCols, /直连默认/);
	assert.match(twoCols, /直连v4/);
	assert.doesNotMatch(twoCols, /代理/);
	assert.match(twoCols, /2815ms LAX/);
	assert.match(twoCols, /718ms SJC/);

	const withProxy = formatReport(reports, ['direct', 'direct-v4', 'proxy']);
	assert.match(withProxy, /代理/);
	// 缺失的模式显示占位符，而不是伪造一个 0ms
	assert.match(withProxy, /- /);
});

test('summarize：策略失效必须显式告警，不能静默保留', () => {
	const notes = summarize([{
		route: matchRoute('amr-link.open-design.ai'),
		outcomes: {
			direct: { mode: 'direct', ok: true, ms: 900, colo: 'LAX' },
			'direct-v4': { mode: 'direct-v4', ok: false, ms: 6000, error: 'timeout' },
		},
	}]);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /失败/);
	assert.match(notes[0], /建议关闭/);
});

test('summarize：明显加速时给出收益结论', () => {
	const notes = summarize([{
		route: matchRoute('amr-link.open-design.ai'),
		outcomes: {
			direct: { mode: 'direct', ok: true, ms: 2815 },
			'direct-v4': { mode: 'direct-v4', ok: true, ms: 718 },
		},
	}]);
	assert.match(notes[0], /快 74%/);
});

test('summarize：变慢时建议回退', () => {
	const notes = summarize([{
		route: matchRoute('amr-link.open-design.ai'),
		outcomes: {
			direct: { mode: 'direct', ok: true, ms: 700 },
			'direct-v4': { mode: 'direct-v4', ok: true, ms: 1400 },
		},
	}]);
	assert.match(notes[0], /反而比默认慢 100%/);
	assert.match(notes[0], /回退/);
});

test('summarize：passthrough 路由不产生结论', () => {
	assert.deepEqual(summarize([{
		route: matchRoute('opencode.ai'),
		outcomes: { direct: { mode: 'direct', ok: true, ms: 100 } },
	}]), []);
});

test('resolveProxyUrl 优先级：显式 > HTTPS_PROXY > 默认', () => {
	assert.equal(resolveProxyUrl({ PI_NET_DOCTOR_PROXY: 'http://127.0.0.1:1080' }), 'http://127.0.0.1:1080');
	assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:8888' }), 'http://127.0.0.1:8888');
	assert.equal(resolveProxyUrl({}), DEFAULT_PROXY_URL);
	// 空白值视为未设置，避免把空串当代理地址
	assert.equal(resolveProxyUrl({ PI_NET_DOCTOR_PROXY: '   ', HTTPS_PROXY: 'http://p:1' }), 'http://p:1');
});

test('注册表内每个 host 都是合法 hostname，且 provider 唯一可归属', () => {
	for (const route of ROUTES) {
		assert.equal(route.host, normalizeHostname(route.host), `${route.host} 必须已归一化`);
		assert.ok(!route.host.includes('/'), `${route.host} 不能含路径`);
		assert.ok(['cloudflare', 'opaque'].includes(route.edge));
		assert.ok(['direct-v4', 'direct', 'proxy', 'passthrough'].includes(route.mode));
		// CF 前置必须有 trace 探针，否则取不到 colo
		if (route.edge === 'cloudflare') assert.equal(route.probePath, '/cdn-cgi/trace');
	}
});

// ---- 配置层：覆盖策略的持久化 ----

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = await load('config.ts');
const {
	CONFIG_FILE, isValidMode, configPath, readConfig, writeConfig,
	applyOverrides, withOverride,
} = config;

const tempDir = () => mkdtempSync(join(tmpdir(), 'net-doctor-'));

test('配置不存在时返回空覆盖', () => {
	const dir = tempDir();
	assert.deepEqual(readConfig(dir), {});
	rmSync(dir, { recursive: true, force: true });
});

test('配置写入后可读回，路径固定在 agent 目录', () => {
	const dir = tempDir();
	assert.equal(configPath(dir), join(dir, CONFIG_FILE));
	assert.equal(writeConfig(dir, { routes: { 'amr-link.open-design.ai': 'proxy' } }), true);
	assert.deepEqual(readConfig(dir), { routes: { 'amr-link.open-design.ai': 'proxy' } });
	// 文件必须是合法 JSON 且带换行，便于人工编辑
	assert.ok(readFileSync(configPath(dir), 'utf8').endsWith('\n'));
	rmSync(dir, { recursive: true, force: true });
});

test('配置损坏时按无覆盖处理，不抛错也不返回半成品', () => {
	const dir = tempDir();
	writeFileSync(configPath(dir), '{ this is not json', 'utf8');
	assert.deepEqual(readConfig(dir), {});
	writeFileSync(configPath(dir), '{"routes": 42}', 'utf8');
	assert.deepEqual(readConfig(dir), {});
	rmSync(dir, { recursive: true, force: true });
});

test('非法 mode 被丢弃，合法的保留', () => {
	const dir = tempDir();
	writeFileSync(configPath(dir), JSON.stringify({
		routes: { 'amr-link.open-design.ai': 'teleport', 'opencode.ai': 'proxy' },
	}), 'utf8');
	assert.deepEqual(readConfig(dir), { routes: { 'opencode.ai': 'proxy' } });
	rmSync(dir, { recursive: true, force: true });
});

test('applyOverrides 只覆盖注册表内已存在的 host', () => {
	const routes = [{ host: 'a.test', provider: 'p', edge: 'cloudflare', mode: 'passthrough' }];
	const out = applyOverrides(routes, { 'a.test': 'proxy', 'unknown.test': 'proxy' });
	assert.equal(out[0].mode, 'proxy');
	assert.equal(out.length, 1);
	// 不修改入参
	assert.equal(routes[0].mode, 'passthrough');
	// 无覆盖时原样返回同一引用，避免无谓分配
	assert.equal(applyOverrides(routes, {}), routes);
});

test('withOverride 在已有配置上增量写入', () => {
	const dir = tempDir();
	writeConfig(dir, { routes: { 'a.test': 'proxy' } });
	const next = withOverride(dir, 'b.test', 'direct');
	assert.deepEqual(next.routes, { 'a.test': 'proxy', 'b.test': 'direct' });
	rmSync(dir, { recursive: true, force: true });
});

test('isValidMode 只接受注册的模式', () => {
	for (const mode of ['direct-v4', 'direct', 'proxy', 'passthrough']) {
		assert.equal(isValidMode(mode), true);
	}
	for (const bad of ['', 'DISCRETE', 'direct v4', 'auto']) {
		assert.equal(isValidMode(bad), false);
	}
});
