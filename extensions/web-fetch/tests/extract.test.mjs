/**
 * 正文提取测试：HTML 容器与 Markdown 结构保留、代码块、表格、中文与截断。
 * 全部在进程内完成，不触网。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extract = await jiti.import(fileURLToPath(new URL("../extract/index.ts", import.meta.url)));
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const HTML = `<!doctype html>
<html>
<head>
	<title>技术文档 - 示例</title>
	<meta property="og:title" content="技术文档 - 示例" />
	<style>.a{color:red}</style>
	<script>window.alert("不应出现")</script>
</head>
<body>
	<nav>导航内容应被忽略</nav>
	<main>
		<h1>主标题</h1>
		<p>这是中文正文，包含一个 <a href="https://example.com/doc">文档链接</a>。</p>
		<h2>代码示例</h2>
		<pre><code class="language-typescript">const a: number = 1;
function b() { return a + 1; }</code></pre>
		<ul><li>第一项</li><li>第二项</li></ul>
		<table>
			<tr><th>名称</th><th>说明</th></tr>
			<tr><td>参数</td><td>必填</td></tr>
		</table>
		<p>行内代码 <code>web_fetch</code> 应保留反引号。</p>
	</main>
	<footer>页脚不应进入正文</footer>
</body>
</html>`;

test("HTML 提取：容器、标题、链接、代码块、列表与表格都保留", () => {
	const result = extract.htmlToMarkdown(HTML);
	assert.equal(result.title, "技术文档 - 示例");
	assert.match(result.markdown, /# 主标题/u);
	assert.match(result.markdown, /## 代码示例/u);
	assert.match(result.markdown, /\[文档链接\]\(https:\/\/example\.com\/doc\)/u);
	assert.match(result.markdown, /```typescript/u);
	assert.match(result.markdown, /const a: number = 1;/u);
	assert.match(result.markdown, /- 第一项/u);
	assert.match(result.markdown, /\| 名称 \| 说明 \|/u);
	assert.match(result.markdown, /`web_fetch`/u);
	assert.doesNotMatch(result.markdown, /window\.alert/u, "脚本内容不得进入正文");
	assert.doesNotMatch(result.markdown, /color:red/u, "样式内容不得进入正文");
	assert.doesNotMatch(result.markdown, /页脚/u);
});

test("合成 GitHub README 样本：代码、行内结构与相对链接均保留", async () => {
	const html = await fixture("synthetic-github-readme.html");
	const baseUrl = new URL("https://docs.example.test/guide/page.html");
	const result = extract.extractContent(html, "text/html", "auto", 10000, baseUrl);
	assert.equal(result.truncated, false);
	assert.match(result.markdown, /# 合成项目说明/u);
	assert.match(result.markdown, /\[相对文档\]\(https:\/\/docs\.example\.test\/doc\/index\.html\)/u);
	assert.match(result.markdown, /\[片段\]\(https:\/\/docs\.example\.test\/guide\/page\.html#details\)/u);
	assert.match(result.markdown, /\[协议相对链接\]\(https:\/\/cdn\.example\.test\/reference\)/u);
	assert.match(result.markdown, /\[表格链接\]\(https:\/\/docs\.example\.test\/doc\/table\.html\)/u);
	assert.match(result.markdown, /## 代码与 `<T>` \[链接\]\(https:\/\/docs\.example\.test\/doc\/index\.html\)/u);
	assert.match(result.markdown, /\| `<Item>` \|/u);
	assert.doesNotMatch(result.markdown, /\[不应成为链接\]\(javascript:/u);
	assert.ok(result.markdown.includes("<T> and `ticks`"));
	assert.ok(result.markdown.includes('    if name:\n        print(f"<{name}>")\n\n\treturn name\n\n'));
	assert.match(result.markdown, /template <typename T>/u);
	assert.match(result.markdown, /<section>\n  <item>&lt;T&gt;<\/item>/u, "实体在代码块中只解码一次");
	assert.match(result.markdown, /````text\n包含围栏：\n```示例\n仍在同一代码块\n````/u);
	assert.doesNotMatch(result.markdown, /syntheticSecret|color: red|合成导航噪声|合成页脚噪声/u);
});

test("合成嵌套文档样本：容器配对完整且正文边界保留", async () => {
	const html = await fixture("synthetic-nested-docs.html");
	const markdown = extract.htmlToMarkdown(html).markdown;
	assert.match(markdown, /# 嵌套文档标题/u);
	assert.match(markdown, /嵌套提示框中的中文内容/u);
	assert.match(markdown, /末尾正文不能被提前截断/u);
});

test("HTML text 模式保留 pre 缩进并保留块边界", () => {
	const html = "<main><p>前文</p><pre>  if ready:\n        run()\n\n\tfinish()</pre><p>后文</p></main>";
	const text = extract.extractContent(html, "text/html", "text", 1000).markdown;
	assert.match(text, /前文\n\n  if ready:\n        run\(\)\n\n\tfinish\(\)\n\n后文/u);
});

test("HTML 提取：正文容器优先于 body 回退", () => {
	const withArticle = "<html><body><article><h1>文章标题</h1><p>文章正文</p></article></body></html>";
	assert.match(extract.htmlToMarkdown(withArticle).markdown, /# 文章标题/u);
	const onlyBody = "<html><body><p>只有 body</p></body></html>";
	assert.match(extract.htmlToMarkdown(onlyBody).markdown, /只有 body/u);
});

test("HTML 提取：未找到容器时按内容兜底", () => {
	const fragment = "<p>没有 main 也没有 body</p>";
	assert.match(extract.htmlToMarkdown(fragment).markdown, /没有 main 也没有 body/u);
});

test("Markdown / 纯文本 / JSON 各有明确路径", () => {
	assert.equal(extract.markdownToMarkdown("# 标题\n\n正文").markdown, "# 标题\n\n正文");
	assert.equal(extract.markdownToMarkdown("# 标题\n\n正文").title, "标题");
	const spaced = "  纯文本  \n\n\n\t<T> 内容  ";
	assert.equal(extract.textToMarkdown(spaced).markdown, spaced);
	assert.equal(extract.markdownToMarkdown("  ```py\n    code\n\n\t<T>\n  ```  ").markdown, "  ```py\n    code\n\n\t<T>\n  ```  ");
	const json = extract.jsonToMarkdown(JSON.stringify({ title: "接口", items: [{ url: "https://example.com/a", content: "说明文字" }] }));
	assert.equal(json.title, "接口");
	assert.match(json.markdown, /- https:\/\/example\.com\/a/u);
	assert.match(json.markdown, /说明文字/u);
	assert.equal(extract.jsonToMarkdown("不是 JSON").markdown, "");
});

test("内容类型路由与不受支持类型的明确失败", () => {
	assert.equal(extract.extractContent("<p>hi</p>", "text/html; charset=utf-8", "auto", 1000).markdown, "hi");
	assert.equal(extract.extractContent("# t", "text/markdown", "auto", 1000).markdown, "# t");
	assert.equal(extract.extractContent("hello", "text/plain", "auto", 1000).markdown, "hello");
	// 空 JSON 提取不到任何文本字段，按提取失败处理，不把空正文当成功返回。
	assert.throws(() => extract.extractContent("{}", "application/json", "auto", 1000), (error) => {
		assert.equal(error.kind, "extraction_failed");
		return true;
	});
	assert.throws(() => extract.extractContent("binary", "application/octet-stream", "auto", 1000), (error) => {
		assert.equal(error.kind, "unsupported_content");
		assert.match(error.message, /内容类型/u);
		return true;
	});
});

test("text 模式只取纯文本，不保留 Markdown 标记", () => {
	const result = extract.extractContent("<main><h1>标题</h1><p>正文</p></main>", "text/html", "text", 1000);
	assert.match(result.markdown, /标题/u);
	assert.match(result.markdown, /正文/u);
	assert.doesNotMatch(result.markdown, /^#/u);
});

test("超长正文被截断并保留明确提示", () => {
	const long = "内容".repeat(2000);
	const result = extract.extractContent(long, "text/plain", "auto", 100);
	assert.ok(result.markdown.length <= 100);
	assert.equal(result.truncated, true);
	assert.match(result.markdown, /正文已截断/u);
});

test("截断精确计长、不切开代理对并闭合未完成代码围栏", () => {
	const exact = extract.extractContent("😀abc", "text/plain", "auto", "😀abc".length);
	assert.equal(exact.markdown, "😀abc");
	assert.equal(exact.truncated, false);
	const surrogate = extract.extractContent("a😀b", "text/plain", "auto", 2);
	assert.equal(surrogate.markdown.length, 2);
	assert.equal(surrogate.markdown, "a…");
	const code = extract.extractContent("```js\n" + "x".repeat(100) + "\n```", "text/markdown", "auto", 30);
	assert.ok(code.markdown.length <= 30);
	assert.equal(code.truncated, true);
	assert.match(code.markdown, /^```js\n[\s\S]*\n```\n\n（正文已截断）$/u);
});

test("空正文与全空白正文都明确失败", () => {
	assert.throws(() => extract.extractContent("   \n\n  ", "text/plain", "auto", 100), (error) => {
		assert.equal(error.kind, "extraction_failed");
		return true;
	});
});

test("实体解码覆盖命名实体与数字实体，且不会重复解码", () => {
	assert.equal(extract.decodeEntities("&lt;div&gt;&amp;&quot;x&quot;&#39;y&#x4e2d;"), '<div>&"x"\'y中');
	assert.equal(extract.decodeEntities("&amp;#60;T&amp;#62; &amp;lt;T&amp;gt;"), "&#60;T&#62; &lt;T&gt;");
});

test("代码中的替换元字符按字面恢复，不能泄露占位符", () => {
	const html = '<pre><code>const x = "$&amp; $$ $` $\' &amp;#60;T&amp;#62;";</code></pre><p><code>$&amp;</code></p>';
	const markdown = extract.htmlToMarkdown(html).markdown;
	assert.ok(markdown.includes('const x = "$& $$ $` $\' &#60;T&#62;";'));
	assert.ok(markdown.includes('`$&`'));
	assert.doesNotMatch(markdown, /webfetch-code/u);
});

test("链接地址与标签只解码一次，并阻止 Markdown 标签逃逸", () => {
	const html = '<main><p><a href="https://example.test/?q=&amp;lt;">[标签] `代码` ](javascript:fake)</a></p><p><a href="javascript:alert(1)">](javascript:伪造)</a></p><a href="/a b\nc(d)">相对链接</a></main>';
	const markdown = extract.htmlToMarkdown(html, new URL("https://example.test/base/")).markdown;
	assert.ok(markdown.includes("https://example.test/?q=&lt;"));
	assert.ok(markdown.includes("\\[标签\\] \\`代码\\` \\](javascript:fake)"));
	assert.ok(markdown.includes("\\](javascript:伪造)"));
	assert.doesNotMatch(markdown, /\[[^\]]*\]\(javascript:/u);
	assert.match(markdown, /https:\/\/example\.test\/a%20b%0Ac%28d%29/u);
});

test("大量未闭合标签与行内代码在有界进程内完成", () => {
	const modulePath = fileURLToPath(new URL("../extract/index.ts", import.meta.url));
	const script = `
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const extract = await createJiti(import.meta.url).import(process.argv.at(-1));
const count = 6000;
const divs = "<div>".repeat(count) + "尾";
assert.equal(extract.pickContainer(divs), divs);
assert.equal(extract.stripNoise("<script>".repeat(count) + "脚本").trim(), "");
extract.htmlToMarkdown("<main>" + "<pre>x".repeat(count) + "</main>");
extract.htmlToMarkdown("<main>" + "<code>x".repeat(count) + "</main>");
for (const tag of ["a", "li", "h1", "table", "title"]) extract.htmlToMarkdown("<main>" + ("<" + tag + ">x").repeat(count) + "</main>");
extract.htmlToMarkdown("<main>" + "<p".repeat(count) + "</main>");
const sparse = '<main><table><tr>' + '<td>x</td>'.repeat(count) + '</tr>' + '<tr><td>y</td></tr>'.repeat(count) + '</table></main>';
assert.ok(extract.htmlToMarkdown(sparse).markdown.length < sparse.length * 2);
const markdown = extract.htmlToMarkdown("<main>" + "<code>$&amp;</code>".repeat(count) + "</main>").markdown;
const marker = String.fromCharCode(96) + "$&" + String.fromCharCode(96);
assert.equal(markdown.split(marker).length - 1, count);
assert.doesNotMatch(markdown, /webfetch-code/u);
`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, modulePath], { encoding: "utf8", timeout: 20_000 });
	assert.equal(child.error, undefined, child.error?.message);
	assert.equal(child.status, 0, child.stderr);
});
