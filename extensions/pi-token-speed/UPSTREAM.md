# 上游来源与改动说明

本目录是 [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) 的仓库内收录版本，用于统一从本仓库安装和更新。

## 上游

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/gsanhueza/pi-token-speed |
| 收录版本 | 0.12.0 |
| 收录提交 | 46a3dd4（chore: updated to 0.12.0） |
| 许可证 | MIT，版权归 Gabriel Sanhueza，原文见 `LICENSE.md` |

## 本仓库改动

1. 入口从上游的 `src/index.ts` 调整为 `extensions/pi-token-speed/index.ts`，仅做转发。这样 pi 的启动资源列表与 `pi config` 显示为 `pi-extensions:pi-token-speed`，而不是 `src/index.ts`。
2. `src/**` 与上游 0.12.0 保持一致，未修改任何逻辑、配置项、命令或默认值。
3. 未收录上游的 `tests/`、`package-lock.json` 与构建脚本；本目录被根 `tsconfig.json` 排除，因为上游使用 bundler 风格的无扩展名相对导入，与根配置的 NodeNext 解析不一致。运行时由 pi 的 jiti 加载，不受影响。
4. `src/core/engine.ts` 改为 step 级 decode 统计（参考 DSH）：每次 `text_start` 记录首 token 时间，`message_end` 累加 `decodeMs` 与 provider 上报的 `usage.output`；`tpsAvg` 用 `ΣdecodeTokens / (ΣdecodeMs / 1000)`，修复多轮工具调用时"本 turn 总 token / 最后一段耗时"导致的 TPS 虚高。
5. `src/core/events.ts`、`src/core/message-handlers.ts`、`src/index.ts` 增加 `message_end` 接线；`agent_end` 渲染后重置 step 累计。
6. `src/core/sliding-window.ts` 在窗口内少于 2 个事件时返回 0，避免首 token 用 100ms 下限造成的假尖峰。
7. 实时 TPS 保持滑动窗口（1 秒）+ `estimate` 计数：provider 的累计 `usage.output` 在流式中会批量跳变，直接进入窗口会虚高（实测 350–570），因此只用于 step 平均。默认 `countStrategy: "estimate"`、`useProviderTokens: false`；平均 TPS 用 step 累加的 provider output token（DSH 式）。`direct` 可在 `/tps` 菜单选择，但它统计的是 delta 数而非 token 数。


## 同步上游

```bash
UPSTREAM=~/.pi/agent/git/github.com/gsanhueza/pi-token-speed
rsync -a --delete --exclude tests --exclude node_modules \
  --exclude package-lock.json --exclude .git \
  "$UPSTREAM/src/" extensions/pi-token-speed/src/
```

同步后检查 `git diff`，预期只保留本文件与入口文件的差异。

## 兼容性验证

- 已在 Pi 1.4.0（npm `latest`）验证：`/tps` 与 `/tps overrides` 命令、状态栏渲染、`session_start` / `message_start` / `message_update` / `agent_end` 事件正常
- CI 使用 Pi `@latest`，Node 22 / 23 / 24
