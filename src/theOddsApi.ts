import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const base = "https://api.the-odds-api.com/v4";
const string = (description: string) => ({ type: "string", description });
const sport = string("Exact sport/competition key returned by get_sports, for example soccer_epl or basketball_nba. Generic football/tennis slugs do not work.");
const dateFilters = {
  commenceTimeFrom: string("Optional start time in ISO8601 UTC, such as 2026-10-13T00:00:00Z."),
  commenceTimeTo: string("Optional end time in ISO8601 UTC."),
};
const oddsFilters = {
  regions: string("Comma-separated provider regions: uk, eu, us, us2, au. Defaults to uk. Each region/market can consume quota; use one region for a test. There is no za region."),
  markets: string("Comma-separated market keys. Defaults to h2h (match winner). Main markets: h2h, spreads, totals. Additional event-specific markets depend on sport and subscription."),
  bookmakers: string("Optional comma-separated bookmaker KEYS from a previous odds response. Overrides regions. Do not assume a generic Betway feed is the South African offering."),
};

export const providerTools = [
  { name: "get_sports", description: "The Odds API: list available sport and competition keys, including football, tennis and basketball. Does not consume provider credits. Use these keys for other tools.", properties: { all: { type: "boolean", description: "Include out-of-season competitions." } }, required: [] as string[] },
  { name: "get_events", description: "The Odds API: list current and upcoming events for a specific sport/competition key. Returns string event IDs; does not return prices or consume provider credits.", properties: { sport, ...dateFilters }, required: ["sport"] },
  { name: "get_odds", description: "The Odds API: fetch current bookmaker odds for a sport/competition. Returns decimal prices, bookmaker keys, market outcomes and update timestamps. Costs provider credits by market and region. Start with h2h and one region; quota is included in the result.", properties: { sport, ...oddsFilters, ...dateFilters, eventIds: string("Optional comma-separated event IDs from get_events to restrict results.") }, required: ["sport"] },
  { name: "get_event_odds", description: "The Odds API: fetch current odds for one event, including additional sport-specific markets when available. Costs provider credits. Event IDs are strings from get_events.", properties: { sport, eventId: string("Event ID returned by get_events."), ...oddsFilters }, required: ["sport", "eventId"] },
  { name: "get_scores", description: "The Odds API: fetch live/upcoming events and scores for a competition. Optional daysFrom retrieves completed events from the past 1 to 3 days. Costs provider credits.", properties: { sport, daysFrom: { type: "integer", minimum: 1, maximum: 3, description: "Optional completed-event lookback, 1 to 3 days." } }, required: ["sport"] },
];

export async function providerRequest(apiKey: string, endpoint: string, params: Record<string, unknown> = {}) {
  if (!apiKey.trim()) throw new Error("ODDS_API_KEY is required");
  const url = new URL(base + endpoint);
  url.searchParams.set("apiKey", apiKey.trim());
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error("The Odds API request timed out or could not connect"); }
  if (!response.ok) {
    // Never echo URLs, secrets or upstream response bodies.
    const explanation = response.status === 401 ? "check your the-odds-api.com key and account quota" :
      response.status === 429 ? "provider rate limit reached" : "check sport, market and subscription support";
    throw new Error(`The Odds API returned HTTP ${response.status}: ${explanation}`);
  }
  return { data: await response.json(), quota: {
    remaining: response.headers.get("x-requests-remaining"),
    used: response.headers.get("x-requests-used"),
    lastRequestCost: response.headers.get("x-requests-last"),
  } };
}

export async function callProviderTool(apiKey: string, name: string, args: Record<string, unknown>) {
  const definition = providerTools.find(t => t.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  for (const key of definition.required) if (typeof args[key] !== "string" || !args[key]) throw new Error(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const property = (definition.properties as Record<string, { type: string } | undefined>)[key];
    if (!property) throw new Error(`Unsupported parameter: ${key}`);
    if (property.type === "integer" ? !Number.isInteger(value) : typeof value !== property.type) throw new Error(`Invalid parameter: ${key}`);
  }
  if (args.sport && !/^[a-z0-9_]+$/.test(String(args.sport))) throw new Error("Use a sport key from get_sports");
  if (args.eventId && !/^[a-zA-Z0-9_-]+$/.test(String(args.eventId))) throw new Error("Invalid event ID");
  if (args.regions && String(args.regions).split(",").some(r => !["uk", "eu", "us", "us2", "au"].includes(r))) throw new Error("Unsupported region; use uk, eu, us, us2 or au");
  if (args.daysFrom !== undefined && (Number(args.daysFrom) < 1 || Number(args.daysFrom) > 3)) throw new Error("daysFrom must be 1 to 3");
  for (const key of Object.keys(dateFilters)) {
    if (args[key] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(args[key]))) throw new Error(`${key} must be an ISO8601 UTC timestamp`);
  }
  const { sport: sportKey, eventId, ...params } = args;
  if (name === "get_sports") return providerRequest(apiKey, "/sports", params);
  const root = `/sports/${sportKey}`;
  if (name === "get_events") return providerRequest(apiKey, `${root}/events`, params);
  if (name === "get_scores") return providerRequest(apiKey, `${root}/scores`, params);
  return providerRequest(apiKey, name === "get_odds" ? `${root}/odds` : `${root}/events/${eventId}/odds`, {
    regions: "uk", markets: "h2h", ...params, oddsFormat: "decimal", dateFormat: "iso",
  });
}

export function createTheOddsApiServer(apiKey: string) {
  const server = new Server({ name: "personal-sports-odds", version: "2.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: providerTools.map(t => ({
    name: t.name, description: t.description,
    inputSchema: { type: "object" as const, properties: t.properties, required: t.required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await callProviderTool(apiKey, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Provider request failed" }] };
    }
  });
  return server;
}
