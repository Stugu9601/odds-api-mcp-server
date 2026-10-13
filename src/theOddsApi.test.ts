import { afterEach, describe, expect, it, vi } from "vitest";
import { callProviderTool } from "./theOddsApi.js";
afterEach(() => vi.unstubAllGlobals());
function mockResponse(status = 200) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify([{ id: "event1" }]), {
    status, headers: { "x-requests-remaining": "499", "x-requests-used": "1", "x-requests-last": "1" },
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("The Odds API adapter", () => {
  it("uses the correct provider and key for sports discovery", async () => {
    const fetch = mockResponse();
    const result = await callProviderTool("test-key", "get_sports", { all: true });
    const url = fetch.mock.calls[0][0] as URL;
    expect(url.origin).toBe("https://api.the-odds-api.com");
    expect(url.pathname).toBe("/v4/sports");
    expect(url.searchParams.get("apiKey")).toBe("test-key");
    expect(url.searchParams.get("all")).toBe("true");
    expect(result.quota.remaining).toBe("499");
  });
  it("fetches decimal odds with one region and market by default", async () => {
    const fetch = mockResponse();
    await callProviderTool("test-key", "get_odds", { sport: "soccer_epl", eventIds: "event1" });
    const url = fetch.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/v4/sports/soccer_epl/odds");
    expect(url.searchParams.get("oddsFormat")).toBe("decimal");
    expect(url.searchParams.get("regions")).toBe("uk");
    expect(url.searchParams.get("markets")).toBe("h2h");
    expect(url.searchParams.get("eventIds")).toBe("event1");
  });
  it("routes string event IDs and completed score queries", async () => {
    const fetch = mockResponse();
    await callProviderTool("test-key", "get_event_odds", { sport: "basketball_nba", eventId: "event1", markets: "totals" });
    expect((fetch.mock.calls[0][0] as URL).pathname).toBe("/v4/sports/basketball_nba/events/event1/odds");
    await callProviderTool("test-key", "get_scores", { sport: "basketball_nba", daysFrom: 2 });
    expect((fetch.mock.calls[1][0] as URL).searchParams.get("daysFrom")).toBe("2");
  });
  it("rejects unsupported inputs without consuming quota", async () => {
    const fetch = mockResponse();
    for (const args of [{ sport: "soccer_epl", regions: "za" }, { sport: "../../evil" }, { sport: "soccer_epl", apiKey: "override" }]) {
      await expect(callProviderTool("test-key", "get_odds", args)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not expose secrets in authentication errors", async () => {
    mockResponse(401);
    await expect(callProviderTool("private-test-key", "get_events", { sport: "soccer_epl" })).rejects.toThrow("The Odds API returned HTTP 401");
    try { await callProviderTool("private-test-key", "get_sports", {}); }
    catch (error) { expect(String(error)).not.toContain("private-test-key"); }
  });
});
