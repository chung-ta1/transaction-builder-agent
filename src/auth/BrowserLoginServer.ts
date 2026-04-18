import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import open from "open";
import { assertNotProduction, type Env } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOGIN_PAGE_PATH = join(__dirname, "loginPage.html");
const DEFAULT_PORT = Number(process.env.TRANSACTION_AGENT_LOGIN_PORT) || 0;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginResult {
  env: Env;
  accessToken: string;
  email?: string;
  /**
   * Whether to persist the token to the OS keychain across MCP restarts.
   * Defaults to true. The login page sends `false` when the user unchecks
   * "Remember me on this device" — useful for shared machines where the
   * token should only live in the MCP's in-memory cache.
   */
  remember?: boolean;
}

/**
 * Spins up a loopback HTTP server that serves the login page, opens the user's
 * browser, and captures the access token the page POSTs back. Resolves with
 * the token or rejects on timeout/failure.
 */
export async function runBrowserLogin(env: Env, prefillEmail?: string): Promise<LoginResult> {
  assertNotProduction(env);

  const html = await readFile(LOGIN_PAGE_PATH, "utf-8");

  return new Promise<LoginResult>((resolve, reject) => {
    const server = createServer((req, res) => handle(req, res, html, resolve, reject));
    server.on("error", reject);

    const timer = setTimeout(() => {
      server.close();
      reject(new LoginTimeoutError("Browser login timed out. Close this draft and try again."));
    }, LOGIN_TIMEOUT_MS);

    server.listen(DEFAULT_PORT, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        clearTimeout(timer);
        server.close();
        reject(new Error("Could not bind the login helper to a local port."));
        return;
      }
      const port = addr.port;
      const url = buildLoginUrl(port, env, prefillEmail);
      open(url).catch(() => {
        // If `open` fails we still let the user navigate manually — the URL
        // is surfaced in the error below if nothing happens within the timeout.
        console.error(`[transaction-agent] Open this URL to sign in: ${url}`);
      });

      // Wrap the resolve/reject so we clean up server + timer exactly once.
      const originalResolve = resolve;
      const originalReject = reject;
      resolve = (value) => {
        clearTimeout(timer);
        server.close();
        originalResolve(value);
      };
      reject = (err) => {
        clearTimeout(timer);
        server.close();
        originalReject(err);
      };
    });
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  html: string,
  resolve: (result: LoginResult) => void,
  reject: (err: Error) => void,
) {
  if (!req.url) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");

  // Restrict same-origin: only requests from this loopback origin allowed to POST.
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("http://127.0.0.1") && !origin.startsWith("http://localhost")) {
    res.statusCode = 403;
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
    return;
  }

  if (req.method === "POST" && url.pathname === "/token") {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Partial<LoginResult>;
        if (!parsed.env || !parsed.accessToken) {
          res.statusCode = 400;
          res.end("Missing env or accessToken");
          return;
        }
        res.statusCode = 204;
        res.end();
        resolve({
          env: parsed.env as Env,
          accessToken: parsed.accessToken,
          email: parsed.email,
          remember: parsed.remember !== false,
        });
      } catch {
        res.statusCode = 400;
        res.end("Invalid JSON");
        reject(new Error("Malformed token relay payload"));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end();
}

function buildLoginUrl(port: number, env: Env, prefillEmail?: string): string {
  const params = new URLSearchParams({ env });
  if (prefillEmail) params.set("email", prefillEmail);
  return `http://127.0.0.1:${port}/login?${params.toString()}`;
}

export class LoginTimeoutError extends Error {
  override readonly name = "LoginTimeoutError";
}
