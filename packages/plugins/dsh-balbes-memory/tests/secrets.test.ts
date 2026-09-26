import { describe, expect, it } from "vitest";
import { detectSecret } from "../src/secrets.js";

describe("detectSecret", () => {
  it("flags provider keys", () => {
    expect(detectSecret("key sk-abcdefghijklmnop1234")?.rule).toBe("provider-key");
    expect(detectSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")?.rule).toBe("github-token");
    expect(detectSecret("AKIAIOSFODNN7EXAMPLE")?.rule).toBe("aws-key");
  });

  it("flags a telegram bot token", () => {
    expect(detectSecret("123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")?.rule).toBe("telegram-token");
  });

  it("flags assignments and bearer tokens", () => {
    expect(detectSecret("api_key = abc123")?.rule).toBe("assignment");
    expect(detectSecret("Authorization: Bearer abcdefghijklmnopqrstuvwx")?.rule).toBe("bearer-token");
  });

  it("flags PEM private keys and connection strings", () => {
    expect(detectSecret("-----BEGIN RSA PRIVATE KEY-----")?.rule).toBe("private-key");
    expect(detectSecret("postgres://user:secret@host/db")?.rule).toBe("connection-string");
  });

  it("does not flag ordinary sentences", () => {
    expect(detectSecret("password policy: rotate every 90 days")).toBeNull();
    expect(detectSecret("we decided to use pnpm workspaces")).toBeNull();
  });
});
