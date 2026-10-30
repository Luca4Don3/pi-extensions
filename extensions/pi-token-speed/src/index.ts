import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { CommandManager } from "./commands";
import { createSettings } from "./config/settings";
import { TokenSpeedEngine } from "./core/engine";
import { EventManager } from "./core/events";
import { Renderer } from "./ui/renderer";

export default async (pi: ExtensionAPI) => {
  const settings = createSettings();
  await settings.initialize();
  const engine = new TokenSpeedEngine(settings);
  const renderer = new Renderer(engine, settings);
  const commands = new CommandManager(renderer, engine, settings);
  const eventManager = new EventManager(engine, renderer, settings);

  // Command registration
  pi.registerCommand("tps", {
    description: "Open settings menu to configure pi-token-speed options",
    getArgumentCompletions: (prefix) => commands.getArgumentCompletions(prefix),
    handler: (args: string, ctx: ExtensionCommandContext) =>
      commands.runTps(args, ctx),
  });

  // Session lifecycle
  pi.on("session_start", async (_, ctx: ExtensionContext) => {
    await eventManager.handleSessionStart(ctx);
  });

  pi.on("session_shutdown", () => {
    eventManager.handleSessionShutdown();
  });

  // Streaming lifecycle
  pi.on("message_start", (event) => {
    eventManager.handleMessageStart(event);
  });

  pi.on("message_update", (event, ctx: ExtensionContext) => {
    eventManager.handleMessageUpdate(event, ctx);
  });

  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
    eventManager.handleAgentEnd(event, ctx);
  });
};
