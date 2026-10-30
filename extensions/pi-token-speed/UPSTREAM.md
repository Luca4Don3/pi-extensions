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

## 同步上游

```bash
UPSTREAM=~/.pi/agent/git/github.com/gsanhueza/pi-token-speed
rsync -a --delete --exclude tests --exclude node_modules \
  --exclude package-lock.json --exclude .git \
  "$UPSTREAM/src/" extensions/pi-token-speed/src/
```

同步后检查 `git diff`，预期只保留本文件与入口文件的差异。
