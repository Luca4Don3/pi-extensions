/**
 * @lokeraar/pi-opendesign-bridge — OpenDesign provider for Pi: registration
 * + Live /models Fetch wiring.
 *
 * Installed via `pi install npm:@lokeraar/pi-opendesign-bridge`. If you also
 * keep local copies in `~/.pi/agent/extensions/opendesign*.ts`, remove them:
 * two registrations of the same provider fight over the model list.
 *
 * Two-layer catalog (design after @gtrabanco/pi-nan-provider, NO premium/tier
 * gating — the endpoint's answer for this key IS the catalog):
 *
 *   Layer 1 — curated: `~/.pi/agent/models.json` (Mode 1) or `STATIC_MODELS`
 *     (Mode 2 fallback). Authoritative for the VALUES of known models:
 *     thinking levels, `off` semantics and max output come from vendor docs +
 *     live probes — see `opendesign-live.ts` for the measured maps.
 *   Layer 2 — live: `refreshModels()` (auto-probes brand-new ids). Pi core
 *     drives it: cache-only restore on every runtime creation, network refresh
 *     on interactive startup / rpc background (unless PI_OFFLINE). Kill switch:
 *     PI_OPENDESIGN_LIVE=0.
 *
 * Registration modes:
 *   1. models.json declares `opendesign` with a non-empty model list → we
 *      register WITHOUT `models` (applyExtension would REPLACE the configured
 *      list with ours — the historical bug where startup needed a manual
 *      /model pick) but WITH refreshModels, so the live layer runs while
 *      models.json keeps owning the list.
 *   2. Fallback (models.json missing/empty) → register `STATIC_MODELS`
 *      eagerly so findInitialModel() can resolve settings.defaultModel
 *      during startup, plus refreshModels.
 *
 * Keep STATIC_MODELS in sync with models.json (both live in opendesign-live.ts
 * now, so there is a single source for the static layer). New gateway models
 * arrive through the live layer with probed values — no manual sync needed.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Kept in step with package.json by `scripts/sync-models.mjs --stamp`, because
 * a user running loose files in `~/.pi/agent/extensions` has no other way to
 * tell which build they are on — and a bug report without that is a bug report
 * we cannot act on.
 */
export const BRIDGE_VERSION = readPackageVersion() ?? "0.0.0-unknown";

/**
 * The version comes from package.json, which is the only place it is written.
 *
 * It used to be a constant next to this line, and it drifted the moment a
 * release bumped one and not the other. Two sources of truth always drift; there
 * is now one. Undefined for a loose copy in `~/.pi/agent/extensions`, which has
 * no manifest beside it.
 */
function readPackageVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version?: string };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}
import {
  readProviderConfig,
  STATIC_MODELS,
  OPENDESIGN_BASE_URL,
} from "./opendesign-live.ts";

/**
 * 本地定制：pi 1.4 下 Mode 2 的静态 models 注册未生效，改为在 models.json 中
 * 补一份 opendesign provider（幂等，保留其他 providers，写入前备份）。
 */
function ensureModelsJson(agentDir: string): void {
  const file = join(agentDir, "models.json");
  let current: Record<string, unknown> = {};
  const exists = existsSync(file);
  if (exists) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      current = parsed as Record<string, unknown>;
    } catch {
      return;
    }
  }
  const rawProviders = current.providers;
  const providers =
    rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)
      ? { ...(rawProviders as Record<string, unknown>) }
      : {};
  const existing = providers.opendesign;
  if (existing && typeof existing === "object") {
    const list = (existing as { models?: unknown }).models;
    if (Array.isArray(list) && list.length > 0) return;
  }
  providers.opendesign = {
    baseUrl: OPENDESIGN_BASE_URL,
    api: "openai-completions",
    models: STATIC_MODELS,
  };
  try {
    if (exists) {
      copyFileSync(file, `${file}.bak-opendesign-${Date.now()}`);
    }
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, providers }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // 模型列表写入失败时保持只读回退，不阻断 provider 注册。
  }
}

export default async function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  ensureModelsJson(agentDir);
  const cfg = readProviderConfig(agentDir);
  const hasModels = Array.isArray(cfg?.models) && cfg.models.length > 0;

  // Printed on every load so the number is visible in the session, not buried in
  // a file the user would have to know to open.
  console.error(`[opendesign-bridge] ${BRIDGE_VERSION} · agent dir ${agentDir}`);

  pi.registerProvider("opendesign", {
    name: `OpenDesign ${BRIDGE_VERSION}`,
    api: "openai-completions",
    authHeader: true,
    // 本地定制：pi 1.4 下 refreshModels 会清空 models.json 的模型，
    // 改为直接注册当前模型列表（models.json 优先，缺失时用 STATIC_MODELS）。
    baseUrl: cfg?.baseUrl ?? OPENDESIGN_BASE_URL,
    models: hasModels ? (cfg?.models ?? STATIC_MODELS) : STATIC_MODELS,
    // 本地定制：网页设备授权登录，一次拿到 runtime key 与额度 control key。
    oauth: {
      name: "OpenDesign (account)",
      isSubscription: true,
      async login(callbacks) {
        const device = await startOpenDesignDeviceLogin();
        callbacks.onDeviceCode({
          userCode: device.userCode,
          verificationUri: device.activationUrl,
          intervalSeconds: Math.max(1, Math.round(device.intervalMs / 1000)),
          expiresInSeconds: Math.max(
            1,
            Math.round((device.expiresAt - Date.now()) / 1000),
          ),
        });
        const grant = await pollOpenDesignDeviceLogin(device, callbacks.signal);
        // 顺带写入 usage 的额度配置；失败不影响模型登录。
        saveUsageControlKey(grant.controlKey);
        return {
          access: grant.runtimeKey,
          refresh: grant.runtimeKey,
          expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
}

// ── OpenDesign 设备授权（本地定制）─────────────────────────────────────────
// 登录入口：/login opendesign → OpenDesign (account)。
// 控制面凭据只发往 amr-api，模型 runtime key 由 pi 保存供 amr-link 使用。

const CONTROL_ORIGIN = "https://amr-api.open-design.ai";
const DEVICE_PATH = "/api/v1/cli/device-authorizations";
const ACTIVATE_ORIGIN = "https://open-design.ai";
const ACTIVATE_PATH = "/cloud/cli/activate";

interface OpenDesignDeviceAuthorization {
  activationUrl: string;
  userCode: string;
  deviceId: string;
  deviceSecret: string;
  expiresAt: number;
  intervalMs: number;
}

async function startOpenDesignDeviceLogin(): Promise<OpenDesignDeviceAuthorization> {
  const response = await fetch(`${CONTROL_ORIGIN}${DEVICE_PATH}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "pi-opendesign-bridge",
    },
    body: JSON.stringify({
      cliVersion: "0.1.4",
      host: "pi-opendesign-bridge",
      profile: "prod",
    }),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `OpenDesign device authorization returned HTTP ${response.status}.`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const activationUrl = String(body.activationUrl ?? "").trim();
  const userCode = String(body.userCode ?? "").trim();
  const deviceId = String(body.deviceId ?? "").trim();
  const deviceSecret = String(body.deviceSecret ?? "").trim();
  const url = new URL(activationUrl);
  if (
    url.origin !== ACTIVATE_ORIGIN ||
    url.pathname !== ACTIVATE_PATH ||
    url.username ||
    url.password ||
    url.hash ||
    !userCode ||
    !deviceId ||
    !deviceSecret ||
    /[\u0000-\u001f\u007f]/.test(userCode + deviceId + deviceSecret)
  ) {
    throw new Error("OpenDesign device authorization response was not trusted.");
  }
  const parsedExpiry =
    typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
  const now = Date.now();
  const expiresAt = Math.min(
    Number.isFinite(parsedExpiry) ? parsedExpiry : now + 10 * 60 * 1000,
    now + 15 * 60 * 1000,
  );
  if (expiresAt <= now) {
    throw new Error("OpenDesign authorization code already expired.");
  }
  const seconds = Number(body.pollIntervalSeconds);
  return {
    activationUrl: url.href,
    userCode,
    deviceId,
    deviceSecret,
    expiresAt,
    intervalMs:
      Number.isFinite(seconds) && seconds > 0
        ? Math.max(1000, seconds * 1000)
        : 2000,
  };
}

async function pollOpenDesignDeviceLogin(
  device: OpenDesignDeviceAuthorization,
  signal?: AbortSignal,
): Promise<{ runtimeKey: string; controlKey: string }> {
  while (Date.now() < device.expiresAt) {
    if (signal?.aborted) throw new Error("OpenDesign login was cancelled.");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(device.intervalMs, device.expiresAt - Date.now())),
    );
    if (signal?.aborted) throw new Error("OpenDesign login was cancelled.");
    const response = await fetch(
      `${CONTROL_ORIGIN}${DEVICE_PATH}/${encodeURIComponent(device.deviceId)}/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "pi-opendesign-bridge",
        },
        body: JSON.stringify({ deviceSecret: device.deviceSecret }),
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
    );
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      throw new Error("OpenDesign device authorization expired or was denied.");
    }
    if (!response.ok) continue;
    const body = (await response.json()) as Record<string, unknown>;
    const status = typeof body.status === "string" ? body.status.toLowerCase() : "";
    if (
      ["expired", "canceled", "cancelled", "denied", "rejected"].includes(status)
    ) {
      throw new Error("OpenDesign device authorization expired or was denied.");
    }
    if (status === "pending") continue;
    const user =
      body.user && typeof body.user === "object" && !Array.isArray(body.user)
        ? (body.user as Record<string, unknown>)
        : {};
    const runtimeKey = String(body.runtimeKey ?? user.runtimeKey ?? "").trim();
    const controlKey = String(body.controlKey ?? user.controlKey ?? "").trim();
    if (
      !/^sk-amr-[!-~]+$/.test(runtimeKey) ||
      !/^vela_ctrl_[!-~]+$/.test(controlKey)
    ) {
      throw new Error("OpenDesign authorization did not return valid credentials.");
    }
    return { runtimeKey, controlKey };
  }
  throw new Error(
    "OpenDesign authorization code expired; run /login opendesign again.",
  );
}

function saveUsageControlKey(controlKey: string): void {
  try {
    const file = join(getAgentDir(), "subscription-usage.json");
    let current: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // 没有配置文件或内容损坏时，从空对象开始。
    }
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, opendesignControlKey: controlKey }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // 额度配置写入失败不应让模型登录失败。
  }
}
