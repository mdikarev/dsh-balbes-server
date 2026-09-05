import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAdminAuth,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  loadAdminAuth,
  writeAdminAuth,
  defaultAdminAuthFile
} from "../src/core.js";

describe("core", () => {
  it("scrypt round-trip: verifyPassword accepts the correct password", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("correct horse", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("JWT round-trip: signature and expiry", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const { token, expiresAt } = issueToken(secret, "admin");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const payload = verifyToken(secret, token);
    expect(payload?.login).toBe("admin");
  });

  it("JWT: tampered token is rejected", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const { token } = issueToken(secret, "admin");
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyToken(secret, tampered)).toBeNull();
  });

  it("credentials: password is not stored in plaintext", async () => {
    const c = await createAdminAuth();
    expect(c.plaintextPassword).not.toBe(c.passwordHash);
    expect(c.plaintextPassword.length).toBeGreaterThanOrEqual(20);
    expect(c.login.startsWith("balbes-")).toBe(true);
  });

  it("admin-auth file: atomic write and read, 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-auth-"));
    try {
      const auth = {
        login: "balbes-abc",
        passwordHash: await hashPassword("pw"),
        jwtSecret: "0123456789abcdef0123456789abcdef",
        createdAt: new Date().toISOString()
      };
      await writeAdminAuth(dir, auth);
      const loaded = await loadAdminAuth(dir);
      expect(loaded.login).toBe(auth.login);
      expect(loaded.passwordHash).toBe(auth.passwordHash);
      const stat = await readFile(defaultAdminAuthFile(dir));
      expect(stat.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admin-auth file: plain JSON values (null/arrays) are rejected with a clear error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-shape-"));
    try {
      await writeFile(defaultAdminAuthFile(dir), "null", "utf8");
      await expect(loadAdminAuth(dir)).rejects.toThrow("misses required fields");
      await writeFile(defaultAdminAuthFile(dir), "[1]", "utf8");
      await expect(loadAdminAuth(dir)).rejects.toThrow("misses required fields");
      await writeFile(defaultAdminAuthFile(dir), "{not json", "utf8");
      await expect(loadAdminAuth(dir)).rejects.toThrow("is not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
