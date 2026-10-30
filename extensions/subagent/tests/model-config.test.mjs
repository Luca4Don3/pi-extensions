import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));

// 在内存中加载实际源码；测试不需要安装依赖、启动子进程或调用模型。
function source(name) {
	return fs.readFileSync(path.join(root, name), "utf8")
		.replace(/^import[\s\S]*?;\n/gm, "")
		.replace(/^export /gm, "");
}

const policyContext = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source("model-config.ts")), policyContext);
const resolve = policyContext.resolveModelConfig;
const levels = vm.runInContext("THINKING_LEVELS", policyContext);
const parent = { model: { provider: "provider-a", id: "model-a" }, thinkingLevel: "high" };

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("模型默认继承主会话，角色仅提供保守思考等级", () => {
	assert.deepEqual(plain(resolve(parent, {}, "scout")), { model: "provider-a/model-a", thinkingLevel: "low" });
	assert.deepEqual(plain(resolve(parent, {}, "coder")), { model: "provider-a/model-a", thinkingLevel: "medium" });
});

test("支持单次模型覆盖，不影响主会话配置", () => {
	assert.deepEqual(plain(resolve(parent, { model: "provider-b/model-b", thinking: "low" })), {
		model: "provider-b/model-b", thinkingLevel: "low",
	});
	assert.equal(parent.model.id, "model-a");
	assert.equal(parent.thinkingLevel, "high");
});

test("模型标识中的斜线被完整保留", () => {
	assert.equal(resolve({ model: { provider: "provider-a", id: "owner/model-a" }, thinkingLevel: "low" }).model,
		"provider-a/owner/model-a");
});

test("每种主会话等级下，默认值都不能超过上限", () => {
	for (const thinkingLevel of levels) {
		for (const agent of ["scout", "coder", "planner", "reviewer", "custom"]) {
			const result = resolve({ ...parent, thinkingLevel }, {}, agent);
			assert.ok(levels.indexOf(result.thinkingLevel) <= levels.indexOf(thinkingLevel));
		}
	}
});

test("显式思考等级全组合检查：越界拒绝，合法值保留", () => {
	for (const ceiling of levels) {
		for (const requested of levels) {
			const dispatch = { ...parent, thinkingLevel: ceiling };
			if (levels.indexOf(requested) > levels.indexOf(ceiling)) {
				assert.throws(() => resolve(dispatch, { thinking: requested }), /超过主代理上限/);
			} else {
				assert.equal(resolve(dispatch, { thinking: requested }).thinkingLevel, requested);
			}
		}
	}
});

test("模型后缀也受上限约束，显式等级优先于后缀", () => {
	assert.equal(resolve(parent, { model: "provider-b/model-b:low" }).thinkingLevel, "low");
	assert.throws(() => resolve(parent, { model: "provider-b/model-b:max" }), /超过主代理上限/);
	assert.equal(resolve(parent, { model: "provider-b/model-b:max", thinking: "off" }).thinkingLevel, "off");
});

test("缺少主会话模型时拒绝隐式使用子进程默认模型", () => {
	assert.throws(() => resolve({ thinkingLevel: "low" }), /没有可继承的模型/);
	assert.equal(resolve({ thinkingLevel: "low" }, { model: "provider-b/model-b" }).model, "provider-b/model-b");
});

test("空模型或不明思考等级显式失败", () => {
	assert.throws(() => resolve(parent, { model: "  " }), /不能为空/);
	assert.throws(() => resolve({ ...parent, thinkingLevel: undefined }), /无法确认/);
	assert.throws(() => resolve(parent, { thinking: "invalid" }), /不支持/);
});

/**
 * 原先的 8 项 VM 沙箱集成测试随扩展升级失效，已移除；原因记录在此以免重复踩坑：
 * 1. 新版 index.ts 改为从 ./message-output.js、./process-lifecycle.js、./concurrency.js、
 *    ./output-buffer.js、./spawn-failure.js 导入符号，并在输出路径使用 AbortController；
 *    原骨架靠正则剥掉 import 后在裸沙箱执行，这些符号与所需全局对象都不存在。
 * 2. 原用例断言 agents.ts 不读取 frontmatter.model，而仓库版 agents.ts 已支持按 agent
 *    指定模型，该断言与现行设计相反。
 * 3. 该目录下的本地副本依赖 pi 运行时提供 @earendil-works/* 包，裸 node 无法解析，
 *    因此也不能简单改用 jiti 加载替代。
 *
 * 被移除用例的意图（模型与思考等级真的传到子进程、任务级覆盖、越界早失败、宿主等级回退）
 * 由两部分覆盖：pi-extensions 仓库 extensions/subagent/tests/ 的测试覆盖新版行为，
 * 定制接线在升级时以真实 spawn 实测确认（仓库工作区 .temp/verify-args.mjs）。
 * 若要让定制获得持续回归覆盖，正解是把 model-config 定制合并进仓库并随仓库测试发布。
 */

// 仍依赖已移除 harness 的旧备份保留在同目录，确认无需回滚后再删。
