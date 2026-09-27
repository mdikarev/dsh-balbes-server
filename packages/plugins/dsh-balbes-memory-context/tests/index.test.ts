import { describe, expect, it } from "vitest";
import { apply, name, Config } from "../src/index.js";

describe("balbes-memory-context plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-context");
    expect(Config).toBeDefined();
    expect(Config({})).toEqual({});
  });

  it("provides balbesMemoryContext on apply", () => {
    const provided = new Map<string, unknown>();
    apply(
      {
        provide(key, value) {
          provided.set(key, value);
        },
        logger: { warn() {}, info() {} }
      },
      {}
    );
    const service = provided.get("balbesMemoryContext") as { attach?: unknown } | undefined;
    expect(typeof service?.attach).toBe("function");
  });
});
