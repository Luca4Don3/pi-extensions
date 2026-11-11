/**
 * 按 host 注入 dispatcher。
 *
 * 这是整个扩展唯一会改变实际请求的地方，因此边界收得很紧：
 *   - 只对注册表里 mode !== "passthrough" 的 host 生效，其余原样透传；
 *   - 只注入 `dispatcher`，不改 URL、headers、body、signal 与 method；
 *   - **不重试、不重放**：非幂等请求一旦发出就不能再来一次，
 *     所以这里只做"换一条连接出口"，不承担失败恢复。
 *
 * 依赖 Pi 已经把 `globalThis.fetch` 换成 undici 的实现并支持 `dispatcher`
 * （见 Pi dist 的 `configureHttpDispatcher` + `undici.install()`）。
 * 如果那次安装没有发生，注入的 `dispatcher` 会被忽略——此时诊断命令
 * 仍然可用，只是策略不会生效，不会产生错误结果。
 */

import type { DispatcherLike, UndiciLike } from "./dispatchers.ts";
import { isActiveRoute, matchRoute, ROUTES, type HostRoute, type RouteMode } from "./hosts.ts";

/** fetch 的最小签名。 */
export type FetchLike = (
	input: unknown,
	init?: Record<string, unknown>,
) => Promise<Response>;

/** 每种模式对应的 dispatcher；缺失表示该模式不可用。 */
export interface RouteDispatchers {
	readonly "direct-v4"?: DispatcherLike;
	readonly direct?: DispatcherLike;
	readonly proxy?: DispatcherLike;
}

/** 用 Symbol 防重复安装，与 opencode-fallback 的约定一致。 */
export const ROUTER_STATE = Symbol.for("pi.net-doctor.router");

/** 从多种 fetch 入参里取出 hostname；取不到返回 undefined。 */
export function hostnameOf(input: unknown): string | undefined {
	try {
		if (typeof input === "string") return new URL(input).hostname;
		if (input instanceof URL) return input.hostname;
		if (input && typeof input === "object" && "url" in input) {
			return new URL(String((input as { url: unknown }).url)).hostname;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * 选择该 host 应使用的 dispatcher。
 *
 * 返回 undefined 表示"不干预"。passthrough、未注册、以及对应模式的
 * agent 未构造出来，都归为不干预——保持 Pi 原有行为，而不是退化成直连。
 */
export function pickDispatcher(
	hostname: string | undefined,
	dispatchers: RouteDispatchers,
	routes: readonly HostRoute[] = ROUTES,
): DispatcherLike | undefined {
	if (hostname === undefined) return undefined;
	const route = matchRoute(hostname, routes);
	if (!route || !isActiveRoute(route)) return undefined;
	return dispatchers[route.mode as Exclude<RouteMode, "passthrough">];
}

/**
 * 包装 fetch：命中策略时注入 dispatcher，否则原样透传。
 *
 * 透传用 `Reflect.apply(originalFetch, this, args)`，保留调用方给的 this
 * 与全部参数形状，避免给未命中的请求增加任何行为差异。
 */
export function createRoutedFetch(
	originalFetch: FetchLike,
	dispatchers: RouteDispatchers,
	getRoutes: () => readonly HostRoute[] = () => ROUTES,
): FetchLike {
	return function routed(
		this: unknown,
		input: unknown,
		init?: Record<string, unknown>,
	) {
		const dispatcher = pickDispatcher(hostnameOf(input), dispatchers, getRoutes());
		if (dispatcher === undefined) {
			return Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
		}
		return originalFetch(input, { ...(init ?? {}), dispatcher });
	};
}

/** 安装路由；已安装过则直接返回，避免重复包装。 */
export function installRouter(
	undici: UndiciLike,
	dispatchers: RouteDispatchers,
	routes: readonly HostRoute[] = ROUTES,
): boolean {
	const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = globalState[ROUTER_STATE] as
		| { holder: { routes: readonly HostRoute[] } }
		| undefined;

	// 已安装：只更新策略表，不再包一层 fetch。
	// 这样 `set` 之后立即生效，而不会让每次安装都套一层 wrapper。
	if (existing !== undefined) {
		existing.holder.routes = routes;
		return false;
	}

	const holder = { routes };
	const originalFetch = globalThis.fetch as unknown as FetchLike;
	const routed = createRoutedFetch(
		originalFetch.bind(globalThis) as FetchLike,
		dispatchers,
		() => holder.routes,
	);
	globalThis.fetch = routed as unknown as typeof globalThis.fetch;
	globalState[ROUTER_STATE] = { originalFetch, dispatchers, holder };
	void undici;
	return true;
}
