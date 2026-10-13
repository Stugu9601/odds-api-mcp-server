import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

type Pending = { clientId: string; params: AuthorizationParams; expires: number };
const random = () => randomBytes(32).toString("base64url");
const scope = "odds:read";

/** Single-owner OAuth provider. Client and signing secrets survive Render restarts via env vars. */
export class OwnerOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Pending>();
  private key: Uint8Array;
  private passwordSalt = randomBytes(32);
  private passwordHash: Buffer;
  readonly client: OAuthClientInformationFull;
  readonly clientsStore;

  constructor(readonly issuer: URL, readonly resource: URL, password: string, signingSecret: string, clientSecret: string, redirectUris: string[]) {
    for (const [name, secret] of Object.entries({ OWNER_PASSWORD: password, OAUTH_SIGNING_SECRET: signingSecret, CHATGPT_CLIENT_SECRET: clientSecret })) {
      if (secret.length < 32 || secret.length > 256) throw new Error(`${name} must contain 32 to 256 characters`);
    }
    this.key = new TextEncoder().encode(signingSecret);
    this.passwordHash = scryptSync(password, this.passwordSalt, 32);
    this.client = {
      client_id: "chatgpt-odds", client_secret: clientSecret,
      redirect_uris: redirectUris, token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope,
    };
    this.clientsStore = { getClient: (id: string) => id === this.client.client_id ? this.client : undefined };
  }

  private prune() {
    for (const store of [this.pending, this.codes]) {
      for (const [key, entry] of store) if (entry.expires < Date.now()) store.delete(key);
    }
  }

  private validateResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidTargetError("Unexpected resource");
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.validateResource(params.resource);
    if (params.scopes?.some(s => s !== scope)) throw new InvalidScopeError("Only odds:read is supported");
    this.prune();
    if (this.pending.size >= 100) throw new Error("Too many pending logins");
    const nonce = random();
    this.pending.set(nonce, { clientId: client.client_id, params, expires: Date.now() + 300000 });
    // The form contains only a random, one-use nonce; API and client secrets stay server-side.
    res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your odds server</title><body><main><h1>Connect your odds server</h1><p>Allow ChatGPT to read sports odds using your Odds-API.io account.</p><form method="post" action="/login"><input type="hidden" name="nonce" value="${nonce}"><label>Owner password <input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><p><button type="submit">Connect ChatGPT</button></p></form></main></body></html>`);
  }

  login(nonce: string, password: string): URL | undefined {
    this.prune();
    const entry = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!entry || this.codes.size >= 100 || password.length > 256) return undefined;
    const hash = scryptSync(password, this.passwordSalt, 32);
    if (!timingSafeEqual(hash, this.passwordHash)) return undefined;
    const code = random();
    this.codes.set(code, { ...entry, expires: Date.now() + 60000 });
    const redirect = new URL(entry.params.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("iss", this.issuer.href);
    if (entry.params.state !== undefined) redirect.searchParams.set("state", entry.params.state);
    return redirect;
  }

  private code(client: OAuthClientInformationFull, code: string) {
    this.prune();
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired code");
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.code(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const entry = this.code(client, code);
    this.codes.delete(code);
    this.validateResource(resource);
    if (redirectUri !== entry.params.redirectUri) throw new InvalidGrantError("Redirect URI mismatch");
    return this.tokens(client.client_id);
  }

  private async sign(clientId: string, kind: "access" | "refresh", expires: number) {
    return new SignJWT({ kind, scope }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer.href).setAudience(this.resource.href).setSubject(clientId)
      .setIssuedAt().setExpirationTime(expires).setJti(random()).sign(this.key);
  }

  private async verify(token: string, kind: "access" | "refresh") {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"], issuer: this.issuer.href, audience: this.resource.href,
        requiredClaims: ["exp", "iat", "sub", "jti"],
      });
      if (payload.kind !== kind || payload.scope !== scope || payload.sub !== this.client.client_id) throw new Error();
      return payload;
    } catch { throw new InvalidTokenError("Invalid or expired token"); }
  }

  private async tokens(clientId: string, refreshExpires = Math.floor(Date.now() / 1000) + 604800): Promise<OAuthTokens> {
    return { access_token: await this.sign(clientId, "access", Math.floor(Date.now() / 1000) + 3600),
      refresh_token: await this.sign(clientId, "refresh", refreshExpires), token_type: "Bearer", expires_in: 3600, scope };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.validateResource(resource);
    if (scopes?.some(s => s !== scope)) throw new InvalidScopeError("Cannot increase scope");
    const payload = await this.verify(token, "refresh");
    if (payload.sub !== client.client_id) throw new InvalidGrantError("Client mismatch");
    // Keep the original seven-day maximum; refreshing cannot extend the owner consent indefinitely.
    return this.tokens(client.client_id, payload.exp!);
  }

  async verifyAccessToken(token: string) {
    const payload = await this.verify(token, "access");
    return { token, clientId: payload.sub!, scopes: [scope], expiresAt: payload.exp, resource: this.resource };
  }
}
