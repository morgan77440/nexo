import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL(".", import.meta.url));
const databasePath = process.env.NEXO_DB_PATH || join(root, "nexo-local.sqlite");
const database = new DatabaseSync(databasePath);
let schemaVersion = database.prepare("PRAGMA user_version").get().user_version;
if (schemaVersion > 1) {
  throw new Error(`La base SQLite est en version ${schemaVersion}, plus récente que ce serveur.`);
}
const migrations = [
  {
    version: 1,
    apply() {
      database.exec(readFileSync(join(root, "local-schema.sql"), "utf8"));
    },
  },
];
for (const migration of migrations) {
  if (schemaVersion >= migration.version) continue;
  database.exec("BEGIN IMMEDIATE");
  try {
    migration.apply();
    database.exec(`PRAGMA user_version = ${migration.version}`);
    database.exec("COMMIT");
    schemaVersion = migration.version;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
database.exec("PRAGMA journal_mode = WAL;");
if (databasePath !== ":memory:") {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}
database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());

const port = Number(process.env.PORT || 4173);
const bindHost = process.env.NEXO_BIND_HOST || "0.0.0.0";
const sessionMaxAge = 60 * 60 * 24 * 7;
const cookieName = "nexo_session";
const scrypt = promisify(scryptCallback);
const rateBuckets = new Map();
const assets = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
};
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password, salt = randomBytes(16)) {
  return {
    salt,
    hash: await scrypt(password, salt, 64),
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    user_metadata: { display_name: user.display_name },
    app_metadata: { role: user.role },
  };
}

function setSessionCookie(response, token) {
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAge}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

function readCookie(request, name) {
  const cookies = (request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function sessionFor(request) {
  const token = readCookie(request, cookieName);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = database
    .prepare(
      `SELECT users.*, sessions.token_hash
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    )
    .get(tokenHash, new Date().toISOString());
  return session ? { ...session, tokenHash } : null;
}

function createSession(userId, response) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionMaxAge * 1000).toISOString();
  database
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, expiresAt);
  setSessionCookie(response, token);
}

function requireUser(session) {
  if (!session) throw new HttpError(401, "Connecte-toi pour continuer.");
  return session;
}

function requireActiveUser(session) {
  const user = requireUser(session);
  if (user.is_suspended) {
    throw new HttpError(403, "Ce compte est suspendu sur NEXO.");
  }
  return user;
}

function requireAdmin(session) {
  const user = requireActiveUser(session);
  if (user.role !== "admin") throw new HttpError(403, "Accès administrateur requis.");
  return user;
}

async function readJson(request) {
  if (!request.headers["content-type"]?.includes("application/json")) {
    throw new HttpError(415, "Envoie les données au format JSON.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "Requête trop volumineuse.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON invalide.");
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

async function adminBootstrap() {
  const bootstrapDone = database
    .prepare("SELECT 1 FROM app_meta WHERE key = 'admin_bootstrap_done'")
    .get();
  if (bootstrapDone) return;

  const existingAdmin = database
    .prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")
    .get();
  if (existingAdmin) {
    database
      .prepare("INSERT INTO app_meta (key, value) VALUES ('admin_bootstrap_done', ?)")
      .run(new Date().toISOString());
    return;
  }

  const email = process.env.NEXO_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.NEXO_ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password) {
    throw new Error("Définis NEXO_ADMIN_EMAIL et NEXO_ADMIN_PASSWORD ensemble.");
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new Error("NEXO_ADMIN_EMAIL n'est pas une adresse valide.");
  }
  if (password.length < 12 || password.length > 128) {
    throw new Error("Le mot de passe admin doit contenir entre 12 et 128 caractères.");
  }

  const existing = database.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const credentials = existing ? null : await hashPassword(password);
  transaction(() => {
    if (existing) {
      database
        .prepare("UPDATE users SET role = 'admin', is_suspended = 0 WHERE id = ?")
        .run(existing.id);
    } else {
      const { salt, hash } = credentials;
      database
        .prepare(
          `INSERT INTO users (id, email, password_hash, password_salt, display_name, role, created_at)
           VALUES (?, ?, ?, ?, 'Admin', 'admin', ?)`,
        )
        .run(randomUUID(), email, hash, salt, new Date().toISOString());
    }
    database
      .prepare("INSERT INTO app_meta (key, value) VALUES ('admin_bootstrap_done', ?)")
      .run(new Date().toISOString());
  });
}

function transaction(action) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function checkOrigin(request) {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  const host = request.headers.host?.toLowerCase();
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new HttpError(403, "Hôte de requête refusé.");
  }
  const hostname = hostUrl.hostname.replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  const isLocalHost = hostname === "localhost";
  const isPrivateIpv4 = ipVersion === 4 && (() => {
    const [first, second] = hostname.split(".").map(Number);
    return first === 10 || first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254);
  })();
  const isPrivateIpv6 = ipVersion === 6 &&
    (hostname === "::1" || /^f[cd]/i.test(hostname) || /^fe[89ab]/i.test(hostname));
  if (!host || hostUrl.port !== String(activePort) ||
    !(isLocalHost || isPrivateIpv4 || isPrivateIpv6)) {
    throw new HttpError(403, "Hôte de requête refusé.");
  }

  const origin = request.headers.origin;
  const isMutation = ["POST", "PATCH", "DELETE"].includes(request.method || "");
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new HttpError(403, "Origine de requête refusée.");
    }
    if (originUrl.protocol !== "http:" || originUrl.host.toLowerCase() !== host) {
      throw new HttpError(403, "Origine de requête refusée.");
    }
  }
  if (isMutation && !origin) {
    throw new HttpError(403, "Origine absente de la requête.");
  }
}

function enforceRateLimit(request, route, maximum, windowMs) {
  const key = `${request.socket.remoteAddress || "unknown"}:${route}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
  } else {
    bucket.count += 1;
    if (bucket.count > maximum) {
      const retryAfter = Math.ceil((windowMs - (now - bucket.startedAt)) / 1000);
      throw new HttpError(429, `Trop de tentatives. Réessaie dans ${retryAfter} secondes.`);
    }
  }

  if (rateBuckets.size > 1000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (now - value.startedAt >= windowMs) rateBuckets.delete(bucketKey);
    }
  }
}

async function handleApi(request, response, url) {
  checkOrigin(request);
  const session = sessionFor(request);
  const { pathname } = url;

  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { mode: "local" });
    return;
  }

  if (pathname === "/api/session" && request.method === "GET") {
    sendJson(response, 200, {
      user: publicUser(session),
      access: session
        ? { role: session.role, is_suspended: Boolean(session.is_suspended) }
        : { role: "user", is_suspended: false },
    });
    return;
  }

  if (pathname === "/api/register" && request.method === "POST") {
    enforceRateLimit(request, "register", 5, 15 * 60 * 1000);
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const displayName = String(body.displayName || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      throw new HttpError(400, "Adresse e-mail invalide.");
    }
    if (password.length < 8 || password.length > 128) {
      throw new HttpError(400, "Le mot de passe doit contenir entre 8 et 128 caractères.");
    }
    if (displayName.length < 1 || displayName.length > 30) {
      throw new HttpError(400, "Le pseudo doit contenir entre 1 et 30 caractères.");
    }
    const { salt, hash } = await hashPassword(password);
    const userId = randomUUID();
    try {
      database
        .prepare(
          `INSERT INTO users (id, email, password_hash, password_salt, display_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, email, hash, salt, displayName, new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes("users.email")) {
        throw new HttpError(409, "Un compte utilise déjà cette adresse e-mail.");
      }
      throw error;
    }
    createSession(userId, response);
    const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    sendJson(response, 201, {
      user: publicUser(user),
      access: { role: user.role, is_suspended: false },
    });
    return;
  }

  if (pathname === "/api/login" && request.method === "POST") {
    enforceRateLimit(request, "login", 10, 15 * 60 * 1000);
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = database.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || password.length > 128) {
      throw new HttpError(401, "Adresse e-mail ou mot de passe incorrect.");
    }
    const { hash } = await hashPassword(password, user.password_salt);
    if (!timingSafeEqual(hash, user.password_hash)) {
      throw new HttpError(401, "Adresse e-mail ou mot de passe incorrect.");
    }
    createSession(user.id, response);
    sendJson(response, 200, {
      user: publicUser(user),
      access: { role: user.role, is_suspended: Boolean(user.is_suspended) },
    });
    return;
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    if (session) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/posts" && request.method === "GET") {
    const currentUserId = session?.id || "";
    const posts = database
      .prepare(
        `SELECT posts.id, posts.content, posts.topic, posts.created_at, posts.user_id,
           users.display_name AS author,
           COUNT(likes.user_id) AS likesCount,
           MAX(CASE WHEN likes.user_id = ? THEN 1 ELSE 0 END) AS liked
         FROM posts
         JOIN users ON users.id = posts.user_id
         LEFT JOIN likes ON likes.post_id = posts.id
         GROUP BY posts.id
         ORDER BY posts.created_at DESC
         LIMIT 100`,
      )
      .all(currentUserId)
      .map((post) => ({ ...post, liked: Boolean(post.liked) }));
    sendJson(response, 200, { posts });
    return;
  }

  if (pathname === "/api/posts" && request.method === "POST") {
    const user = requireActiveUser(session);
    const body = await readJson(request);
    const content = String(body.content || "").trim();
    const topic = String(body.topic || "Idée").trim();
    if (!content || content.length > 500 || !topic || topic.length > 24) {
      throw new HttpError(400, "Texte ou thème invalide.");
    }
    database
      .prepare("INSERT INTO posts (user_id, content, topic, created_at) VALUES (?, ?, ?, ?)")
      .run(user.id, content, topic, new Date().toISOString());
    sendJson(response, 201, { ok: true });
    return;
  }

  const likeMatch = pathname.match(/^\/api\/posts\/(\d+)\/likes$/);
  if (likeMatch && request.method === "POST") {
    const user = requireActiveUser(session);
    const postId = Number(likeMatch[1]);
    if (!database.prepare("SELECT 1 FROM posts WHERE id = ?").get(postId)) {
      throw new HttpError(404, "Publication introuvable.");
    }
    database
      .prepare("INSERT OR IGNORE INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)")
      .run(postId, user.id, new Date().toISOString());
    sendJson(response, 200, { ok: true });
    return;
  }

  if (likeMatch && request.method === "DELETE") {
    const user = requireActiveUser(session);
    database
      .prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?")
      .run(Number(likeMatch[1]), user.id);
    sendJson(response, 200, { ok: true });
    return;
  }

  const postMatch = pathname.match(/^\/api\/posts\/(\d+)$/);
  if (postMatch && request.method === "DELETE") {
    const user = requireActiveUser(session);
    const result = database
      .prepare("DELETE FROM posts WHERE id = ? AND user_id = ?")
      .run(Number(postMatch[1]), user.id);
    if (!result.changes) throw new HttpError(404, "Publication introuvable.");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/admin/users" && request.method === "GET") {
    requireAdmin(session);
    const requestedLimit = Number(url.searchParams.get("limit") || 50);
    const requestedOffset = Number(url.searchParams.get("offset") || 0);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;
    const offset = Number.isInteger(requestedOffset)
      ? Math.max(requestedOffset, 0)
      : 0;
    const total = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const users = database
      .prepare(
        `SELECT id AS user_id, email, display_name, created_at, role,
           is_suspended FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map((user) => ({ ...user, is_suspended: Boolean(user.is_suspended) }));
    sendJson(response, 200, { users, total });
    return;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/i);
  if (adminUserMatch && request.method === "PATCH") {
    const admin = requireAdmin(session);
    const targetId = adminUserMatch[1];
    if (targetId === admin.id) throw new HttpError(400, "Tu ne peux pas modifier ton propre compte ici.");
    const body = await readJson(request);
    if (!['user', 'admin'].includes(body.role) || typeof body.is_suspended !== "boolean") {
      throw new HttpError(400, "Paramètres de compte invalides.");
    }

    transaction(() => {
      const target = database.prepare("SELECT role, is_suspended FROM users WHERE id = ?").get(targetId);
      if (!target) throw new HttpError(404, "Compte introuvable.");
      const disablesLastAdmin = target.role === "admin" && !target.is_suspended &&
        (body.role !== "admin" || body.is_suspended);
      if (disablesLastAdmin) {
        const count = database
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_suspended = 0")
          .get().count;
        if (count <= 1) throw new HttpError(409, "Impossible de désactiver le dernier administrateur.");
      }
      database
        .prepare("UPDATE users SET role = ?, is_suspended = ? WHERE id = ?")
        .run(body.role, Number(body.is_suspended), targetId);
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (adminUserMatch && request.method === "DELETE") {
    const admin = requireAdmin(session);
    const targetId = adminUserMatch[1];
    if (targetId === admin.id) throw new HttpError(400, "Tu ne peux pas supprimer ton propre compte ici.");

    transaction(() => {
      const target = database.prepare("SELECT role, is_suspended FROM users WHERE id = ?").get(targetId);
      if (!target) throw new HttpError(404, "Compte introuvable.");
      if (target.role === "admin" && !target.is_suspended) {
        const count = database
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_suspended = 0")
          .get().count;
        if (count <= 1) throw new HttpError(409, "Impossible de supprimer le dernier administrateur.");
      }
      database.prepare("DELETE FROM users WHERE id = ?").run(targetId);
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Route introuvable." });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    const asset = assets[url.pathname];
    if (!asset || !["GET", "HEAD"].includes(request.method || "GET")) {
      sendJson(response, 404, { error: "Fichier introuvable." });
      return;
    }
    const body = readFileSync(join(root, asset));
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(asset)],
      "Content-Length": body.length,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(response, status, {
      error: status === 500 ? "Erreur interne du serveur local." : error.message,
    });
  }
});

try {
  await adminBootstrap();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

server.listen(port, bindHost, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  console.log(`NEXO local : http://127.0.0.1:${activePort}`);
  console.log(`Écoute sur : ${bindHost}`);
  console.log(`Base SQLite : ${databasePath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}
