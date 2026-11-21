export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.DATASTACK_DISABLE_LISTEN === "1") {
      return;
    }

    try {
      const { SettingsManager } = await import(
        "@/core/adminSettings/settingsManager"
      );
      await SettingsManager.bootstrapMaintenanceSchedulerOnBoot();
    } catch (err: unknown) {
      console.warn(
        "[DataStack Boot] Maintenance scheduler init deferred/failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
