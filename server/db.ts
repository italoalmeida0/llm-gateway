import { Database } from "bun:sqlite";
import path from "path";

import { DATA_DIR } from "./config";

/**
 * SQLite via bun:sqlite (built into the runtime, WAL mode). Migrations are
 * applied in order and tracked with PRAGMA user_version. All hot-path
 * statements are prepared once at module scope.
 */

export const db = new Database(path.join(DATA_DIR, "gateway.db"), { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

type Migration = { name: string; up: string };

const MIGRATIONS: Migration[] = [
  {
    name: "001_init",
    up: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
        password_hash TEXT,
        google_id     TEXT UNIQUE,
        totp_secret   TEXT,
        totp_pending  TEXT,
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE sessions (
        jti          TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        refresh_hash TEXT NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        abs_expires_at INTEGER NOT NULL,
        revoked      INTEGER NOT NULL DEFAULT 0,
        ip           TEXT,
        ua           TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE providers (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        openai_base_url    TEXT,             -- e.g. https://provider/openai/v1
        anthropic_base_url TEXT,             -- e.g. https://provider/anthropic/v1
        api_key_enc        TEXT NOT NULL,
        enabled            INTEGER NOT NULL DEFAULT 1,
        priority           INTEGER NOT NULL DEFAULT 100,
        created_at         INTEGER NOT NULL
      );

      CREATE TABLE api_keys (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL DEFAULT '',
        prefix      TEXT NOT NULL,
        hash        TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER,
        daily_limit INTEGER,
        total_limit INTEGER,
        rpm         INTEGER,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','exhausted')),
        last_used_at INTEGER,
        last_used_ip TEXT
      );
      CREATE INDEX idx_api_keys_user ON api_keys(user_id);

      CREATE TABLE usage_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id     TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        proto      TEXT NOT NULL CHECK (proto IN ('openai','anthropic')),
        model      TEXT NOT NULL DEFAULT '',
        in_tok     INTEGER NOT NULL DEFAULT 0,
        out_tok    INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status     INTEGER NOT NULL DEFAULT 200,
        stream     INTEGER NOT NULL DEFAULT 0,
        estimated  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_usage_key_ts ON usage_events(key_id, ts);
      CREATE INDEX idx_usage_user_ts ON usage_events(user_id, ts);
      CREATE INDEX idx_usage_ts ON usage_events(ts);

      CREATE TABLE usage_daily (
        key_id  TEXT NOT NULL,
        user_id TEXT NOT NULL,
        date    TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
        in_tok  INTEGER NOT NULL DEFAULT 0,
        out_tok INTEGER NOT NULL DEFAULT 0,
        reqs    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date)
      );
      CREATE INDEX idx_usage_daily_user ON usage_daily(user_id, date);

      CREATE TABLE password_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('invite','reset')),
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      );

      CREATE TABLE audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        actor_id TEXT,
        action   TEXT NOT NULL,
        target   TEXT,
        meta     TEXT,
        ip       TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);
    `,
  },
  {
    name: "002_provider_auth_styles",
    up: `
      -- How the upstream expects the real key: 'bearer' (Authorization: Bearer k)
      -- or 'x-api-key' (x-api-key: k). Defaults preserve the old hardcoded behavior.
      ALTER TABLE providers ADD COLUMN openai_auth_style     TEXT NOT NULL DEFAULT 'bearer';
      ALTER TABLE providers ADD COLUMN anthropic_auth_style  TEXT NOT NULL DEFAULT 'x-api-key';
    `,
  },
  {
    name: "003_session_labels",
    up: `
      -- Optional user-facing device name ("my laptop"); survives token rotation.
      ALTER TABLE sessions ADD COLUMN label TEXT;
    `,
  },
  {
    name: "004_key_token_enc",
    up: `
      -- AES-encrypted copy of the plaintext token so owners/admins can reveal
      -- it later (hash remains the proxy lookup key; every reveal is audited).
      ALTER TABLE api_keys ADD COLUMN token_enc TEXT;
    `,
  },
];

export function migrate(): void {
  const row = Object.values(
    db.query<Record<string, number>, []>("PRAGMA user_version").get() ?? {},
  );
  let version = Number(row[0] ?? 0);
  for (let i = version; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!;
    db.transaction(() => {
      db.exec(m.up);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
    console.log(`[DB] migration applied: ${m.name}`);
    version = i + 1;
  }
}

migrate();

// ===== Row types =====

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  password_hash: string | null;
  google_id: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  status: "active" | "banned";
  created_at: number;
  last_login_at: number | null;
}

export interface SessionRow {
  jti: string;
  user_id: string;
  refresh_hash: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  abs_expires_at: number;
  revoked: number;
  ip: string | null;
  ua: string | null;
  label: string | null;
}

export type AuthStyle = "bearer" | "x-api-key";

export interface ProviderRow {
  id: string;
  name: string;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  api_key_enc: string;
  enabled: number;
  priority: number;
  created_at: number;
  openai_auth_style: AuthStyle;
  anthropic_auth_style: AuthStyle;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: number;
  expires_at: number | null;
  daily_limit: number | null;
  total_limit: number | null;
  rpm: number | null;
  status: "active" | "revoked" | "exhausted";
  last_used_at: number | null;
  last_used_ip: string | null;
  token_enc: string | null;
}

// ===== Prepared statements (hot paths) =====

export const stmts = {
  userById: db.prepare<UserRow, [string]>("SELECT * FROM users WHERE id = ?"),
  userByEmail: db.prepare<UserRow, [string]>("SELECT * FROM users WHERE email = ?"),
  userByGoogleId: db.prepare<UserRow, [string]>("SELECT * FROM users WHERE google_id = ?"),
  keyByHash: db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE hash = ?"),
  sessionByJti: db.prepare<SessionRow, [string]>("SELECT * FROM sessions WHERE jti = ?"),
  sessionByRefreshHash: db.prepare<SessionRow, [string]>(
    "SELECT * FROM sessions WHERE refresh_hash = ?",
  ),
  keyToday: db.prepare<{ in_tok: number; out_tok: number; reqs: number }, [string, string]>(
    "SELECT in_tok, out_tok, reqs FROM usage_daily WHERE key_id = ? AND date = ?",
  ),
  keyTotal: db.prepare<{ total: number }, [string]>(
    "SELECT COALESCE(SUM(in_tok + out_tok), 0) AS total FROM usage_daily WHERE key_id = ?",
  ),
};

export function audit(
  action: string,
  opts: { actorId?: string | null; target?: string | null; meta?: unknown; ip?: string | null } = {},
): void {
  db.prepare(
    "INSERT INTO audit_log (ts, actor_id, action, target, meta, ip) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    Date.now(),
    opts.actorId ?? null,
    action,
    opts.target ?? null,
    opts.meta === undefined ? null : JSON.stringify(opts.meta),
    opts.ip ?? null,
  );
}
