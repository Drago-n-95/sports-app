import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state_by_client.json");

export type StoredTeam = {
  id: string;
  name: string;
  shortName: string | null;
  sport: string;
  league: string;
  leagueId: string | null;
  stadium: string | null;
  country: string | null;
  badge: string | null;
  logo: string | null;
  banner: string | null;
};

export type FollowState = {
  teamIds: string[];
  teamsById: Record<string, StoredTeam>;
};

type DB = Record<string, FollowState>;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDB(): DB {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) return {};
  const raw = fs.readFileSync(STATE_FILE, "utf-8");
  return (raw ? JSON.parse(raw) : {}) as DB;
}

function writeDB(db: DB) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(db, null, 2), "utf-8");
}

export function getState(clientId: string): FollowState {
  const db = readDB();
  return db[clientId] ?? { teamIds: [], teamsById: {} };
}

export function setTeamIds(clientId: string, teamIds: string[]) {
  const db = readDB();
  const prev = db[clientId] ?? { teamIds: [], teamsById: {} };
  db[clientId] = { ...prev, teamIds: Array.from(new Set(teamIds.map(String))) };
  writeDB(db);
}

export function addTeams(clientId: string, teams: StoredTeam[]) {
  const db = readDB();
  const prev = db[clientId] ?? { teamIds: [], teamsById: {} };

  const teamsById = { ...prev.teamsById };
  const ids = [...prev.teamIds];

  for (const t of teams) {
    teamsById[t.id] = t;
    ids.push(t.id);
  }

  db[clientId] = {
    teamIds: Array.from(new Set(ids)),
    teamsById,
  };

  writeDB(db);
}

export function clearState(clientId: string) {
  const db = readDB();
  db[clientId] = { teamIds: [], teamsById: {} };
  writeDB(db);
}

