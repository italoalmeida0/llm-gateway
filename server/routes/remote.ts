import { db, audit, type RemoteHostRow, type RemotePairingTokenRow } from "../db";
import { requireAuth } from "../auth";
import { createKey, revokeKey } from "../keys";
import { randomToken, sha256Hex } from "../crypto";
import { err, json, readJsonBody } from "../http";
import { PUBLIC_URL } from "../config";
import { closeDaemonSocket } from "./relay";
import { publicModelEntry, routerSnapshot } from "../models";

/**
 * Remote Code REST endpoints:
 *  - GET    /api/remote/models         -> gateway model metadata (daemon token)
 *  - POST   /api/remote/pair           -> generate a temporary pairing token + connect URL
 *  - POST   /api/remote/connect/:token -> daemon handshake (exchanges pairing token for persistent host credentials + API key)
 *  - GET    /api/remote/hosts          -> list user's registered remote hosts
 *  - DELETE /api/remote/hosts/:id      -> disconnect host (revokes daemon access & dedicated API key)
 */

export async function handleRemoteRestRoute(
  path: string,
  req: Request,
  _url: URL,
): Promise<Response | null> {
  // The daemon reads the configured registry even in passthrough mode.
  // /v1/models may proxy an upstream catalog with different limits.
  if (path === "/api/remote/models" && req.method === "GET") {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    const host = db.prepare<{ id: string }, [string]>(
      `SELECT h.id FROM remote_hosts h JOIN users u ON u.id = h.user_id
       WHERE h.daemon_token_hash = ? AND u.status = 'active'`,
    ).get(sha256Hex(token));
    if (!host) return err(401, "unauthorized daemon token", req);
    const snap = await routerSnapshot();
    const models = Array.from(snap.models.values())
      .filter((m) => m.enabled && m.proto !== "anthropic")
      .map((m) => publicModelEntry(m, "gateway"));
    return json({ success: true, models }, { req });
  }

  // POST /api/remote/pair
  if (path === "/api/remote/pair" && req.method === "POST") {
    const { user } = await requireAuth(req);
    const token = randomToken(16);
    const now = Date.now();
    const expiresAt = now + 15 * 60_000; // 15 minutes TTL

    db.prepare(
      "INSERT INTO remote_pairing_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(token, user.id, expiresAt, now);

    audit("remote_host.pair_token_created", { actorId: user.id });

    return json(
      {
        success: true,
        token,
        connectUrl: `${PUBLIC_URL}/api/remote/connect/${token}`,
        expiresAt,
      },
      { req },
    );
  }

  // POST /api/remote/connect/:token (called by the daemon during initial setup)
  if (path.startsWith("/api/remote/connect/") && req.method === "POST") {
    const token = path.slice("/api/remote/connect/".length).trim();
    if (!token) return err(400, "missing pairing token", req);

    const now = Date.now();
    const row = db
      .prepare<RemotePairingTokenRow, [string, number]>(
        "SELECT * FROM remote_pairing_tokens WHERE token = ? AND expires_at > ?",
      )
      .get(token, now);

    if (!row) {
      return err(401, "invalid or expired pairing token", req);
    }

    // Single-use token: consume immediately
    db.prepare("DELETE FROM remote_pairing_tokens WHERE token = ?").run(token);

    let body: any = null;
    try {
      body = await readJsonBody(req, 16 * 1024);
    } catch {}

    const hostName = (body?.name || body?.hostname || "Remote Machine").slice(0, 64);
    const hostname = (body?.hostname || "").slice(0, 128);
    const os = (body?.os || "").slice(0, 32);
    const arch = (body?.arch || "").slice(0, 32);

    const hostId = `host_${randomToken(12)}`;
    const daemonToken = `dmt_${randomToken(24)}`;
    const daemonTokenHash = sha256Hex(daemonToken);

    // Create a dedicated gateway API key for this daemon so its LLM calls are attributed to this user
    const { row: apiKeyRow, token: apiKeyValue } = await createKey(row.user_id, {
      name: `Daemon: ${hostName}`,
    });

    db.prepare(
      `INSERT INTO remote_hosts (id, user_id, name, hostname, os, arch, daemon_token_hash, api_key_id, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?)`,
    ).run(
      hostId,
      row.user_id,
      hostName,
      hostname,
      os,
      arch,
      daemonTokenHash,
      apiKeyRow.id,
      now,
      now,
    );

    audit("remote_host.paired", {
      actorId: row.user_id,
      target: hostId,
      meta: { hostname, os, arch },
    });

    return json(
      {
        success: true,
        hostId,
        daemonToken,
        apiKey: apiKeyValue,
        gatewayUrl: PUBLIC_URL,
      },
      { req },
    );
  }

  // GET /api/remote/hosts
  if (path === "/api/remote/hosts" && req.method === "GET") {
    const { user } = await requireAuth(req);
    const rows = db
      .prepare<RemoteHostRow, [string]>(
        "SELECT id, user_id, name, hostname, os, arch, api_key_id, status, last_seen_at, created_at FROM remote_hosts WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(user.id);

    const hosts = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      hostname: r.hostname,
      os: r.os,
      arch: r.arch,
      apiKeyId: r.api_key_id,
      status: r.status,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    }));

    return json({ success: true, hosts }, { req });
  }

  // DELETE /api/remote/hosts/:id
  if (path.startsWith("/api/remote/hosts/") && req.method === "DELETE") {
    const { user } = await requireAuth(req);
    const hostId = path.slice("/api/remote/hosts/".length).trim();

    const host = db
      .prepare<RemoteHostRow, [string, string]>(
        "SELECT * FROM remote_hosts WHERE id = ? AND user_id = ?",
      )
      .get(hostId, user.id);

    if (!host) return err(404, "host not found", req);

    // Close any active WebSocket connection for this daemon
    closeDaemonSocket(host.id);

    // Revoke dedicated API key if exists
    if (host.api_key_id) {
      try {
        revokeKey(host.api_key_id);
      } catch {}
    }

    db.prepare("DELETE FROM remote_hosts WHERE id = ?").run(host.id);
    audit("remote_host.deleted", { actorId: user.id, target: host.id });

    return json({ success: true }, { req });
  }

  return null;
}
