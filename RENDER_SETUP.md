# Personal odds server: Render and ChatGPT

This branch adds authenticated Streamable HTTP at `/mcp`. It is prepared for deployment; it has not been deployed or linked to ChatGPT yet.

## 1. Deploy from your phone

Use Render's Blueprint creation screen: https://dashboard.render.com/select-repo?type=blueprint

Select `Stugu9601/odds-api-mcp-server`, then branch `render-remote-mcp`. The blueprint is `render.yaml`. Check the branch before applying it. If Render does not offer a branch picker, use the manual Web Service setup below instead.

Enter your The Odds API (the-odds-api.com) key as `ODDS_API_KEY` in Render only. The blueprint generates three separate private values: `OWNER_PASSWORD`, `OAUTH_SIGNING_SECRET` and `CHATGPT_CLIENT_SECRET`. Never put these values in GitHub, chat messages or screenshots.

Manual alternative: create a Node Web Service from the same repository and branch. Build: `npm ci && npm run build`. Start: `npm run start:http`. Health check: `/health`. Choose Free for testing. Add `NODE_VERSION=22`, your `ODDS_API_KEY`, and three different randomly generated passwords of at least 32 characters for the three secret variables above. Disable automatic deployment while reviewing this branch.

Render supplies `PORT` and `RENDER_EXTERNAL_HOSTNAME`; the server uses them automatically. If using a custom domain, set `PUBLIC_URL` to its HTTPS origin, with no path, for example `https://odds.example.com`.

When deployment succeeds, open `https://YOUR-SERVICE.onrender.com/health`. Expected response: `{"status":"ok"}`. This confirms server startup, not the validity or coverage of your Odds API key.

## 2. Connect ChatGPT

In ChatGPT's custom MCP connection screen, use:

| Field | Value |
|---|---|
| Name | Personal Sports Odds |
| MCP URL | `https://YOUR-SERVICE.onrender.com/mcp` |
| Authentication | OAuth |
| OAuth client ID | `chatgpt-odds` |
| OAuth client secret | The `CHATGPT_CLIENT_SECRET` value from Render |

If these client fields are collapsed, expand the advanced OAuth settings. The server uses a predefined confidential client; anonymous access and dynamic client registration are deliberately unavailable. If your interface cannot accept a predefined OAuth client, pause rather than selecting no authentication.

The OAuth login page asks for `OWNER_PASSWORD` from Render. This is a separate password from your Odds API key and GitHub login. Successful login grants `odds:read` access.

The server advertises issuer identification and allows the stable callback `https://chatgpt.com/connector_platform_oauth_redirect`. If ChatGPT displays a different callback, copy its exact URL into Render's `CHATGPT_REDIRECT_URIS` and redeploy. Only exact ChatGPT callback URLs are accepted; comma-separated entries are supported. Never add wildcard callbacks.

After linking, enable the app in the conversation and ask: “List available sports, then fetch upcoming events for one returned competition key.” Test actual odds retrieval before relying on the connection. Bookmaker and South African market coverage depend on The Odds API. The provider supports uk, eu, us, us2 and au regions; there is no za region. Do not assume international bookmaker odds match South African prices.

## Operation and limits

- Local stdio remains available with `npm start`. HTTP starts separately with `npm run start:http`.
- HTTP now uses The Odds API v4 and exposes five tools: get_sports, get_events, get_odds, get_event_odds and get_scores. The original local stdio entry point still targets Odds-API.io.
- After deploying the provider change, refresh the app tool definitions in ChatGPT. If no refresh option is offered, recreate the custom connection using the same URL and OAuth credentials. The schemas changed: use competition keys such as soccer_epl; event IDs are strings.
- Sports and event discovery do not consume provider credits. Odds and scores calls consume credits; results include remaining/used/last-request quota headers. Start with one region and h2h to minimise test usage. Tools do not place bets.
- Access tokens last one hour; refresh authorisation lasts at most seven days. Sign in again when it expires. Stable client and signing secrets let tokens survive service restarts. Login forms expire after 15 minutes. Login requests and short-lived codes in progress are lost on restart; restart that connection flow.
- To revoke all sessions, rotate `OAUTH_SIGNING_SECRET` and redeploy. Changing only `OWNER_PASSWORD` does not revoke issued tokens. Refresh tokens are signed and reusable until expiry; this personal server has no per-token revocation store. Keep the client secret private.
- Free Render services can sleep when idle. Cold starts may interrupt initial linking; open `/health` first and retry. An always-on plan may be needed for dependable daily use. Rate limits are per instance, with additional limits imposed by your Odds API subscription.
- `npm run build` and `npm test` check compilation, provider tools and the local OAuth/MCP flow. A live Render-to-ChatGPT test and real API-key verification remain required after deployment.

Official references:

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://render.com/docs/blueprint-spec
- https://render.com/docs/free

Provider documentation: https://the-odds-api.com/liveapi/guides/v4/
