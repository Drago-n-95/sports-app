import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const FOLLOWS_FILE = path.join(DATA_DIR, "follows.json");

// For MVP without auth, we store a single "device" profile.
// Later you will replace this with per-user storage in a DB.
type FollowsState = {
  teamIds: string[];
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readFollows(): FollowsState {
  ensureDataDir();
  if (!fs.existsSync(FOLLOWS_FILE)) return { teamIds: [] };
  try {
    const raw = fs.readFileSync(FOLLOWS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.teamIds)) return { teamIds: [] };
    return { teamIds: parsed.teamIds.map(String) };
  } catch {
    return { teamIds: [] };
  }
}

export function writeFollows(teamIds: string[]) {
  ensureDataDir();
  const unique = Array.from(new Set(teamIds.map(String)));
  fs.writeFileSync(FOLLOWS_FILE, JSON.stringify({ teamIds: unique }, null, 2));
}

