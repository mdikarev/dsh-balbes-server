import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminAuth, writeAdminAuth, verifyPassword, loadAdminAuth } from "../src/core.js";
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
});
