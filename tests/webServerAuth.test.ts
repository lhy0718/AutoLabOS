import { spawnSync } from "node:child_process";
import { createServer, request, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_AUTH_SECRET_ENV,
  WEB_AUTH_USERNAME,
  createAuthenticatedWebRequestListener,
  isLoopbackWebHost,
  resolveWebAuthentication
} from "../src/web/server.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function fixtureSecret(): string {
  return ["fixture", "browser", "password", "value"].join("-");
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function startServer(listener: RequestListener): Promise<number> {
  const server = createServer(listener);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function sendRequest(
  port: number,
  pathname: string,
  options: { method?: string; authorization?: string } = {}
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: options.authorization ? { Authorization: options.authorization } : undefined
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("AutoLabOS web authentication boundary", () => {
  it("recognizes only explicit loopback hosts as local", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.42.0.9",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1"
    ]) {
      expect(isLoopbackWebHost(host), host).toBe(true);
      expect(resolveWebAuthentication(host, {}).enabled, host).toBe(false);
    }

    for (const host of ["0.0.0.0", "192.168.10.20", "::", "host.example"]) {
      expect(isLoopbackWebHost(host), host).toBe(false);
      expect(() => resolveWebAuthentication(host, {})).toThrow(WEB_AUTH_SECRET_ENV);
    }

    expect(resolveWebAuthentication("127.0.0.1", {
      [WEB_AUTH_SECRET_ENV]: fixtureSecret()
    }).enabled).toBe(true);
  });

  it("fails closed for missing or invalid remote secrets without echoing them", () => {
    const weakSecret = "short-value";
    expect(() => resolveWebAuthentication("0.0.0.0", {
      [WEB_AUTH_SECRET_ENV]: weakSecret
    })).toThrowError(expect.not.stringContaining(weakSecret));

    const remote = resolveWebAuthentication("0.0.0.0", {
      [WEB_AUTH_SECRET_ENV]: fixtureSecret()
    });
    expect(remote.enabled).toBe(true);
  });

  it("places static UI, APIs, raw artifacts, SSE, and actions behind one boundary", async () => {
    const secret = fixtureSecret();
    const authentication = resolveWebAuthentication("0.0.0.0", {
      [WEB_AUTH_SECRET_ENV]: secret
    });
    const reached: string[] = [];
    const port = await startServer(createAuthenticatedWebRequestListener(authentication, (req, res) => {
      reached.push(`${req.method} ${req.url}`);
      res.statusCode = 204;
      res.end();
    }));
    const surfaces = [
      { path: "/", method: "GET" },
      { path: "/api/runs", method: "GET" },
      { path: "/api/runs/run-fixture/artifact?path=result.json", method: "GET" },
      { path: "/api/events/stream", method: "GET" },
      { path: "/api/runs/run-fixture/actions/approve", method: "POST" }
    ];

    for (const surface of surfaces) {
      const result = await sendRequest(port, surface.path, { method: surface.method });
      expect(result.status, surface.path).toBe(401);
      expect(result.headers["www-authenticate"], surface.path).toBe(
        'Basic realm="AutoLabOS", charset="UTF-8"'
      );
      expect(result.headers["cache-control"], surface.path).toBe("no-store");
      expect(result.body, surface.path).not.toContain(secret);
    }
    expect(reached).toEqual([]);

    const authorization = basicAuthorization(WEB_AUTH_USERNAME, secret);
    for (const surface of surfaces) {
      const result = await sendRequest(port, surface.path, {
        method: surface.method,
        authorization
      });
      expect(result.status, surface.path).toBe(204);
    }
    expect(reached).toHaveLength(surfaces.length);
  });

  it("rejects malformed, wrong, and query-only credentials with the same 401 response", async () => {
    const secret = fixtureSecret();
    const authentication = resolveWebAuthentication("192.168.10.20", {
      [WEB_AUTH_SECRET_ENV]: secret
    });
    let reached = false;
    const port = await startServer(createAuthenticatedWebRequestListener(authentication, (_req, res) => {
      reached = true;
      res.end("unexpected");
    }));
    const attempts = [
      undefined,
      "Bearer value",
      basicAuthorization("wrong-user", secret),
      basicAuthorization(WEB_AUTH_USERNAME, `${secret}-wrong`)
    ];

    const bodies = new Set<string>();
    for (const authorization of attempts) {
      const result = await sendRequest(port, "/api/runs?access=present", { authorization });
      expect(result.status).toBe(401);
      bodies.add(result.body);
    }
    expect(bodies).toEqual(new Set(['{"error":"Authentication required."}\n']));
    expect(reached).toBe(false);
  });

  it("keeps loopback unauthenticated by default", async () => {
    const authentication = resolveWebAuthentication("127.0.0.1", {});
    const port = await startServer(createAuthenticatedWebRequestListener(authentication, (_req, res) => {
      res.statusCode = 204;
      res.end();
    }));

    expect((await sendRequest(port, "/api/bootstrap")).status).toBe(204);
  });

  it("rejects the real CLI remote-bind path before runtime bootstrap when auth is absent", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "web", "--host", "0.0.0.0"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          [WEB_AUTH_SECRET_ENV]: ""
        }
      }
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Refusing to bind");
    expect(result.stderr).toContain(WEB_AUTH_SECRET_ENV);
    expect(result.stdout).not.toContain("AutoLabOS web UI:");
  });

  it("documents the remote browser sign-in boundary in CLI help", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(WEB_AUTH_SECRET_ENV);
    expect(result.stdout).toContain(`Browser username: ${WEB_AUTH_USERNAME}`);
    expect(result.stdout).toContain("use TLS or a trusted tunnel");
  });
});
