import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject, Config } from "../src/index.js";

interface SectionSpec {
  name: string;
  order: number;
  text: string | ((context: unknown) => string);
}

interface SeatLike {
  section(spec: SectionSpec): () => void;
}

interface Harness {
  sections: SectionSpec[];
  warnings: string[];
}

const LABEL = "## Agent self-description (from the agent home)";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "balbes-home-"));
  await mkdir(join(home, "agent"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Fake ctx registering a single systemPrompt seat plus a warning recorder. */
function harness(options: { withSystemPrompt?: boolean } = {}): Harness {
  const sections: SectionSpec[] = [];
  const warnings: string[] = [];
  const ctx = {
    get(key: string): unknown {
      if (key === "systemPrompt" && options.withSystemPrompt !== false) {
        return {
          section(spec: SectionSpec): () => void {
            sections.push(spec);
            return () => {};
          }
        } satisfies SeatLike;
      }
      return undefined;
    },
    logger: {
      warn(message: string): void {
        warnings.push(message);
      }
    }
  };
  apply(ctx, { dshHome: home });
  return { sections, warnings };
}

function textOf(section: SectionSpec): string {
  return typeof section.text === "function" ? section.text(undefined) : section.text;
}

describe("balbes-home plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-home");
    expect(inject).toEqual(["systemPrompt"]);
    expect(Config).toBeDefined();
  });

  it("accepts a config without dshHome (optional field)", () => {
    expect(Config({})).toEqual({});
    expect(Config({ dshHome: "/x" })).toEqual({ dshHome: "/x" });
  });

  it("registers exactly one section named balbes:self at order 100", () => {
    const h = harness();
    expect(h.sections.map((s) => [s.name, s.order])).toEqual([["balbes:self", 100]]);
  });

  it("renders self.md under the agent-home label", async () => {
    await writeFile(join(home, "agent", "self.md"), "I am Balbes.\n", "utf8");
    const h = harness();
    expect(textOf(h.sections[0]!)).toBe(`${LABEL}\n\nI am Balbes.`);
  });

  it("returns an empty string when self.md is missing", () => {
    const h = harness();
    expect(textOf(h.sections[0]!)).toBe("");
  });

  it("escapes {{ so owner text cannot trigger interpolation", async () => {
    await writeFile(join(home, "agent", "self.md"), "Use {{cwd}} carefully.", "utf8");
    const h = harness();
    expect(textOf(h.sections[0]!)).toBe(`${LABEL}\n\nUse { {cwd}} carefully.`);
  });

  it("warns and registers nothing when systemPrompt is absent", () => {
    const h = harness({ withSystemPrompt: false });
    expect(h.sections).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/systemPrompt/);
  });
});
