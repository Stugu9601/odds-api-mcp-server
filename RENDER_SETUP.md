# Personal odds server: Render and ChatGPT

This branch adds authenticated Streamable HTTP at `/mcp`. It is prepared for deployment; it has not been deployed or linked to ChatGPT yet.

## 1. Deploy from your phone

Use Render's Blueprint creation screen: https://dashboard.render.com/select-repo?type=blueprint

Select `Stugu9601/odds-api-mcp-server`, then branch `render-remote-mcp`. The blueprint is `render.yaml`. Check the branch before applying it. If Render does not offer a branch picker, use the manual Web Service setup below instead.

Enter your Odds-API.io key as `ODDS_API_KEY` in Render only. The blueprint generates three separate private values: `OWNER_PASSWORD`, `OAUTH_SIGNING_SECRET` and `CHATGPT_CLIENT_SECRET`. Never put these values in GitHub, chat messages or screenshots.

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

After linking, enable the app in the conversation and ask: “List available sports and bookmakers, then fetch upcoming football events.” Test actual odds retrieval before relying on the connection. Some endpoints require a paid Odds-API.io plan; bookmaker and South African market coverage depend on the provider subscription.

## Operation and limits

- Local stdio remains available with `npm start`. HTTP starts separately with `npm run start:http`.
- Remote tools cannot select or clear bookmakers on your provider account. Configure those settings directly with Odds-API.io if needed. The remote tools retrieve data and can grade hypothetical selections; they do not place bets.
- Access tokens last one hour; refresh authorisation lasts at most seven days. Sign in again when it expires. Stable client and signing secrets let tokens survive service restarts. Login requests and short-lived codes in progress are lost on restart; restart that connection flow.
- To revoke all sessions, rotate `OAUTH_SIGNING_SECRET` and redeploy. Changing only `OWNER_PASSWORD` does not revoke issued tokens. Refresh tokens are signed and reusable until expiry; this personal server has no per-token revocation store. Keep the client secret private.
- Free Render services can sleep when idle. Cold starts may interrupt initial linking; open `/health` first and retry. An always-on plan may be needed for dependable daily use. Rate limits are per instance, with additional limits imposed by your Odds API subscription.
- `npm run build` and `npm test` check compilation, provider tools and the local OAuth/MCP flow. A live Render-to-ChatGPT test and real API-key verification remain required after deployment.

Official references:

- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://render.com/docs/blueprint-spec
- https://render.com/docs/free
