# 上游来源与改动说明

本目录是 [pi-opendesign-bridge](https://github.com/Lokeraar/pi-opendesign-bridge) 的仓库内收录版本，用于统一从本仓库安装 `opendesign` provider。

## 上游

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/Lokeraar/pi-opendesign-bridge |
| 收录版本 | 0.3.1 |
| 许可证 | MIT，版权归 Lokeraar，原文见 `LICENSE.md` |

## 本仓库改动

1. 保持上游的目录布局：`index.ts`、`opendesign-live.ts`、`donors-opendesign.ts` 原样收录，未修改逻辑。
2. 新增本目录的 `package.json`，声明 `pi.extensions: ["./index.ts"]`，使其可作为独立 Pi 包安装，同时被根 manifest 的 `extensions/*/index.ts` 自动发现。
3. 未收录上游的 `scripts/` 与 `README.md`（上游说明见其仓库）。
4. `index.ts` 新增 `/opendesign-login` 网页登录（设备授权）：展示授权链接与验证码，成功后把 runtime key 写入 `~/.pi/agent/models.json` 的 `providers.opendesign.apiKey`、把 control key 写入 `~/.pi/agent/subscription-usage.json` 供额度查询使用。pi 1.4 下不再调用 `registerProvider`（它会清空 models.json 的模型），provider 配置由 `ensureModelsJson` 维护。
5. `ensureModelsJson` 在启动时幂等补齐 `~/.pi/agent/models.json` 的 opendesign provider：优先取 `models-store.json` 中已有的 opendesign 模型，缺失时用 `STATIC_MODELS`；保留其他 providers，写入前备份。
6. **修复 `/opendesign-login` 的 signal 传参**（本地 bug，不是上游问题）：原先 `pollOpenDesignDeviceLogin(device, { signal })` 传的是包装对象，而函数签名收 `AbortSignal`。后果是 `signal?.aborted` 恒为 `undefined`（取消彻底失效），且 `{ signal: { signal: AbortSignal } }` 被交给 fetch，undici 直接抛 `TypeError`。因此该命令自 #10 起就无法完成登录。同时给两处控制面 `fetch` 补上 `AbortSignal.any([signal, AbortSignal.timeout(20_000)])`，否则控制面卡住时命令会无限挂起，连 `abort()` 也解不开。
7. **修正错误提示的命令名**：`expired; run /login opendesign again` → `/opendesign-login`。注册的命令是 `opendesign-login`；写成 `/login opendesign` 会把用户导向 Pi 内置的登录流程，那里没有 OpenDesign。
8. **`donors-opendesign.ts` 的类型收紧**：
   - `CatalogLocation.origin` 的第二个取值由西班牙语 `"la que usa Pi"` 改为 `"global install"`，与类型定义 `"pi install" | "global install"` 对齐。
   - 新增 `PartialModelEntry = Partial<ModelEntry>`，用于 `Resolved.entry` / `OverlayResult.entry` / `copyFields()`。这些入口本来只能携带 `BUNDLED_FIELDS`，`id` 由调用方提供；按完整 `ModelEntry` 声明会强迫 `{}`（“没有 catalog 认识这个模型”）表现成一个模型，也是六处 cast 的根源。
   - `thinkingLevelMap` 在 `thinkingLevelMapKey:` 协议下按字符串键读取，改为显式声明这个视图，不再依赖隐式 any。
9. `opendesign-live.ts` 的 `LiveModelConfig` 显式声明 `provenance?: ValueProvenance`。此前靠 `[key: string]: unknown` 兜底，导致 `{ ...m.provenance, maxTokens: "gateway" }` 这类展开无法通过类型检查。

> 第 6–9 条修好后，本目录已从根 `tsconfig.json` 的 `exclude` 移除，`npm run typecheck` 会检查它。此前被排除，所以上述类型错误（含第 6 条的 `TS2353`）从未被 CI 或本地校验发现。

## 与 subscription-usage 的关系

本次收录的 provider 是 `pi-subscription-usage` 读取 OpenDesign 额度与钱包余额的运行时前提：

- 模型调用使用 `amr-link.open-design.ai` 的 runtime key（由本 provider 登录后保存）
- 额度查询使用 `subscription-usage` 自己授权的 control key（`/opendesign-login`）

两者都不跨工具读取凭据。

## 同步上游

```bash
UPSTREAM=~/.pi/agent/npm/node_modules/@lokeraar/pi-opendesign-bridge
cp "$UPSTREAM/index.ts" "$UPSTREAM/opendesign-live.ts" "$UPSTREAM/donors-opendesign.ts" .
cp "$UPSTREAM/LICENSE" LICENSE.md
```

同步后检查 `git diff`，预期保留本文件、`package.json`、以及第 4–9 条列出的本地改动。注意 `cp` 会覆盖 `index.ts` / `opendesign-live.ts` / `donors-opendesign.ts`，第 6–9 条需重新施加。
