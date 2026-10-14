export function healthPayload(env: Record<string, string | undefined>) {
  return {
    ok: true,
    service: "ppec-transportation-dashboard",
    commit: env.VERCEL_GIT_COMMIT_SHA ?? "local",
    branch: env.VERCEL_GIT_COMMIT_REF ?? null,
    deploymentId: env.VERCEL_DEPLOYMENT_ID ?? null,
    environment: env.VERCEL_ENV ?? "development",
    dataClass: env.APP_DATA_CLASS ?? null,
  };
}
