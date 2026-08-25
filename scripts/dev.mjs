import { execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const clean = process.argv.includes("--clean");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function killPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts.at(-1);
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
          console.log(`Stopped stale process on port ${port} (PID ${pid})`);
        } catch {
          // already exited
        }
      }
    } else {
      execSync(`lsof -ti :${port} | xargs -r kill -9`, { stdio: "ignore" });
    }
  } catch {
    // nothing listening
  }
}

if (clean) {
  rmSync(path.join(root, ".next"), { recursive: true, force: true });
  console.log("Cleared .next cache");
}

killPort(PORT);

try {
  execSync("node scripts/seed-admin.mjs", { cwd: root, stdio: "inherit" });
} catch {
  console.warn("Warning: seed-admin failed (MongoDB may be slow or unreachable). Continuing…");
}

// Top-level routes to pre-compile once the server is up. In webpack dev mode,
// compiling a route for the first time regenerates the shared app-router runtime
// chunk, which forces every other open browser tab to full-reload (Fast Refresh
// can't hot-patch a shared runtime chunk). Warming all routes right after startup
// means the user's first real navigation to each page doesn't trigger that anymore.
const WARMUP_ROUTES = [
  "/",
  "/login",
  "/dashboard",
  "/compliance",
  "/training-matrix",
  "/induction-training-matrix",
  "/mcq-bank",
  "/lms",
  "/employees",
  "/bunny-files",
  "/test",
];

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeaderFrom(setCookieHeaders = []) {
  return setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
}

// Most protected routes (dashboard, employees, compliance, etc.) sit behind
// next-auth middleware. Warming them up with an unauthenticated request just
// hits the /login redirect — the protected page itself never gets compiled,
// so the cross-tab reload still happens on the user's first real visit.
// Sign in as the seeded admin first so warmup requests carry a real session.
async function getWarmupSessionCookie(port) {
  try {
    const csrfRes = await httpRequest({ host: "localhost", port, path: "/api/auth/csrf", method: "GET" });
    const csrfCookie = cookieHeaderFrom(
      Array.isArray(csrfRes.headers["set-cookie"]) ? csrfRes.headers["set-cookie"] : [],
    );
    const { csrfToken } = JSON.parse(csrfRes.body);

    const form = new URLSearchParams({
      csrfToken,
      username: "admin",
      password: "admin123",
      json: "true",
    }).toString();

    const loginRes = await httpRequest(
      {
        host: "localhost",
        port,
        path: "/api/auth/callback/credentials",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
          Cookie: csrfCookie,
        },
      },
      form,
    );
    const sessionCookie = cookieHeaderFrom(
      Array.isArray(loginRes.headers["set-cookie"]) ? loginRes.headers["set-cookie"] : [],
    );
    return [csrfCookie, sessionCookie].filter(Boolean).join("; ");
  } catch {
    // Seeded admin missing or auth route unavailable — fall back to unauthenticated warmup.
    return "";
  }
}

async function warmupRoutes(port) {
  const cookie = await getWarmupSessionCookie(port);
  for (const route of WARMUP_ROUTES) {
    try {
      await fetch(`http://localhost:${port}${route}`, cookie ? { headers: { Cookie: cookie } } : undefined);
    } catch {
      // ignore — route may require auth/redirect, compilation still happens
    }
  }
  console.log(
    cookie
      ? `Warmed up ${WARMUP_ROUTES.length} routes as admin (prevents cross-tab dev reloads)`
      : `Warmed up ${WARMUP_ROUTES.length} routes (unauthenticated — protected pages may still trigger a one-time cross-tab reload)`,
  );
}

// Use the Next 16 default bundler (Turbopack). Webpack's dev server recompiles
// on-demand entries by regenerating a shared runtime chunk; Fast Refresh can't
// hot-patch that, so opening a not-yet-compiled route forces a full reload in
// every other open tab. Turbopack compiles routes independently and does not
// invalidate a shared runtime chunk, so visiting a fresh route no longer reloads
// the other tabs. (Pass DEV_BUNDLER=webpack to opt back into the old behavior.)
const bundlerArgs = process.env.DEV_BUNDLER === "webpack" ? ["--webpack"] : [];
const child = spawn("npx", ["next", "dev", ...bundlerArgs, "-p", String(PORT)], {
  cwd: root,
  stdio: ["inherit", "pipe", "inherit"],
  shell: true,
});

const startMcqWorker = process.env.MCQ_WORKER !== "0";
const mcqWorker = startMcqWorker
  ? spawn("npx", ["tsx", "scripts/mcq-local-worker.ts"], {
      cwd: root,
      stdio: "inherit",
      shell: true,
      env: process.env,
    })
  : null;

if (startMcqWorker) {
  console.log("Started local Codex MCQ worker (set MCQ_WORKER=0 to disable)");
}

let warmedUp = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!warmedUp && /Ready in/.test(chunk.toString())) {
    warmedUp = true;
    void warmupRoutes(PORT);
  }
});

function shutdown(code) {
  if (mcqWorker && !mcqWorker.killed) mcqWorker.kill();
  process.exit(code ?? 0);
}

child.on("exit", (code) => shutdown(code));
mcqWorker?.on("exit", (code) => {
  if (code && code !== 0) {
    console.warn(`Local Codex MCQ worker exited (${code}). Queued production MCQs will wait until you run npm run mcq:worker`);
  }
});
