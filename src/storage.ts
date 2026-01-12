import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const FOLLOWS_FILE = path.join(DATA_DIR, "follows_by_client.json");

type FollowsByClient = Record<string, string[]>;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function getFollows(clientId: string): string[] {
  ensureDataDir();
  if (!fs.existsSync(FOLLOWS_FILE)) return [];
  const raw = fs.readFileSync(FOLLOWS_FILE, "utf-8");
  const db = (raw ? JSON.parse(raw) : {}) as FollowsByClient;
  return db[clientId] ?? [];
}

export function setFollows(clientId: string, teamIds: string[]) {
  ensureDataDir();
  const db: FollowsByClient = fs.existsSync(FOLLOWS_FILE)
    ? JSON.parse(fs.readFileSync(FOLLOWS_FILE, "utf-8") || "{}")
    : {};

  // de-duplicate
  db[clientId] = Array.from(new Set(teamIds));
  fs.writeFileSync(FOLLOWS_FILE, JSON.stringify(db, null, 2), "utf-8");
}

export function clearFollows(clientId: string) {
  setFollows(clientId, []);
}

