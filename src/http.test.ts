import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { once } from "node:events";
import { createHttpApp } from "./http.js";

const password = "test-owner-password-".repeat(3);
const secret = "test-client-secret-".repeat(3);
const signing = "test-signing-secret-".repeat(3);
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "test-pkce-verifier-".repeat(4);
const challenge = createHash("sha256").update(verifier).digest("base64url");
let listener: Server;
let base: string;
let resource: string;
let provider: ReturnType<typeof createHttpApp>["provider"];

beforeEach(async () => {
  process.env.ODDS_API_KEY = "test-only-api-key";
  const config = { ODDS_API_KEY: "test-only-api-key", PUBLIC_URL: "https://odds.example", OWNER_PASSWORD: password,
    OAUTH_SIGNING_SECRET: signing, CHATGPT_CLIENT_SECRET: secret };
  const result = createHttpApp(config);
  provider = result.provider;
  resource = "https://odds.example/mcp";
  listener = result.app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  base = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
});
afterEach(async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); });

async function startLogin(extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ client_id: "chatgpt-odds", redirect_uri: callback, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", resource, scope: "odds:read", state: "test-state", ...extra });
  const response = await fetch(`${base}/authorize?${query}`, { redirect: "manual" });
  const html = await response.text();
  return { response, html, nonce: html.match(/name="nonce" value="([^"]+)"/)?.[1] || "" };
}
async function login(nonce: string, pass = password) {
  return fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ nonce, password: pass }) });
}
async function token(values: Record<string, string>) {
  return fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ client_id: "chatgpt-odds", client_secret: secret, ...values }) });
}
async function obtainTokens() {
  const { nonce } = await startLogin();
  const response = await login(nonce);
  const redirect = new URL(response.headers.get("location")!);
  expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://chatgpt.com");
  expect(redirect.searchParams.get("state")).toBe("test-state");
  expect(redirect.searchParams.get("iss")).toBe("https://odds.example/");
  const code = redirect.searchParams.get("code")!;
  const grant = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback, resource };
  const exchange = await token(grant);
  expect(exchange.status).toBe(200);
  return { tokens: await exchange.json(), grant };
}

describe("Remote MCP and OAuth", () => {
  it("serves health and discovery but rejects anonymous MCP", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(resource);
    const denied = await fetch(`${base}/mcp`, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });
  it("rejects an incorrect password and nonce replay", async () => {
    const { nonce, html } = await startLogin();
    expect(html).not.toContain(secret);
    const wrong = await login(nonce, "wrong-password");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Incorrect owner password");
    const replay = await login(nonce);
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain("already used");
  });
  it("rejects open redirects, foreign resources and excessive scopes", async () => {
    expect((await startLogin({ redirect_uri: "https://evil.example/callback" })).response.status).toBe(400);
    for (const extra of [{ resource: "https://evil.example/mcp" }, { scope: "odds:write" }]) {
      const { response } = await startLogin(extra);
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBeTruthy();
      expect(new URL(response.headers.get("location")!).searchParams.get("iss")).toBe("https://odds.example/");
    }
  });
  it("requires PKCE and client credentials", async () => {
    const { nonce } = await startLogin();
    const redir = new URL((await login(nonce)).headers.get("location")!);
    const code = redir.searchParams.get("code")!;
    const grant = { grant_type: "authorization_code", code, code_verifier: "incorrect", redirect_uri: callback, resource };
    expect((await token(grant)).status).toBe(400);
    expect((await token({ ...grant, code_verifier: verifier, client_secret: "wrong" })).status).toBe(400);
  });
  it("initializes MCP, lists read tools and blocks mutations", async () => {
    const { tokens, grant } = await obtainTokens();
    expect((await token(grant)).status).toBe(400);
    async function rpc(method: string, params: object = {}) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
        Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      expect(response.status).toBe(200);
      return response.json();
    }
    expect((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result.serverInfo.name).toBe("odds-api-mcp");
    const names = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_odds");
    expect(names).not.toContain("select_bookmakers");
    expect((await rpc("tools/call", { name: "clear_selected_bookmakers", arguments: {} })).result.isError).toBe(true);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(405);
  });
  it("refreshes tokens after a server restart and rejects token substitution", async () => {
    const { tokens } = await obtainTokens();
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource })).status).toBe(200);
    const restarted = createHttpApp({ ODDS_API_KEY: "test", PUBLIC_URL: "https://odds.example", OWNER_PASSWORD: password,
      CHATGPT_CLIENT_SECRET: secret, OAUTH_SIGNING_SECRET: signing }).provider;
    expect((await restarted.verifyAccessToken(tokens.access_token)).clientId).toBe("chatgpt-odds");
    expect(await restarted.exchangeRefreshToken(restarted.client, tokens.refresh_token)).toHaveProperty("access_token");
    await expect(provider.verifyAccessToken(tokens.refresh_token)).rejects.toThrow();
    await expect(provider.verifyAccessToken(tokens.access_token + "tampered")).rejects.toThrow();
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: "https://evil.example" })).status).toBe(400);
  });
});
