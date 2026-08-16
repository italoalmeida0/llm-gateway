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
  {
    name: "005_cache_tok",
    up: `
      -- Providers bill cached input tokens at their own rate, so they get a
      -- dedicated column: in_tok stays the cache-free input share, cache_tok
      -- counts the cached share (Anthropic: read + creation). Rows that
      -- predate this migration simply keep cache_tok = 0 (they never had the
      -- cached share in in_tok either).
      ALTER TABLE usage_events ADD COLUMN cache_tok INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_daily  ADD COLUMN cache_tok INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: "006_usage_model_daily",
    up: `
      -- Per-model daily rollup, fed by the same flush that writes usage_daily.
      -- The per-model dashboard queries (admin stats + /api/usage/by-model)
      -- used to GROUP BY over raw usage_events, which grows linearly (~3330ms
      -- at 3.65M events / 10y in the growth sim — see docs/performance). The
      -- rollup answers the same questions in ~30ms/~4ms at that scale.
      -- The one-time backfill below costs ~4s per GB of existing history.
      CREATE TABLE usage_model_daily (
        key_id    TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        date      TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
        proto     TEXT NOT NULL,
        model     TEXT NOT NULL,
        in_tok    INTEGER NOT NULL DEFAULT 0,
        cache_tok INTEGER NOT NULL DEFAULT 0,
        out_tok   INTEGER NOT NULL DEFAULT 0,
        reqs      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date, proto, model)
      ) WITHOUT ROWID;
      CREATE INDEX idx_usage_model_daily_user ON usage_model_daily(user_id, date);
      INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
        SELECT key_id, user_id, date(ts/1000, 'unixepoch'), proto, model,
               SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*)
        FROM usage_events
        GROUP BY key_id, date(ts/1000, 'unixepoch'), proto, model;
    `,
  },
  {
    name: "007_models",
    // Model registry + routing mode. Deleting a provider orphans its models
    // (provider_id -> NULL) instead of deleting them: usage history and the
    // admin registry survive, and the admin can re-link them later.
    up: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE models (
        id                TEXT PRIMARY KEY,         -- public id clients send
        provider_id       TEXT REFERENCES providers(id) ON DELETE SET NULL,
        upstream_model    TEXT NOT NULL,            -- id the provider receives
        proto             TEXT NOT NULL DEFAULT 'openai' CHECK (proto IN ('openai','anthropic')),
        name              TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        hugging_face_id   TEXT NOT NULL DEFAULT '',
        quantization      TEXT NOT NULL DEFAULT '',
        openrouter_slug   TEXT NOT NULL DEFAULT '',
        always_on         INTEGER NOT NULL DEFAULT 1,
        enabled           INTEGER NOT NULL DEFAULT 1,
        context_length    INTEGER,
        max_output_length INTEGER,
        created           INTEGER,                  -- unix seconds (upstream)
        input_modalities  TEXT NOT NULL DEFAULT '["text"]',
        output_modalities TEXT NOT NULL DEFAULT '["text"]',
        sampling_params   TEXT NOT NULL DEFAULT '[]',
        features          TEXT NOT NULL DEFAULT '[]',
        reasoning_efforts TEXT,                     -- JSON array, NULL = unknown
        pricing           TEXT,                     -- JSON object, NULL = unknown
        datacenters       TEXT,                     -- JSON array, NULL = unknown
        source            TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_models_provider ON models(provider_id);
    `,
  },
  {
    name: "008_model_proto_both",
    // A registry entry may serve BOTH protocol surfaces (proto = 'both').
    // SQLite can't alter a CHECK constraint, so the table is rebuilt.
    up: `
      CREATE TABLE models_new (
        id                TEXT PRIMARY KEY,
        provider_id       TEXT REFERENCES providers(id) ON DELETE SET NULL,
        upstream_model    TEXT NOT NULL,
        proto             TEXT NOT NULL DEFAULT 'openai' CHECK (proto IN ('openai','anthropic','both')),
        name              TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        hugging_face_id   TEXT NOT NULL DEFAULT '',
        quantization      TEXT NOT NULL DEFAULT '',
        openrouter_slug   TEXT NOT NULL DEFAULT '',
        always_on         INTEGER NOT NULL DEFAULT 1,
        enabled           INTEGER NOT NULL DEFAULT 1,
        context_length    INTEGER,
        max_output_length INTEGER,
        created           INTEGER,
        input_modalities  TEXT NOT NULL DEFAULT '["text"]',
        output_modalities TEXT NOT NULL DEFAULT '["text"]',
        sampling_params   TEXT NOT NULL DEFAULT '[]',
        features          TEXT NOT NULL DEFAULT '[]',
        reasoning_efforts TEXT,
        pricing           TEXT,
        datacenters       TEXT,
        source            TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      INSERT INTO models_new SELECT * FROM models;
      DROP TABLE models;
      ALTER TABLE models_new RENAME TO models;
      CREATE INDEX idx_models_provider ON models(provider_id);
    `,
  },
  {
    name: "009_failover",
    // Upstream failover: N keys per provider (ordered by priority) and N
    // routing targets per model ((provider, upstream_model) pairs, ordered).
    // The proxy falls through to the next key/target when the preferred one
    // is exhausted (billing/auth) or cooling down (>=3 consecutive transient
    // failures) — see server/failover.ts.
    //
    // Mirror rule: providers.api_key_enc and models.provider_id /
    // models.upstream_model stay as a denormalized mirror of the top-1
    // (lowest-priority) entry, recomputed after every mutation, so pre-009
    // readers (sync, admin listing) keep working. The last key of a provider
    // can never be deleted (api_key_enc is NOT NULL).
    up: `
      CREATE TABLE provider_keys (
        id               TEXT PRIMARY KEY,
        provider_id      TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        label            TEXT NOT NULL DEFAULT '',
        api_key_enc      TEXT NOT NULL,
        priority         INTEGER NOT NULL DEFAULT 100,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','exhausted')),
        fail_count       INTEGER NOT NULL DEFAULT 0,
        cooldown_until   INTEGER,
        exhausted_reason TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_provider_keys_provider ON provider_keys(provider_id, priority);

      CREATE TABLE model_targets (
        model_id       TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE ON UPDATE CASCADE,
        provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_model TEXT NOT NULL,
        priority       INTEGER NOT NULL DEFAULT 100,
        enabled        INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (model_id, provider_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_model_targets_provider ON model_targets(provider_id);

      -- Backfill: legacy single key / single provider link become the
      -- priority-0 entries of the new tables.
      INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
        SELECT 'pk_' || lower(hex(randomblob(8))), id, 'primary', api_key_enc, 0, 'active', created_at, created_at
        FROM providers;
      INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at)
        SELECT id, provider_id, upstream_model, 0, 1, created_at FROM models WHERE provider_id IS NOT NULL;
    `,
  },
  {
    name: "010_session_families",
    // Refresh-token rotation chains get a family id (the jti of the chain's
    // first session). Presenting a refresh token that was ALREADY rotated
    // away (its session row revoked) is theft evidence: the whole family is
    // revoked, killing the thief's rotated-forward session too (OWASP
    // refresh-token reuse detection).
    up: `
      ALTER TABLE sessions ADD COLUMN family TEXT;
      UPDATE sessions SET family = jti WHERE family IS NULL;
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
  // Give the query planner table statistics. Without ANALYZE data, SQLite
  // picks bad plans once usage_events grows (measured: the admin 24h per-user
  // aggregate went 287ms -> 0.5ms at 3.65M rows only because of this; see
  // docs/performance). Incremental: cheap no-op once stats exist.
  db.exec("PRAGMA optimize");
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
  family: string | null;
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

/** How the proxy maps `body.model` to an upstream provider.
 *  - passthrough (default): the model string goes to the provider untouched.
 *  - router: the model MUST exist in the registry and is rewritten to the
 *    registered upstream_model of its provider. */
export type RoutingMode = "passthrough" | "router";

/** Protocol surface(s) a registry entry serves: one of them, or 'both'. */
export type ModelProto = "openai" | "anthropic" | "both";

/** A registered public model id (Model Registry). `upstream_model` is what the
 *  provider actually receives; `id` is what gateway clients send. */
export interface ModelRow {
  id: string;
  /** NULL = orphaned (its provider was deleted without cascade). */
  provider_id: string | null;
  upstream_model: string;
  proto: ModelProto;
  name: string;
  description: string;
  hugging_face_id: string;
  quantization: string;
  openrouter_slug: string;
  always_on: number;
  enabled: number;
  context_length: number | null;
  max_output_length: number | null;
  /** Unix seconds (upstream creation time), NULL when unknown. */
  created: number | null;
  /** JSON arrays/objects (validated on write). */
  input_modalities: string;
  output_modalities: string;
  sampling_params: string;
  features: string;
  reasoning_efforts: string | null;
  pricing: string | null;
  datacenters: string | null;
  source: "auto" | "manual";
  created_at: number;
  updated_at: number;
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

/** One upstream API key of a provider (failover chain, ordered by priority).
 *  `exhausted` = detected out-of-credits ('billing', auto-retried after
 *  midnight UTC) or rejected credential ('auth', stays down until re-enabled).
 *  `cooldown_until` covers transient/rate-limit backoff. */
export interface ProviderKeyRow {
  id: string;
  provider_id: string;
  label: string;
  api_key_enc: string;
  priority: number;
  status: "active" | "disabled" | "exhausted";
  fail_count: number;
  cooldown_until: number | null;
  exhausted_reason: string | null;
  created_at: number;
  updated_at: number;
}

/** One routing destination of a registered model: which provider serves it
 *  and under which upstream id. The ordered list (priority ASC) is the
 *  per-model fallback chain. */
export interface ModelTargetRow {
  model_id: string;
  provider_id: string;
  upstream_model: string;
  priority: number;
  enabled: number;
  created_at: number;
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
