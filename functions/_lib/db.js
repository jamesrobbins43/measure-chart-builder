// creates the tables the first time they're needed, so no manual database setup is required
let ready=null;
export function ensure(env){
  if(!ready) ready=env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, dur REAL NOT NULL, data TEXT NOT NULL, saved_at TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS songs_dur ON songs(dur)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS uses (id TEXT PRIMARY KEY, title TEXT, artist TEXT, song_key TEXT, dur REAL, who TEXT, at TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS uses_at ON uses(at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, sent_at TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)')
  ]).catch(e=>{ ready=null; throw e; });
  return ready;
}
