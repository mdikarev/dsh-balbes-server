import { describe, expect, it } from "vitest";
import type { LoginRequest, PromptResponse } from "../src/index.js";

describe("contracts", () => {
  it("LoginRequest describes login/password fields", () => {
    const req: LoginRequest = { login: "balbes-x", password: "secret" };
    expect(JSON.parse(JSON.stringify(req))).toEqual(req);
  });

  it("PromptResponse carries text and an optional reason", () => {
    const ok: PromptResponse = { text: "ok" };
    const err: PromptResponse = { text: "", reason: { kind: "error", code: "E", message: "m" } };
    expect(ok.text).toBe("ok");
    expect(err.reason?.code).toBe("E");
  });
});
