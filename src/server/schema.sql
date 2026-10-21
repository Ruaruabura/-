CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), sourceMessageId TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','paused','failed','completed','cancelled')), reason TEXT, limits TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), taskId TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, createdAt TEXT NOT NULL, clientId TEXT, UNIQUE(conversationId,clientId));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT REFERENCES tasks(id), conversationId TEXT NOT NULL REFERENCES conversations(id), type TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS results(taskId TEXT PRIMARY KEY REFERENCES tasks(id), data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_conversation ON events(conversationId,seq);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,createdAt);
PRAGMA user_version=1;

CREATE TABLE IF NOT EXISTS task_materials(taskId TEXT PRIMARY KEY REFERENCES tasks(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prepared_materials(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_transcripts(taskId TEXT PRIMARY KEY REFERENCES tasks(id), text TEXT NOT NULL);
