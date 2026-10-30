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

同步后检查 `git diff`，预期只保留本文件、`package.json` 与目录布局差异。
