import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoLabOSRuntime } from "../src/runtime/createRuntime.js";

const doctorMocks = vi.hoisted(() => ({
  runDoctorReport: vi.fn()
}));

vi.mock("../src/core/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/doctor.js")>();
  return {
    ...actual,
    runDoctorReport: doctorMocks.runDoctorReport
  };
});

import { createAutoLabOSWebRequestListenerForTesting } from "../src/web/server.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const openServers: Server[] = [];
const tempRoots: string[] = [];

beforeEach(() => {
  doctorMocks.runDoctorReport.mockReset();
  doctorMocks.runDoctorReport.mockImplementation(async (_codex, opts) => buildDoctorReport(Boolean(opts?.liveProviderProbe)));
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("web doctor provider compatibility API", () => {
  it("keeps the default doctor GET free of the opt-in provider probe", async () => {
    const { port } = await startController("codex");

    const result = await sendRequest(port, "/api/doctor");

    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(result.body).checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "codex-chat-provider-compatibility" })])
    );
    expect(doctorMocks.runDoctorReport).toHaveBeenCalledTimes(1);
    expect(doctorMocks.runDoctorReport.mock.calls[0]?.[1]).not.toHaveProperty("liveProviderProbe");
  });

  it("requires a matching direct or trusted origin and the exact JSON confirmation", async () => {
    const { port } = await startController("codex");
    const sameOrigin = `http://127.0.0.1:${port}`;
    const attempts = [
      await sendRequest(port, "/api/doctor/provider-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://example.invalid" },
        body: JSON.stringify({ confirm: true })
      }),
      await sendRequest(port, "/api/doctor/provider-probe", {
        method: "POST",
        headers: { Origin: sameOrigin },
        body: JSON.stringify({ confirm: true })
      }),
      await sendRequest(port, "/api/doctor/provider-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: sameOrigin },
        body: "{"
      }),
      await sendRequest(port, "/api/doctor/provider-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: sameOrigin },
        body: JSON.stringify({ confirm: false })
      }),
      await sendRequest(port, "/api/doctor/provider-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: sameOrigin },
        body: JSON.stringify({ confirm: true, extra: true })
      })
    ];

    expect(attempts.map((attempt) => attempt.status)).toEqual([403, 415, 400, 400, 400]);
    for (const attempt of attempts) {
      expect(attempt.headers["cache-control"]).toBe("no-store");
    }
    expect(doctorMocks.runDoctorReport).not.toHaveBeenCalled();
  });

  it("returns a safe conflict when the runtime or provider mode is not eligible", async () => {
    const unconfigured = await startController();
    const alternate = await startController("openai_api");

    for (const port of [unconfigured.port, alternate.port]) {
      const result = await sendRequest(port, "/api/doctor/provider-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      expect(result.status).toBe(409);
      expect(result.body).not.toContain("configured-chat-model");
    }
    expect(doctorMocks.runDoctorReport).not.toHaveBeenCalled();
  });

  it("uses the configured chat model and shares one in-flight report across concurrent requests", async () => {
    let releaseReport!: (report: ReturnType<typeof buildDoctorReport>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    doctorMocks.runDoctorReport.mockImplementation(async (_codex, opts) => {
      markStarted();
      return await new Promise<ReturnType<typeof buildDoctorReport>>((resolve) => {
        releaseReport = resolve;
      });
    });
    const trustedOrigin = "https://127.0.0.1:__PORT__";
    const { port } = await startController("codex_chatgpt_only", {
      trustedOrigin
    });
    const browserOrigin = trustedOrigin.replace("__PORT__", String(port));
    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Origin: browserOrigin
      },
      body: JSON.stringify({ confirm: true })
    };

    const first = sendRequest(port, "/api/doctor/provider-probe", requestOptions);
    const second = sendRequest(port, "/api/doctor/provider-probe", requestOptions);
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(doctorMocks.runDoctorReport).toHaveBeenCalledTimes(1);
    expect(doctorMocks.runDoctorReport.mock.calls[0]?.[1]).toMatchObject({
      llmMode: "codex_chatgpt_only",
      liveProviderProbe: { model: "configured-chat-model" }
    });

    releaseReport(buildDoctorReport(true));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    for (const result of [firstResult, secondResult]) {
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(result.body)).toMatchObject({
        configured: true,
        status: "ok",
        readiness: { blocked: false },
        checks: [expect.objectContaining({ name: "codex-chat-provider-compatibility" })]
      });
    }
  });

  it("falls back to the configured Codex model only when no chat model is present", async () => {
    const { port } = await startController("codex", { omitChatModel: true });

    const result = await sendRequest(port, "/api/doctor/provider-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });

    expect(result.status).toBe(200);
    expect(doctorMocks.runDoctorReport.mock.calls[0]?.[1]).toMatchObject({
      liveProviderProbe: { model: "configured-research-model" }
    });
  });

  it("contains unexpected report failures inside a generic provider-probe response", async () => {
    doctorMocks.runDoctorReport.mockRejectedValueOnce(new Error("private-provider-body-fragment"));
    const { port } = await startController("codex");

    const result = await sendRequest(port, "/api/doctor/provider-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true })
    });

    expect(result.status).toBe(500);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toBe('{"error":"Provider compatibility check could not be completed."}\n');
    expect(result.body).not.toContain("private-provider-body-fragment");
  });
});

async function startController(
  llmMode?: "codex" | "codex_chatgpt_only" | "openai_api" | "ollama",
  options: { omitChatModel?: boolean; trustedOrigin?: string } = {}
): Promise<{ port: number }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "autolabos-web-doctor-api-"));
  tempRoots.push(cwd);
  const runtime = llmMode
    ? {
        codex: {},
        executionProfile: "local",
        semanticScholarApiKeyConfigured: false,
        config: {
          providers: {
            llm_mode: llmMode,
            codex: {
              model: "configured-research-model",
              ...(options.omitChatModel ? {} : { chat_model: "configured-chat-model" })
            }
          },
          workflow: {},
          experiments: {}
        }
      } as unknown as AutoLabOSRuntime
    : undefined;
  let resolvedListener: ReturnType<typeof createAutoLabOSWebRequestListenerForTesting> | undefined;
  const listener: RequestListener = (req, res) => {
    resolvedListener ??= createAutoLabOSWebRequestListenerForTesting({
      cwd,
      runtime,
      ...(options.trustedOrigin
        ? {
            trustedOrigin: options.trustedOrigin.replace(
              "__PORT__",
              String((server.address() as AddressInfo).port)
            )
          }
        : {})
    });
    void resolvedListener(req, res);
  };
  const server = createServer(listener);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { port: (server.address() as AddressInfo).port };
}

async function sendRequest(
  port: number,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: options.headers
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
    req.end(options.body);
  });
}

function buildDoctorReport(liveProviderProbe: boolean) {
  const checks = liveProviderProbe
    ? [{
        name: "codex-chat-provider-compatibility",
        ok: true,
        status: "ok" as const,
        detail: "Live provider compatibility check passed (compatible)."
      }]
    : [{ name: "config", ok: true, status: "ok" as const, detail: "Configuration is available." }];
  return {
    checks,
    readiness: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      workspaceRoot: "/workspace",
      workspaceProbePath: "/workspace/probe",
      blocked: false,
      llmMode: "codex" as const,
      approvalMode: "minimal" as const,
      executionApprovalMode: "manual" as const,
      dependencyMode: "local" as const,
      sessionMode: "fresh" as const,
      networkDeclarationPresent: true,
      networkApprovalSatisfied: true,
      containerizationRequired: false,
      webRestrictionRequired: true,
      manualOverride: false,
      warningChecks: [],
      failedChecks: []
    }
  };
}
