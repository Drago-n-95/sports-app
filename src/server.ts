import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { addTeams, clearState, getState, setTeamIds } from "./storage";



console.log("DEPLOY VERSION cafc1fc — ME.DEBUG SHOULD EXIST");

console.log("BOOT sports-app-api v1 - server.ts loaded");
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.SPORTSDB_API_KEY || "123";
const BASE = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;

// --- very small cache (swap with Redis later) ---
type CacheEntry = { expiresAt: number; value: any };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: any, ttlSeconds: number) {
  cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function get<T>(path: string, ttlSeconds = 300): Promise<T> {
  const url = `${BASE}${path}`;

  // TEMP: do not cache lookupteam while debugging
  const shouldCache = !path.startsWith("/lookupteam.php");

  if (shouldCache) {
    const cached = cacheGet(url);
    if (cached) return cached as T;
  }

  const resp = await axios.get<T>(url, { timeout: 10_000 });

  if (shouldCache) {
    cacheSet(url, resp.data, ttlSeconds);
  }

  return resp.data;
}


// --- Normalizers (keep frontend consistent) ---
function normalizeTeam(t: any) {
  return {
    id: t.idTeam,
    name: t.strTeam,
    shortName: t.strTeamShort || null,
    sport: t.strSport,
    league: t.strLeague,
    leagueId: t.idLeague,
    stadium: t.strStadium || null,
    country: t.strCountry || null,
    badge: t.strBadge || null,
    logo: t.strLogo || null,
    banner: t.strTeamBanner || null,
  };
}

function normalizeEvent(e: any) {
  return {
    id: e.idEvent,
    date: e.dateEvent,
    time: e.strTime, // often UTC-like string
    season: e.strSeason || null,
    round: e.intRound || null,
    league: e.strLeague,
    leagueId: e.idLeague,
    homeTeam: { id: e.idHomeTeam, name: e.strHomeTeam, score: e.intHomeScore },
    awayTeam: { id: e.idAwayTeam, name: e.strAwayTeam, score: e.intAwayScore },
    venue: e.strVenue || null,
    status: e.strStatus || null,
    thumb: e.strThumb || null,
  };
}

// --- Routes ---
// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// 1) Search teams by name (Onboarding)
app.get("/teams/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query param: q" });

  // TheSportsDB: searchteams.php?t=Arsenal
  // Docs examples show this exact endpoint pattern. :contentReference[oaicite:2]{index=2}
  const data = await get<any>(`/searchteams.php?t=${encodeURIComponent(q)}`, 600);
  const teams = (data?.teams || []).map(normalizeTeam);
  res.json({ teams });
});

// 2) Lookup team details by id
app.get("/teams/:teamId", (req, res) => {
  const clientId = String(req.header("X-Client-Id") || "").trim();
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id" });

  const teamId = req.params.teamId;
  const state = getState(clientId);
  const team = state.teamsById?.[teamId] ?? null;

  if (!team) {
    return res.status(404).json({
      error: "Team not found in your follows. Search and follow the team first.",
      teamId,
    });
  }

  res.json({ team });
});



// 3) Next events for team (Upcoming games)
app.get("/teams/:teamId/events/next", async (req, res) => {
  const teamId = req.params.teamId;
  // eventsnext.php?id=TEAM_ID (documented in many TheSportsDB summaries) :contentReference[oaicite:3]{index=3}
  const data = await get<any>(`/eventsnext.php?id=${encodeURIComponent(teamId)}`, 120);
  const events = (data?.events || []).map(normalizeEvent);
  res.json({ events });
});

// 4) Last events for team (Past games)
app.get("/teams/:teamId/events/last", async (req, res) => {
  const teamId = req.params.teamId;
  const data = await get<any>(`/eventslast.php?id=${encodeURIComponent(teamId)}`, 300);
  const events = (data?.results || data?.events || []).map(normalizeEvent);
  res.json({ events });
});

// 5) Season schedule for team
// Commonly: eventsseason.php?id=TEAM_ID&s=YYYY-YYYY (soccer seasons) or year
app.get("/teams/:teamId/schedule", async (req, res) => {
  const teamId = req.params.teamId;
  const season = String(req.query.season || "").trim();
  if (!season) return res.status(400).json({ error: "Missing query param: season" });

  // 1) lookup team to get leagueId
  const clientId = String(req.header("X-Client-Id") || "").trim();
  const state = clientId ? store[clientId] : null;
  const team = state?.teamsById?.[teamId];

  if (!team) {
    return res.status(404).json({
      error: "Team not found in user store. Follow/search the team first.",
      teamId,
    });
  }

  const leagueId = team.leagueId;


  // 2) fetch season events by LEAGUE ID (documented)
  const seasonData = await get<any>(
    `/eventsseason.php?id=${encodeURIComponent(leagueId)}&s=${encodeURIComponent(season)}`,
    900
  );

  // 3) filter league events down to this team
  const eventsAll = (seasonData?.events || []).map(normalizeEvent);
  const events = eventsAll.filter(
    (e: any) => e.homeTeam?.id === teamId || e.awayTeam?.id === teamId
  );

  res.json({ team, season, leagueId, events, note: "Free key may return limited events." });
});

type FollowState = {
  teamIds: string[];
  teamsById: Record<string, any>; // normalized team
};

const store: Record<string, FollowState> = {};


// Replace entire follows API with per-client follows

// --- Followed teams (per-device via X-Client-Id) ---

// SET followed teams (overwrites)
app.post("/me/follows", (req, res) => {
  const clientId = requireClientId(req);

  const teamIds = (req.body as any)?.teamIds;
  if (!Array.isArray(teamIds)) {
    return res.status(400).json({ error: "Body must be { teamIds: string[] }" });
  }

  setTeamIds(clientId, teamIds.map(String));
  const state = getState(clientId);

  res.json({ ok: true, teamIds: state.teamIds });
});



// ADD followed teams (appends)
app.post("/me/follows/add", (req, res) => {
  const clientId = String(req.header("X-Client-Id") || "").trim();
  if (!clientId) return res.status(400).json({ error: "Missing X-Client-Id" });

  const body = req.body as any;
  const teamsRaw = Array.isArray(body?.teams) ? body.teams : [];
  if (!teamsRaw.length) return res.status(400).json({ error: "Missing body.teams[]" });

  const normalized = teamsRaw.map(normalizeTeam);
  addTeams(clientId, normalized);

  const state = getState(clientId);
  res.json({ ok: true, teamIds: state.teamIds });
});



app.get("/me/follows", (req, res) => {
  const clientId = requireClientId(req);
  const state = getState(clientId);

  const teams = state.teamIds
    .map((id) => state.teamsById[id])
    .filter(Boolean);

  res.json({ teamIds: state.teamIds, teams });
});



// Aggregated "feed" for Schedule tab: last + next per followed team
app.get("/me/feed", async (req, res) => {
  try {
    const clientId = requireClientId(req);
    const state = getState(clientId);

    if (!state.teamIds.length) return res.json({ items: [] });

    const season = String(req.query.season || "2025-2026").trim();
    const items: any[] = [];

    for (const teamId of state.teamIds) {
      const team = state.teamsById[teamId];
      if (!team) {
        items.push({ team: { id: teamId, name: "Unknown" }, next: [], last: [] });
        continue;
      }

      // Use teamId directly for next/last (does NOT require lookupteam)
      const [nextData, lastData] = await Promise.all([
        get<any>(`/eventsnext.php?id=${encodeURIComponent(teamId)}`, 120).catch(() => ({})),
        get<any>(`/eventslast.php?id=${encodeURIComponent(teamId)}`, 300).catch(() => ({})),
      ]);

      const next = (nextData?.events || []).map(normalizeEvent);
      const last = (lastData?.results || lastData?.events || []).map(normalizeEvent);

      items.push({ team, next, last, season });
    }

    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});




app.get("/me/schedule", async (req, res) => {
  const clientId = requireClientId(req);
  const season = String(req.query.season || "").trim();
  if (!season) return res.status(400).json({ error: "Missing query param: season" });

  const state = getState(clientId);
  const teamIds = state.teamIds;
  const schedules = [];

  for (const teamId of teamIds) {
    try {
      // team lookup (to get leagueId)
      const teamData = await get<any>(`/lookupteam.php?id=${encodeURIComponent(teamId)}`, 3600);
      const t = teamData?.teams?.[0];
      if (!t) {
        schedules.push({ team: { id: teamId }, season, events: [] });
        continue;
      }

      const team = normalizeTeam(t);

      // league season events, then filter to the team
      const seasonData = await get<any>(
        `/eventsseason.php?id=${encodeURIComponent(team.leagueId)}&s=${encodeURIComponent(season)}`,
        900
      );

      const eventsAll = (seasonData?.events || []).map(normalizeEvent);
      const events = eventsAll.filter(
        (e: any) => e.homeTeam?.id === teamId || e.awayTeam?.id === teamId
      );

      schedules.push({ team, season, events });
    } catch {
      schedules.push({ team: { id: teamId }, season, events: [] });
    }
  }

  res.json({ schedules });
});



// List all sports
app.get("/sports", async (_req, res) => {
  const data = await get<any>(`/all_sports.php`, 24 * 3600);
  res.json({ sports: data?.sports || [] });
});

// List leagues by country + sport (for EPL: England + Soccer)
app.get("/leagues", async (req, res) => {
  const country = String(req.query.country || "").trim();
  const sport = String(req.query.sport || "").trim();
  if (!country || !sport) {
    return res.status(400).json({ error: "Use ?country=England&sport=Soccer" });
  }

  const data = await get<any>(
    `/search_all_leagues.php?c=${encodeURIComponent(country)}&s=${encodeURIComponent(sport)}`,
    24 * 3600
  );

  res.json({ leagues: data?.countries || data?.countrys || data?.leagues || data || [] });
});


app.get("/teams", async (req, res) => {
  const leagueName = String(req.query.league || "").trim();
  if (!leagueName) return res.status(400).json({ error: "Use ?league=English_Premier_League" });

  const data = await get<any>(
    `/search_all_teams.php?l=${encodeURIComponent(leagueName)}`,
    24 * 3600
  );

  const teams = (data?.teams || []).map(normalizeTeam);
  res.json({ teams });
});

app.get("/leagues/:leagueId/seasons", async (req, res) => {
  const leagueId = req.params.leagueId;
  const data = await get<any>(
    `/search_all_seasons.php?id=${encodeURIComponent(leagueId)}`,
    24 * 3600
  );
  res.json({ seasons: data?.seasons || [] });
});


// League standings / table for a given season
app.get("/leagues/:leagueId/table", async (req, res) => {
  const leagueId = req.params.leagueId;
  const season = String(req.query.season || "").trim();
  if (!season) return res.status(400).json({ error: "Missing query param: season" });

  const data = await get<any>(
    `/lookuptable.php?l=${encodeURIComponent(leagueId)}&s=${encodeURIComponent(season)}`,
    900
  );

  // Normalize lightly; keep raw fields for flexibility in UI
  const table = (data?.table || []).map((r: any) => ({
    teamId: r.idTeam,
    teamName: r.name ?? r.strTeam ?? r.strTeamName ?? null,
    rank: Number(r.intRank),
    played: Number(r.intPlayed),
    win: Number(r.intWin),
    draw: Number(r.intDraw),
    loss: Number(r.intLoss),
    goalsFor: Number(r.intGoalsFor),
    goalsAgainst: Number(r.intGoalsAgainst),
    goalDiff: Number(r.intGoalDifference),
    points: Number(r.intPoints),
    form: r.strForm || null,
    badge: r.strTeamBadge || r.strBadge || null,
  }));


  res.json({ leagueId, season, table });
});

function requireClientId(req: any): string {
  const id = req.header("X-Client-Id");
  if (!id) throw new Error("Missing X-Client-Id header");
  return id;
}


function normalizePlayer(p: any) {
  return {
    id: p.idPlayer,
    name: p.strPlayer,
    team: p.strTeam,
    teamId: p.idTeam,
    sport: p.strSport,
    position: p.strPosition || null,
    nationality: p.strNationality || null,
    dateBorn: p.dateBorn || null,
    number: p.strNumber || null,
    wage: p.strWage || null,
    thumb: p.strThumb || null,
    cutout: p.strCutout || null,
    // Some players have basic per-season style fields, sometimes empty:
    height: p.strHeight || null,
    weight: p.strWeight || null,
    signing: p.strSigning || null,
    description: p.strDescriptionEN || null,
  };
}

const STAFF_POSITIONS = new Set([
  "Manager",
  "Head Coach",
  "Assistant Coach",
  "Coach",
  "Goalkeeping Coach",
  "Fitness Coach",
  "Director of Football",
]);

function isStaffEntry(position: string | null) {
  if (!position) return false;
  const p = position.toLowerCase();
  return (
    STAFF_POSITIONS.has(position) ||
    p.includes("coach") ||
    p.includes("manager") ||
    p.includes("director")
  );
}


// Team roster
app.get("/teams/:teamId/players", async (req, res) => {
  const teamId = req.params.teamId;

  const data = await get<any>(
    `/lookup_all_players.php?id=${encodeURIComponent(teamId)}`,
    6 * 3600
  );

  const roster = (data?.player || data?.players || []).map(normalizePlayer);

  const players = roster.filter((p: any) => !isStaffEntry(p.position));
  const staff = roster.filter((p: any) => isStaffEntry(p.position));

  res.json({ teamId, players, staff });
});


app.get("/players/:playerId", async (req, res) => {
  const playerId = req.params.playerId;
  const data = await get<any>(
    `/lookupplayer.php?id=${encodeURIComponent(playerId)}`,
    24 * 3600
  );

  const p = data?.players?.[0];
  if (!p) return res.status(404).json({ error: "Player not found" });

  res.json({ player: normalizePlayer(p) });
});

app.get("/teams/:teamId/hub", async (req, res) => {
  const teamId = req.params.teamId;
  const season = String(req.query.season || "").trim(); // optional

  // Team core info
  const t = await lookupTeamById(teamId);

  if (!t) return res.status(404).json({ error: "Team not found" });
  const team = normalizeTeam(t);

  const tasks: Promise<any>[] = [
    get<any>(`/eventsnext.php?id=${encodeURIComponent(teamId)}`, 120).catch(() => ({})),
    get<any>(`/eventslast.php?id=${encodeURIComponent(teamId)}`, 300).catch(() => ({})),
    get<any>(`/lookup_all_players.php?id=${encodeURIComponent(teamId)}`, 6 * 3600).catch(() => ({})),
  ];

  if (season) {
    tasks.push(
      get<any>(
        `/lookuptable.php?l=${encodeURIComponent(team.leagueId)}&s=${encodeURIComponent(season)}`,
        900
      ).catch(() => ({}))
    );
    tasks.push(
      get<any>(
        `/eventsseason.php?id=${encodeURIComponent(team.leagueId)}&s=${encodeURIComponent(season)}`,
        900
      ).catch(() => ({}))
    );
  }

  const [nextData, lastData, rosterData, tableData, seasonData] = await Promise.all(tasks);

  const next = (nextData?.events || []).map(normalizeEvent);
  const last = (lastData?.results || lastData?.events || []).map(normalizeEvent);

  // roster split
  const roster = (rosterData?.player || rosterData?.players || []).map(normalizePlayer);
  const players = roster.filter((p: any) => !isStaffEntry(p.position));
  const staff = roster.filter((p: any) => isStaffEntry(p.position));

  let table: any[] | null = null;
  let schedule: any[] | null = null;

  if (season) {
    table = (tableData?.table || []).map((r: any) => ({
      teamId: r.idTeam,
      teamName: r.name ?? r.strTeam ?? r.strTeamName ?? null,
      rank: Number(r.intRank),
      played: Number(r.intPlayed),
      points: Number(r.intPoints),
      goalDiff: Number(r.intGoalDifference),
      form: r.strForm || null,
      badge: r.strTeamBadge || r.strBadge || null,
    }));

    const eventsAll = (seasonData?.events || []).map(normalizeEvent);
    schedule = eventsAll.filter(
      (e: any) => e.homeTeam?.id === teamId || e.awayTeam?.id === teamId
    );
  }

  res.json({
    team,
    season: season || null,
    next,
    last,
    players,
    staff,
    table,
    schedule,
    limits: {
      schedule: "Free key may return partial season events; cache and degrade gracefully.",
    },
  });
});

app.post("/me/reset", (req, res) => {
  const clientId = requireClientId(req);
  clearState(clientId);
  res.json({ ok: true });
});

app.get("/me/debug", (req, res) => {
  const clientId = requireClientId(req);
  const state = getState(clientId);
  res.json({ clientId, teamIds: state.teamIds });
});

app.get("/__version", (_req, res) => {
  res.json({
    version: "cafc1fc",
    hasMeDebug: true,
    time: new Date().toISOString(),
  });
});

app.get("/__config", (_req, res) => {
  const k = process.env.SPORTSDB_API_KEY || "123";
  res.json({
    hasEnvKey: !!process.env.SPORTSDB_API_KEY,
    keyLooksLikeDemo123: k === "123",
    keyLength: k.length,
    baseHost: "www.thesportsdb.com",
    usingV1: true,
  });
});

async function lookupTeamById(id: string) {
  const key = process.env.SPORTSDB_API_KEY ?? "123"; // free key fallback
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/lookupteam.php?id=${encodeURIComponent(id)}&_=${Date.now()}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SportsDB lookupteam failed: ${res.status}`);

  const json = await res.json();
  const t = json?.teams?.[0];

  // Guard against the “always Arsenal” bug / bad cache
  if (!t || t.idTeam !== id) {
    throw new Error(
      `SportsDB lookupteam mismatch (wanted ${id}, got ${t?.idTeam ?? "none"})`
    );
  }
  return t;
}



app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "sports-app-api", routes: true });
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://0.0.0.0:${PORT}`);
});


