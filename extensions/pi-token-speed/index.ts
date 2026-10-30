/**
 * pi-token-speed 的仓库内入口。
 *
 * 实现来自上游 https://github.com/gsanhueza/pi-token-speed（MIT），
 * 详见同目录 UPSTREAM.md。此文件只负责转发上游入口，不包含逻辑改动，
 * 作用是让 pi 的启动列表与 `pi config` 以插件名显示，
 * 而不是显示上游的 `src/index.ts`。
 */
export { default } from "./src/index.ts";
