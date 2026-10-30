import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { waitForProcess } = await jiti.import(new URL("../process-lifecycle.ts", import.meta.url).pathname);
const { LineBuffer, TailBuffer, MessageBuffer, ToolIdBuffer, OUTPUT_LIMITS: L } = await jiti.import(new URL("../output-buffer.ts", import.meta.url).pathname);
const root = resolve(".temp");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "subagent-safety-"));

function child(code) { return spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] }); }

test("真实信号退出非零并包含信号诊断", async () => {
	const proc = child('process.kill(process.pid, "SIGTERM")');
	const diagnostics = [];
	assert.notEqual(await waitForProcess(proc, undefined, undefined, (s) => diagnostics.push(s)), 0);
	assert.match(diagnostics.join(), /SIGTERM/);
});

for (const cancel of [false, true]) test(`真实后代持有管道，有界结束且取消=${cancel}`, async () => {
	const proc = child(`const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setTimeout(()=>{},1800)'],{stdio:['ignore',1,2]}); console.log(p.pid); p.unref();`);
	let pid;
	proc.stdout.on("data", (b) => { pid = Number(b.toString().trim()); });
	const controller = new AbortController();
	const diagnostics = [];
	const pending = waitForProcess(proc, controller.signal, undefined, (s) => diagnostics.push(s));
	// 立即安装拒绝处理，避免取消产生未处理拒绝。
	const outcome = pending.then((code) => ({code}), (error) => ({error}));
	try {
		await once(proc, "exit");
		if (cancel) controller.abort();
		const result = await outcome;
		if (cancel) assert.match(result.error.message, /aborted/);
		else assert.notEqual(result.code, 0);
		assert.match(diagnostics.join(), /输出不完整/);
		assert.equal(proc.stdout.destroyed, true);
	} finally {
		// 后代自行结束并验证消失，失败时也不遗留运行中的进程。
		if (pid) {
			let gone = false;
			for (let i = 0; i < 100; i++) {
				try { process.kill(pid, 0); } catch { gone = true; break; }
				await new Promise((r) => setTimeout(r, 30));
			}
			if (!gone) {
				try { process.kill(pid, "SIGKILL"); } catch {}
				assert.fail("后代未按期限退出");
			}
		}
	}
});

test("UTF-8 任意字节切分、末行与精确单行上限", () => {
	const data = Buffer.from('你好😀\n末行');
	for (let split = 0; split <= data.length; split++) {
		const lines = [];
		const buffer = new LineBuffer((s) => lines.push(s), () => assert.fail());
		buffer.write(data.subarray(0, split)); buffer.write(data.subarray(split)); buffer.end();
		assert.deepEqual(lines, ['你好😀', '末行']);
	}
	let overflow = 0; const lines = [];
	const b = new LineBuffer((s) => lines.push(s), () => overflow++);
	b.write(Buffer.alloc(L.lineBytes, 97)); b.write(Buffer.from('\n'));
	assert.equal(lines[0].length, L.lineBytes);
	b.write(Buffer.alloc(L.lineBytes + 1, 97)); b.end(); b.write(Buffer.from('x\n'));
	assert.equal(overflow, 1); assert.equal(lines.length, 1);
});

test("stderr 尾部有界、跨块中文无损且截断可见", () => {
	const b = new TailBuffer(); const data = Buffer.from('中😀');
	b.write(data.subarray(0, 2)); b.write(data.subarray(2));
	assert.equal(b.text, '中😀');
	b.write(Buffer.from('中'.repeat(L.stderrBytes))); b.end();
	assert.equal(b.truncated, true);
	assert.ok(Buffer.byteLength(b.text.split('\n')[1]) <= L.stderrBytes);
	assert.doesNotMatch(b.text, /�/);
});

test("消息数量及总字节、去重集合及单标识字节均有界", () => {
	const b = new MessageBuffer([]);
	for (let i = 0; i < L.messageCount + 10; i++) b.push({i});
	assert.equal(b.messages.length, L.messageCount); assert.equal(b.truncated, true);
	for (let i = 0; i < 10; i++) b.push({text: 'x'.repeat(400000)});
	assert.ok(b.bytes <= L.messageBytes); assert.equal(b.messages.at(-1).text.length, 400000);
	const ids = new ToolIdBuffer();
	for (let i = 0; i < L.toolIds; i++) assert.equal(ids.add(String(i)), true);
	assert.equal(ids.add('0'), true);
	assert.equal(ids.add(String(L.toolIds)), false);
	for (let i = 0; i < L.toolIds * 2; i++) assert.equal(ids.add(String(i)), false);
	assert.equal(ids.size, L.toolIds); assert.equal(ids.has('0'), true); assert.equal(ids.truncated, true);
	const longIds = new ToolIdBuffer();
	assert.equal(longIds.add('中'.repeat(Math.floor(L.toolIdBytes / 3))), true);
	assert.equal(longIds.add('中'.repeat(Math.ceil(L.toolIdBytes / 3))), false);
	assert.equal(longIds.add('new'), false);
	assert.equal(longIds.size, 1); assert.equal(longIds.truncated, true);
});

const tools = [];
const TASK_CTX = {model: {provider: 'test', id: 'test'}, thinkingLevel: 'medium'};
(await jiti.import(new URL('../index.ts', import.meta.url).pathname)).default({
	registerTool: (t) => {
		const run = t.execute.bind(t);
		t.execute = (id, params, signal, onUpdate, ctx) => run(id, params, signal, onUpdate, {...TASK_CTX, ...(ctx ?? {})});
		tools.push(t);
	},
	getThinkingLevel: () => 'medium',
});
const tool = tools[0];
mkdirSync(join(dir, '.pi', 'agents'), {recursive: true});
writeFileSync(join(dir, '.pi', 'agents', 'safety.md'), '---\nname: safety\ndescription: 测试\n---\n测试');
const params = {agent: 'safety', task: '测试', agentScope: 'project'};

// 宿主授权辅助：只在测试内显式设置，结束一律恢复原状。
const TRUST_ENV = 'PI_SUBAGENT_TRUST_PROJECT_AGENTS';
async function withHostTrust(value, fn) {
	const previous = process.env[TRUST_ENV];
	if (value === undefined) delete process.env[TRUST_ENV];
	else process.env[TRUST_ENV] = value;
	try { return await fn(); } finally {
		if (previous === undefined) delete process.env[TRUST_ENV];
		else process.env[TRUST_ENV] = previous;
	}
}

test("无 UI 的项目确认必须拒绝，单个、并行、链均不启动", async () => {
	for (const p of [params, {tasks:[{agent:'safety',task:'测试'}],agentScope:'project'}, {chain:[{agent:'safety',task:'测试'}],agentScope:'both'}]) {
		const r = await tool.execute('id', {...p,confirmProjectAgents:true}, undefined, undefined, {cwd:dir,hasUI:false});
		assert.equal(r.isError, true); assert.match(r.content[0].text, /没有可用 UI/);
		assert.deepEqual(r.details.results, []);
	}
});

test("信任边界：未授权时模型传 false，无 UI 必须拒绝且不启动", async () => {
	const r = await withHostTrust(undefined, () => tool.execute('id', {...params, confirmProjectAgents: false}, undefined, undefined, {cwd: dir, hasUI: false}));
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /没有可用 UI/);
	assert.deepEqual(r.details.results, []);
});

test("信任边界：未授权时模型传 false，有 UI 必须真的询问", async () => {
	const asked = [];
	const ui = {confirm: async (title, body) => { asked.push({title, body}); return false; }};
	const r = await withHostTrust(undefined, () => tool.execute('id', {...params, confirmProjectAgents: false}, undefined, undefined, {cwd: dir, hasUI: true, ui}));
	assert.equal(asked.length, 1, '宿主未授权时不得因参数 false 跳过确认');
	assert.match(asked[0].body, /safety/);
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /Canceled/);
	assert.deepEqual(r.details.results, []);
});

test("信任边界：宿主授权后 false 才真正跳过确认，无 UI 也执行", async () => {
	const script = join(dir, 'trust-skip.cjs');
	writeFileSync(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'授权跳过'}],usage:{input:1},stopReason:'stop'}}));`);
	const previous = process.argv[1]; process.argv[1] = script;
	const asked = [];
	const ui = {confirm: async (title, body) => { asked.push({title, body}); return true; }};
	try {
		const r = await withHostTrust('true', () => tool.execute('id', {...params, confirmProjectAgents: false}, undefined, undefined, {cwd: dir, hasUI: true, ui}));
		assert.equal(asked.length, 0, '宿主已授权时不应再询问');
		assert.notEqual(r.isError, true);
		assert.match(r.content[0].text, /授权跳过/);
		const noUi = await withHostTrust('true', () => tool.execute('id', {...params, confirmProjectAgents: false}, undefined, undefined, {cwd: dir, hasUI: false}));
		assert.notEqual(noUi.isError, true);
		assert.match(noUi.content[0].text, /授权跳过/);
	} finally { process.argv[1] = previous; }
});

test("信任边界：授权值非法时显式报错且不回显原值", async () => {
	const r = await withHostTrust('TrUe', () => tool.execute('id', {...params, confirmProjectAgents: false}, undefined, undefined, {cwd: dir, hasUI: false}));
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /PI_SUBAGENT_TRUST_PROJECT_AGENTS 必须为 true 或 false/);
	assert.doesNotMatch(r.content[0].text, /TrUe/);
	assert.deepEqual(r.details.results, []);
});

test("真实输出淘汰不重复统计用量，false 不新增信任状态", async () => {
	const script = join(dir, 'child.cjs');
	writeFileSync(script, `for(let i=0;i<300;i++) console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'中文😀'+i}],usage:{input:1,output:2},stopReason:'stop'}}));`);
	const previous = process.argv[1]; process.argv[1] = script;
	try {
		const r = await withHostTrust('true', () => tool.execute('id', {...params,confirmProjectAgents:false}, undefined, undefined, {cwd:dir,hasUI:false}));
		assert.notEqual(r.isError, true);
		assert.equal(r.details.results[0].usage.turns, 300);
		assert.equal(r.details.results[0].usage.input, 300);
		assert.equal(r.details.results[0].messagesTruncated, true);
		const denied = await tool.execute('id', params, undefined, undefined, {cwd:dir,hasUI:false});
		assert.equal(denied.isError, true);
	} finally { process.argv[1] = previous; }
});

test("仅用户来源无 UI 不受项目确认影响，真实 stderr 截断可见", async () => {
	const userDir = join(dir, 'user');
	mkdirSync(join(userDir, 'agents'), {recursive:true});
	writeFileSync(join(userDir, 'agents', 'user-safety.md'), '---\nname: user-safety\ndescription: 测试\n---\n测试');
	const script = join(dir, 'stderr.cjs');
	writeFileSync(script, `process.stderr.write('中'.repeat(65536)); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'完成'}],usage:{input:1},stopReason:'stop'}}));`);
	const previous = process.argv[1]; const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.argv[1] = script; process.env.PI_CODING_AGENT_DIR = userDir;
	try {
		const r = await tool.execute('id', {agent:'user-safety',task:'测试',agentScope:'both',confirmProjectAgents:true}, undefined, undefined, {cwd:dir,hasUI:false});
		assert.notEqual(r.isError, true);
		assert.equal(r.details.results[0].stderrTruncated, true);
		assert.match(r.details.results[0].stderr, /已截断/);
	} finally {
		process.argv[1] = previous;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	}
});

test("真实超大 stdout 单行停止子进程并显式失败", async () => {
	const script = join(dir, 'overflow.cjs');
	writeFileSync(script, `process.stdout.write('x'.repeat(1048577)); setInterval(()=>{},1000);`);
	const previous = process.argv[1]; process.argv[1] = script;
	try {
		const r = await withHostTrust('true', () => tool.execute('id', {...params,confirmProjectAgents:false}, undefined, undefined, {cwd:dir,hasUI:false}));
		assert.equal(r.isError, true); assert.match(r.content[0].text, /1048576/);
	} finally { process.argv[1] = previous; }
});

for (const source of ['message_end', 'turn_end']) {
	for (const oversized of [false, true]) test(`真实工具去重超限停止一次：${source}，超长=${oversized}`, async () => {
		const script = join(dir, `dedup-${source}-${oversized}.cjs`);
		writeFileSync(script, `
const emit = (event) => console.log(JSON.stringify(event));
const result = (id) => ({role:'toolResult',toolCallId:id,content:[{type:'text',text:'结果'}]});
const ids = Array.from({length:1025}, (_,i)=>String(i+1));
const assistant = {role:'assistant',content:[{type:'text',text:'必须保留'}],usage:{input:3,output:5},stopReason:'stop'};
if (!${oversized}) {
  for (const id of ids.slice(0,1024)) emit({type:'message_end',message:result(id)});
}
emit({type:'message_end',message:assistant});
const next = ${oversized} ? '中'.repeat(1366) : ids[1024];
if ('${source}' === 'message_end') emit({type:'message_end',message:result(next)});
else emit({type:'turn_end',toolResults:[...(${oversized} ? [] : ids.slice(0,1024).map(result)),result(next)]});
emit({type:'turn_end',toolResults:ids.map(result)});
emit({type:'message_end',message:assistant});
setInterval(()=>{},1000);
`);
		const previous = process.argv[1]; process.argv[1] = script;
		try {
			const r = await withHostTrust('true', () => tool.execute('id', {...params,confirmProjectAgents:false}, undefined, undefined, {cwd:dir,hasUI:false}));
			assert.equal(r.isError, true);
			assert.equal(r.details.results.length, 1);
			const result = r.details.results[0];
			assert.notEqual(result.exitCode, 0);
			assert.equal(result.outputTruncated, true);
			assert.equal(result.toolIdsTruncated, true);
			assert.equal(result.errorMessage.split('工具结果去重').length - 1, 1);
			assert.match(result.errorMessage, /输出及用量可能不完整/);
			assert.doesNotMatch(result.errorMessage, /stdout 单行/);
			assert.ok(result.messages.length <= L.messageCount);
			assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= L.messageBytes + L.messageCount + 1);
			assert.equal(result.messages.at(-1).content[0].text, '必须保留');
			assert.equal(result.usage.turns, 1);
			assert.equal(result.usage.input, 3);
			assert.equal(result.usage.output, 5);
		} finally { process.argv[1] = previous; }
	});
}

test('真实正常工具汇总去重且用量正确', async () => {
	const script = join(dir, 'dedup-normal.cjs');
	writeFileSync(script, `
const emit = (event) => console.log(JSON.stringify(event));
const results = Array.from({length:200}, (_,i)=>({role:'toolResult',toolCallId:String(i),content:[]}));
for (const message of results) emit({type:'message_end',message});
emit({type:'turn_end',toolResults:results});
for(let i=0;i<2;i++) emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'正常完成'}],usage:{input:3,output:5},stopReason:'stop'}});
`);
	const previous = process.argv[1]; process.argv[1] = script;
	try {
		const r = await withHostTrust('true', () => tool.execute('id', {...params,confirmProjectAgents:false}, undefined, undefined, {cwd:dir,hasUI:false}));
		assert.notEqual(r.isError, true);
		const result = r.details.results[0];
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0].content[0].text, '正常完成');
		assert.equal(result.messagesTruncated, false);
		assert.equal(result.toolIdsTruncated, false);
		assert.notEqual(result.outputTruncated, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(result.usage.input, 6);
		assert.equal(result.usage.output, 10);
	} finally { process.argv[1] = previous; }
});
