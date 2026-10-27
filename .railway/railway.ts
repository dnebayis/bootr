import { defineRailway, postgres, project, service, volume } from "railway/iac";

// Bootr on Railway. Variables are unmanaged here (set with `railway variable set`, see
// docs/deploy/railway.md); this file owns the services, build/deploy settings and volumes. Custom domains
// are attached with `railway domain <host> --service <svc> --port <port>` (IaC cannot register them).
// Apply with `railway config plan` then `railway config apply`.

const REGION = "us-east4-eqdc4a";
const RESTART = { restartPolicyType: "ON_FAILURE" as const, restartPolicyMaxRetries: 10 };
const WORKSPACE_FILES = [
  "/package.json",
  "/pnpm-lock.yaml",
  "/pnpm-workspace.yaml",
  "/tsconfig.base.json",
  "/.dockerignore",
];

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: REGION });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 50000,
  });

  // Admin config file store for the web app (`ADMIN_CONFIG_PATH=/data/admin-config.json`).
  const webData = volume("web-data", { region: REGION, sizeMB: 1024 });

  const sender = service("sender", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/sender/Dockerfile",
      watchPatterns: ["/apps/sender/**", "/packages/agent-core/**", ...WORKSPACE_FILES],
    },
    start: "node dist/index.js",
    preDeploy: "node dist/db/migrate.js",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: { [REGION]: 1 },
    deploy: { drainingSeconds: 20, ...RESTART },
  });

  const inference = service("inference", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/inference/Dockerfile",
      watchPatterns: ["/apps/inference/**", ...WORKSPACE_FILES],
    },
    start: "node dist/main.js",
    preDeploy: "node scripts/migrate.mjs",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: { [REGION]: 1 },
    deploy: { drainingSeconds: 30, ...RESTART },
  });

  const supervisor = service("supervisor", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/supervisor/Dockerfile",
      watchPatterns: [
        "/apps/supervisor/**",
        "/apps/inference/**",
        "/packages/agent-core/**",
        "/packages/shared/**",
        ...WORKSPACE_FILES,
      ],
    },
    start: "node dist/index.js",
    preDeploy: "node dist/db/migrate.js",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    // One replica only: the tick loop must not run twice.
    replicas: { [REGION]: 1 },
    deploy: { drainingSeconds: 40, overlapSeconds: 0, ...RESTART },
  });

  const indexer = service("indexer", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/indexer/Dockerfile",
      watchPatterns: ["/apps/indexer/**", "/packages/shared/**", ...WORKSPACE_FILES],
    },
    start: "sh scripts/start.sh",
    // `/ready` only returns 200 once the backfill is complete; the old deployment keeps serving until then.
    healthcheck: "/ready",
    healthcheckTimeout: 3600,
    replicas: { [REGION]: 1 },
    deploy: { drainingSeconds: 15, ...RESTART },
  });

  const web = service("web", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/web/Dockerfile",
      watchPatterns: ["/apps/web/**", "/packages/shared/**", ...WORKSPACE_FILES],
    },
    start: "node server.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    replicas: { [REGION]: 1 },
    deploy: { drainingSeconds: 15, ...RESTART },
    volumeMounts: { "/data": webData },
  });

  return project("bootr", {
    variables: { managed: false },
    resources: [Postgres, postgresVolume, webData, sender, inference, supervisor, indexer, web],
  });
});
