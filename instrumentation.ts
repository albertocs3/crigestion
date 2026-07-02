export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { readPlatformEnvironment } = await import(
      "@/modules/platform/application/environment"
    );

    readPlatformEnvironment();
  }
}
