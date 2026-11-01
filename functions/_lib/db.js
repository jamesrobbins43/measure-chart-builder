// creates the library table the first time it's needed, so no manual database setup is required
let ready=null;
export function ensure(env){
  if(!ready) ready=env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, dur REAL NOT NULL, data TEXT NOT NULL, saved_at TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS songs_dur ON songs(dur)')
  ]).catch(e=>{ ready=null; throw e; });
  return ready;
}
