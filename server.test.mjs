import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = fileURLToPath(new URL(".", import.meta.url));

function startServer(databasePath, email, password) {
  const child = spawn(process.execPath, [join(root, "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      NEXO_DB_PATH: databasePath,
      NEXO_ADMIN_EMAIL: email,
      NEXO_ADMIN_PASSWORD: password,
      NEXO_BIND_HOST: "127.0.0.1",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/NEXO local : http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        resolve({ child, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", fail);
    child.once("exit", (code) => {
      fail(new Error(`Local server exited with code ${code}: ${output}`));
    });
  });
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const stopped = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  await stopped;
}

async function jsonRequest(baseUrl, path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Origin: baseUrl,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    response,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

test("local admin bootstrap, pagination, file permissions and restart safety", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nexo-local-test-"));
  const databasePath = join(directory, "test.sqlite");
  const email = "bootstrap@example.test";
  const password = "AdminTestPassword123!";
  let server;

  try {
    server = await startServer(databasePath, email, password);
    const health = await jsonRequest(server.baseUrl, "/api/health");
    assert.equal(health.data.mode, "local");
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);

    const foreignOrigin = await fetch(`${server.baseUrl}/api/register`, {
      method: "POST",
      headers: {
        Origin: "http://attacker.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "blocked@example.test",
        password: "UnrelatedPassword123!",
        displayName: "Intrus",
      }),
    });
    assert.equal(foreignOrigin.status, 403);

    const spoofedHost = await fetch(`${server.baseUrl}/api/health`, {
      headers: {
        Host: "attacker.example",
        Origin: "http://attacker.example",
      },
    });
    assert.equal(spoofedHost.status, 403);

    const missingOrigin = await fetch(`${server.baseUrl}/api/logout`, {
      method: "POST",
    });
    assert.equal(missingOrigin.status, 403);

    const login = await jsonRequest(server.baseUrl, "/api/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.access.role, "admin");
    const adminCookie = login.cookie;

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const failedLogin = await jsonRequest(server.baseUrl, "/api/login", {
        method: "POST",
        body: { email, password: "incorrect-password" },
      });
      assert.equal(failedLogin.response.status, 401);
    }
    const rateLimitedLogin = await jsonRequest(server.baseUrl, "/api/login", {
      method: "POST",
      body: { email, password: "incorrect-password" },
    });
    assert.equal(rateLimitedLogin.response.status, 429);

    const database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    const addUser = database.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 55; index += 1) {
      addUser.run(
        randomUUID(),
        `member-${index}@example.test`,
        Buffer.alloc(64),
        Buffer.alloc(16),
        `Membre ${index}`,
        new Date(Date.now() + index).toISOString(),
      );
    }
    database.close();

    const firstPage = await jsonRequest(
      server.baseUrl,
      "/api/admin/users?limit=50&offset=0",
      { cookie: adminCookie },
    );
    const secondPage = await jsonRequest(
      server.baseUrl,
      "/api/admin/users?limit=50&offset=50",
      { cookie: adminCookie },
    );
    assert.equal(firstPage.data.total, 56);
    assert.equal(firstPage.data.users.length, 50);
    assert.equal(secondPage.data.users.length, 6);

    await stopServer(server);
    server = null;
    const update = new DatabaseSync(databasePath);
    update.prepare("UPDATE users SET is_suspended = 1 WHERE email = ?").run(email);
    update.close();

    server = await startServer(databasePath, email, password);
    const relaunchedLogin = await jsonRequest(server.baseUrl, "/api/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(relaunchedLogin.data.access.is_suspended, true);

    const blockedPost = await jsonRequest(server.baseUrl, "/api/posts", {
      method: "POST",
      body: { content: "Ne doit pas être publié", topic: "test" },
      cookie: relaunchedLogin.cookie,
    });
    assert.equal(blockedPost.response.status, 403);
  } finally {
    await stopServer(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
