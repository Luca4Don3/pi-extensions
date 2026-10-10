/** provider registry 的纯元数据与匿名路由目录测试。 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const registryUrl = new URL("../search/registry.ts", import.meta.url);
const jiti = createJiti(import.meta.url);
const registry = await jiti.import(fileURLToPath(registryUrl));

test("registry 只含五个 provider 的纯元数据且不声明 free-key 能力", async () => {
	assert.deepEqual(registry.PROVIDER_IDS, ["exa", "parallel", "tavily", "firecrawl", "serpapi"]);
	assert.deepEqual(registry.BILLABLE_PROVIDER_ORDER, ["exa", "tavily", "parallel", "firecrawl", "serpapi"]);
	assert.deepEqual(Object.keys(registry.PROVIDERS), [...registry.PROVIDER_IDS]);
	for (const provider of registry.PROVIDER_IDS) {
		assert.equal(registry.PROVIDERS[provider].id, provider);
		assert.ok(registry.PROVIDERS[provider].label.length > 0);
		assert.equal(registry.PROVIDERS[provider].supportedTiers.includes("free-key"), false);
		assert.equal(registry.isProviderId(provider), true);
	}
	assert.equal(registry.PROVIDERS.exa.protocol, "mcp");
	assert.equal(registry.PROVIDERS.parallel.protocol, "mcp");
	assert.equal(registry.PROVIDERS.tavily.protocol, "rest");
	assert.equal(registry.PROVIDERS.firecrawl.envVar, "FIRECRAWL_API_KEY");
	assert.deepEqual(registry.PROVIDERS.serpapi.supportedTiers, ["billable"]);
	assert.equal(registry.isProviderId("unknown"), false);

	const source = await readFile(registryUrl, "utf8");
	assert.doesNotMatch(source, /^\s*import\s+.*(?:auth|credentials)/m);
	assert.doesNotMatch(source, /process\.env|resolveBackendKey|SecretStore/u, "纯元数据目录不得读取或解析密钥");
});

test("匿名 provider 顺序唯一且与匿名能力元数据一致", () => {
	assert.deepEqual(registry.ANONYMOUS_PROVIDER_ORDER, ["exa", "tavily", "parallel", "firecrawl"]);
	for (const provider of registry.PROVIDER_IDS) {
		assert.equal(registry.hasAnonymousChannel(provider), registry.PROVIDERS[provider].supportedTiers.includes("anonymous"));
	}
	assert.deepEqual(
		registry.PROVIDER_IDS.filter((provider) => registry.hasAnonymousChannel(provider)),
		["exa", "parallel", "tavily", "firecrawl"],
	);
	assert.throws(() => registry.getProviderMetadata("secret-value"), /未知的搜索 provider/);
	assert.throws(() => registry.hasAnonymousChannel("secret-value"), /未知的搜索 provider/);
});
