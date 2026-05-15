import type { OpenClawPluginApi } from "../api.js";

export function registerSessionDeltaLifecycle(params: {
  api: OpenClawPluginApi;
  cleanupSessionDelta: () => void;
}) {
  const { api, cleanupSessionDelta } = params;
  const registerRuntimeLifecycle = (api as any)?.lifecycle?.registerRuntimeLifecycle;
  const registerRuntimeLifecycleCompat =
    typeof registerRuntimeLifecycle === "function"
      ? registerRuntimeLifecycle.bind((api as any).lifecycle)
      : typeof (api as any)?.registerRuntimeLifecycle === "function"
        ? (api as any).registerRuntimeLifecycle.bind(api)
        : null;
  if (typeof registerRuntimeLifecycle === "function") {
    api.logger.info("anchorclaw: runtime lifecycle API detected (api.lifecycle.registerRuntimeLifecycle)");
  } else if (typeof (api as any)?.registerRuntimeLifecycle === "function") {
    api.logger.warn(
      "anchorclaw: using legacy runtime lifecycle API (api.registerRuntimeLifecycle); host SDK appears older than grouped lifecycle surface",
    );
  } else if (!registerRuntimeLifecycleCompat) {
    const logError =
      typeof (api.logger as any)?.error === "function"
        ? (api.logger as any).error.bind(api.logger)
        : api.logger.warn.bind(api.logger);
    logError(
      "anchorclaw: no runtime lifecycle registration API available; listener cleanup on reload/disable is unavailable",
    );
  }
  if (registerRuntimeLifecycleCompat) {
    registerRuntimeLifecycleCompat({
      id: "anchorclaw-sessions-delta-listener",
      description: "Cleans up transcript update listener and pending debounce timer.",
      cleanup: async () => {
        cleanupSessionDelta();
      },
    });
  }
}
