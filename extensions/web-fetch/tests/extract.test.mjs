/**
 * 正文提取测试：HTML 容器与 Markdown 结构保留、代码块、表格、中文与截断。
 * 全部在进程内完成，不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extract = await jiti.import(fileURLToPath(new URL("../extract/index.ts", import.meta.url)));

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
	assert.equal(extract.textToMarkdown("  纯文本  \n\n\n  内容  ").markdown, "纯文本\n\n内容");
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
	assert.ok(result.markdown.length <= 110);
	assert.match(result.markdown, /正文已截断/u);
});

test("空正文与全空白正文都明确失败", () => {
	assert.throws(() => extract.extractContent("   \n\n  ", "text/plain", "auto", 100), (error) => {
		assert.equal(error.kind, "extraction_failed");
		return true;
	});
});

test("实体解码覆盖命名实体与数字实体", () => {
	assert.equal(extract.decodeEntities("&lt;div&gt;&amp;&quot;x&quot;&#39;y&#x4e2d;"), '<div>&"x"\'y中');
});
