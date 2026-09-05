import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminAuth, writeAdminAuth, verifyPassword, loadAdminAuth, issueToken } from "../src/core.js";
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

  it("verify authenticates a token issued before startup once loadSync warms the cache", async () => {
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
});
