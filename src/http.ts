import { pathToFileURL } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOAuthMetadata, mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createServer } from "./index.js";
import { OwnerOAuthProvider } from "./auth.js";

export function createHttpApp(env: NodeJS.ProcessEnv = process.env) {
  if (!env.ODDS_API_KEY) throw new Error("ODDS_API_KEY is required");
  const origin = new URL(env.PUBLIC_URL || (env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}` : ""));
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("PUBLIC_URL must use HTTPS");
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("PUBLIC_URL must be an origin without path or credentials");
  const resource = new URL("/mcp", origin);
  const redirects = (env.CHATGPT_REDIRECT_URIS || "https://chatgpt.com/connector_platform_oauth_redirect").split(",").map(s => s.trim());
  for (const redirect of redirects) {
    const url = new URL(redirect);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.search || url.hash ||
      !(url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))) throw new Error("Only exact ChatGPT OAuth callback URLs are allowed");
  }
  const provider = new OwnerOAuthProvider(origin, resource, env.OWNER_PASSWORD || "", env.OAUTH_SIGNING_SECRET || "", env.CHATGPT_CLIENT_SECRET || "", redirects);
  const app = express();
  app.disable("x-powered-by");
  // Render terminates HTTPS at a reverse proxy. Never derive OAuth URLs from request headers.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  });
  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });
  const options = { provider, issuerUrl: origin, resourceServerUrl: resource, scopesSupported: ["odds:read"] };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({ ...createOAuthMetadata(options), authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["client_secret_post"] });
  });
  // SDK-generated OAuth error redirects also need issuer identification.
  app.use("/authorize", (_req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = ((statusOrUrl: number | string, url?: string) => {
      const target = new URL(typeof statusOrUrl === "string" ? statusOrUrl : url!);
      target.searchParams.set("iss", origin.href);
      return redirect(typeof statusOrUrl === "number" ? statusOrUrl : 302, target.href);
    }) as typeof res.redirect;
    next();
  });
  app.use(mcpAuthRouter(options));
  app.post("/login", rateLimit({ windowMs: 900000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
      const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const redirect = provider.login(nonce, password);
      if (!redirect) { res.status(401).type("text").send("Login failed or expired. Start the connection again from ChatGPT."); return; }
      res.redirect(303, redirect.href);
    });
  const auth = requireBearerAuth({ verifier: provider, requiredScopes: ["odds:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource), expectedResource: resource });
  app.use("/mcp", auth, rateLimit({ windowMs: 60000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }));
  app.post("/mcp", express.json({ limit: "128kb" }), async (req, res) => {
    const server = createServer(true);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.all("/mcp", (_req, res) => { res.set("Allow", "POST").status(405).end(); });
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(400).json({ error: "Invalid request" });
  });
  return { app, provider };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { app } = createHttpApp();
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
    const listener = app.listen(port, "0.0.0.0", () => console.error(`Odds MCP HTTP server listening on port ${port}`));
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => listener.close(() => process.exit(0)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Server configuration error");
    process.exit(1);
  }
}
