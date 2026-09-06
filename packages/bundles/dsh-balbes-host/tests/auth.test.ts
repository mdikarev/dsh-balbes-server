import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminAuth, writeAdminAuth, verifyPassword, loadAdminAuth, issueToken, verifyToken } from "../src/core.js";
import { createGuard } from "../src/auth.js";

describe("auth guard", () => {
  it("checkLogin accepts the valid pair and rejects an invalid one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authg-"));
    try {
      const creds = await createAdminAuth();
      await writeAdminAuth(dir, creds);
      const guard = createGuard({ adminAuthFile: join(dir, "admin-auth.json") });
      await expect(guard.checkLogin(creds.login, creds.plaintextPassword)).resolves.toBe(true);
      await expect(guard.checkLogin(creds.login, "wrong")).resolves.toBe(false);
      const token = guard.issue(creds.login);
      expect(guard.verify(token)?.login).toBe(creds.login);
      expect(guard.verify("garbage")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verify authenticates a token issued before startup (stateless bearer auth)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authv-"));
    try {
      const creds = await createAdminAuth();
      await writeAdminAuth(dir, creds);
      const guard = createGuard({ adminAuthFile: join(dir, "admin-auth.json") });
      expect(guard.loadSync()).toBe(true);
      // No checkLogin happened: a token persisted from a previous process
      // lifetime must authenticate right away (stateless bearer auth).
      const { token } = issueToken(creds.jwtSecret, creds.login);
      expect(guard.verify(token)?.login).toBe(creds.login);
      expect(guard.verify("garbage")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rotating jwtSecret (password reset) invalidates issued tokens immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authrot-"));
    try {
      const file = join(dir, "admin-auth.json");
      const creds = await createAdminAuth();
      await writeAdminAuth(dir, creds);
      const guard = createGuard({ adminAuthFile: file });
      expect(guard.loadSync()).toBe(true);

      const oldToken = guard.issue(creds.login);
      expect(guard.verify(oldToken)?.login).toBe(creds.login);

      // Simulate `admin-creds.mjs reset`: login preserved, fresh passwordHash,
      // NEW jwtSecret, refreshed createdAt — persisted via the same atomic
      // tmp+rename write the real reset performs.
      const next = await createAdminAuth();
      const rotated = {
        login: creds.login,
        passwordHash: next.passwordHash,
        jwtSecret: next.jwtSecret,
        createdAt: new Date().toISOString()
      };
      await writeAdminAuth(dir, rotated);

      // Read-through: the very next verify (no checkLogin in between, no
      // restart, no mtime) already sees the rotated secret and rejects the
      // previously issued token.
      expect(guard.verify(oldToken)).toBeNull();
      // New tokens are minted under the rotated secret...
      const newToken = guard.issue(creds.login);
      expect(guard.verify(newToken)?.login).toBe(creds.login);
      expect(verifyToken(rotated.jwtSecret, newToken)?.login).toBe(creds.login);
      // ...and only under it: the old secret neither validates the new token
      // nor keeps validating the old one on a fresh guard read.
      expect(verifyToken(creds.jwtSecret, newToken)).toBeNull();
      expect(verifyToken(creds.jwtSecret, oldToken)?.login).toBe(creds.login);
      // The old password stops working; the new one logs in.
      await expect(guard.checkLogin(creds.login, creds.plaintextPassword)).resolves.toBe(false);
      await expect(guard.checkLogin(creds.login, next.plaintextPassword)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadSync reports false when the auth file is absent at startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authn-"));
    try {
      const guard = createGuard({ adminAuthFile: join(dir, "admin-auth.json") });
      expect(guard.loadSync()).toBe(false);
      expect(guard.verify("any")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checkLogin recovers once a missing auth file appears later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authl-"));
    try {
      const guard = createGuard({ adminAuthFile: join(dir, "admin-auth.json") });
      expect(guard.loadSync()).toBe(false);
      const creds = await createAdminAuth();
      await writeAdminAuth(dir, creds);
      await expect(guard.checkLogin(creds.login, creds.plaintextPassword)).resolves.toBe(true);
      expect(guard.verify(guard.issue(creds.login))?.login).toBe(creds.login);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shape-invalid file (missing jwtSecret): loadSync/verify/checkLogin fail closed, never crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-auths-"));
    try {
      const file = join(dir, "admin-auth.json");
      // A hand-edited file without jwtSecret: verify() on the old code would
      // feed an undefined secret into HMAC and throw on every bearer request.
      await writeFile(file, JSON.stringify({ login: "admin", passwordHash: "x" }), "utf8");
      const guard = createGuard({ adminAuthFile: file });
      expect(guard.loadSync()).toBe(false); // the bad file is never cached
      expect(guard.verify("any-token")).toBeNull();
      await expect(guard.checkLogin("admin", "x")).resolves.toBe(false); // fails closed
      expect(guard.verify("any-token")).toBeNull();

      // Fixing the file on disk is picked up by the lazy reload — no restart.
      const creds = await createAdminAuth();
      await writeAdminAuth(dir, creds);
      expect(guard.loadSync()).toBe(true);
      await expect(guard.checkLogin(creds.login, creds.plaintextPassword)).resolves.toBe(true);
      expect(guard.verify(guard.issue(creds.login))?.login).toBe(creds.login);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("non-object JSON values in the auth file also fail closed (no TypeError)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authnul-"));
    try {
      const file = join(dir, "admin-auth.json");
      await writeFile(file, "null", "utf8");
      const guard = createGuard({ adminAuthFile: file });
      expect(guard.loadSync()).toBe(false);
      expect(guard.verify("any")).toBeNull();
      await expect(guard.checkLogin("admin", "pw")).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
