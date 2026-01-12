import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { readFollows, writeFollows } from "./storage";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.SPORTSDB_API_KEY || "3";
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
  const cached = cacheGet(url);
  if (cached) return cached as T;

  const resp = await axios.get<T>(url, { timeout: 10_000 });
  cacheSet(url, resp.data, ttlSeconds);
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
app.get("/teams/:teamId", async (req, res) => {
  const teamId = req.params.teamId;
  // TheSportsDB commonly provides lookupteam.php?id=
  const data = await get<any>(`/lookupteam.php?id=${encodeURIComponent(teamId)}`, 3600);
  const team = data?.teams?.[0] ? normalizeTeam(data.teams[0]) : null;
  if (!team) return res.status(404).json({ error: "Team not found" });
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
  const teamData = await get<any>(`/lookupteam.php?id=${encodeURIComponent(teamId)}`, 3600);
  const t = teamData?.teams?.[0];
  if (!t) return res.status(404).json({ error: "Team not found" });

  const team = normalizeTeam(t);
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


// --- Followed teams (MVP "single device profile") ---

// Set followed teams
app.post("/me/follows", (req, res) => {
  const teamIds = req.body?.teamIds;
  if (!Array.isArray(teamIds)) {
    return res.status(400).json({ error: "Body must be { teamIds: string[] }" });
  }
  writeFollows(teamIds);
  res.json({ ok: true, teamIds: Array.from(new Set(teamIds.map(String))) });
});

// Get followed teams (team objects)
app.get("/me/follows", async (_req, res) => {
  const { teamIds } = readFollows();
  const teams: any[] = [];

  for (const id of teamIds) {
    try {
      const data = await get<any>(`/lookupteam.php?id=${encodeURIComponent(id)}`, 3600);
      const t = data?.teams?.[0];
      if (t) teams.push(normalizeTeam(t));
    } catch {
      // ignore individual failures for resilience
    }
  }
  res.json({ teamIds, teams });
});

// Aggregated "feed" for Schedule tab: last + next per followed team
app.get("/me/feed", async (_req, res) => {
  const { teamIds } = readFollows();

  const items = [];
  for (const teamId of teamIds) {
    try {
      const [teamData, nextData, lastData] = await Promise.all([
        get<any>(`/lookupteam.php?id=${encodeURIComponent(teamId)}`, 3600),
        get<any>(`/eventsnext.php?id=${encodeURIComponent(teamId)}`, 120),
        get<any>(`/eventslast.php?id=${encodeURIComponent(teamId)}`, 300),
      ]);

      const team = teamData?.teams?.[0] ? normalizeTeam(teamData.teams[0]) : { id: teamId };
      const next = (nextData?.events || []).map(normalizeEvent);
      const last = (lastData?.results || lastData?.events || []).map(normalizeEvent);

      items.push({ team, next, last });
    } catch {
      items.push({ team: { id: teamId }, next: [], last: [] });
    }
  }

  res.json({ items });
});

// Aggregated season schedule for all followed teams
app.get("/me/schedule", async (req, res) => {
  const season = String(req.query.season || "").trim();
  if (!season) return res.status(400).json({ error: "Missing query param: season" });

  const { teamIds } = readFollows();

  const schedules = [];
  for (const teamId of teamIds) {
    try {
      const [teamData, seasonData] = await Promise.all([
        get<any>(`/lookupteam.php?id=${encodeURIComponent(teamId)}`, 3600),
        get<any>(`/eventsseason.php?id=${encodeURIComponent(teamId)}&s=${encodeURIComponent(season)}`, 900),
      ]);

      const team = teamData?.teams?.[0] ? normalizeTeam(teamData.teams[0]) : { id: teamId };
      const events = (seasonData?.events || []).map(normalizeEvent);

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
  const teamData = await get<any>(`/lookupteam.php?id=${encodeURIComponent(teamId)}`, 3600);
  const t = teamData?.teams?.[0];
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



app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://0.0.0.0:${PORT}`);
});


