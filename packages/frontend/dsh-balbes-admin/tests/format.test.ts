import { describe, expect, it } from "vitest";
import { formatCreatedAt } from "../src/format";

describe("formatCreatedAt", () => {
  it("renders ru-RU local time", () => {
    expect(formatCreatedAt("2026-09-11T01:40:00.000Z")).toBe(new Date("2026-09-11T01:40:00.000Z").toLocaleString("ru-RU"));
  });
  it("uses a dash for empty and echoes an unparseable value", () => {
    expect(formatCreatedAt("  ")).toBe("—");
    expect(formatCreatedAt("не дата")).toBe("не дата");
  });
});
