import type { OpenClawPluginApi } from "../api.js";

export function registerAnchorClawGatewayService(params: {
  api: OpenClawPluginApi;
  kickoffStartupBootstrap: () => void;
  startMaintenance: () => void;
  cleanupMaintenance: () => void;
}): boolean {
  const { api, kickoffStartupBootstrap, startMaintenance, cleanupMaintenance } = params;
  const registerService = (api as any)?.registerService;
  if (typeof registerService !== "function") {
    return false;
  }

  registerService({
    id: "anchorclaw-maintenance",
    start: async () => {
      kickoffStartupBootstrap();
      startMaintenance();
    },
    stop: async () => {
      cleanupMaintenance();
    },
  });
  return true;
}
