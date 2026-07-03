-- Baseline schema, matching backend/schema.txt.
-- IF NOT EXISTS makes this safe to run against a database that already has
-- these tables (e.g. the existing Turso DB, created manually before this
-- migration runner existed).

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  case_name TEXT NOT NULL,
  access_code TEXT,
  initial_brief TEXT NOT NULL,
  common_information TEXT,
  simulation_duration INTEGER,
  non_referred INTEGER NOT NULL CHECK (non_referred >= 1)
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  case_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  profile_photo_file_id TEXT,
  known_facts TEXT,
  unknown_facts TEXT,
  hidden_facts TEXT,
  personality_traits TEXT,
  scheduled_time INTEGER NOT NULL DEFAULT 0,
  availability_duration INTEGER,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (profile_photo_file_id) REFERENCES files(id) ON DELETE SET NULL
);

-- trigger_type uses a CHECK constraint instead of a SQL enum.
CREATE TABLE IF NOT EXISTS persona_referrals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  case_id TEXT NOT NULL,
  parent_persona_id TEXT NOT NULL,
  referred_persona_id TEXT NOT NULL,
  trigger_type TEXT CHECK(trigger_type IN ('conditions', 'time')),
  condition_trigger TEXT,
  time_trigger INTEGER,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_persona_id) REFERENCES personas(id) ON DELETE CASCADE,
  FOREIGN KEY (referred_persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

-- Metadata for objects stored in DigitalOcean Spaces.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT,
  upload_status TEXT NOT NULL DEFAULT 'uploaded',
  UNIQUE(bucket, object_key)
);

CREATE TABLE IF NOT EXISTS persona_files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  persona_id TEXT NOT NULL,
  file_id TEXT,
  share_conditions TEXT,
  perceived_contents TEXT,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
);
