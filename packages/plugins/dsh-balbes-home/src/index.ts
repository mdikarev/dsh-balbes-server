import z from "@deepseek-ai/schemastery";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const name = "balbes-home";
export const inject = ["systemPrompt"];
export const Config = z.object({ dshHome: z.string().required(false) });

const SECTION_NAME = "balbes:self";
const SECTION_ORDER = 100;
const SECTION_LABEL = "## Agent self-description (from the agent home)";

interface SystemPromptSeatLike {
  section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void;
}
interface CtxLike {
  get(key: string): unknown;
  logger: { warn(message: string): void };
}

/** Escape strict {{variable}} interpolation so owner text can never throw assembly. */
function escapeInterpolation(text: string): string {
  // Fixed point: one pass can leave a strict {{ behind (e.g. "{{{x}}}" ->
  // "{ {{x}}}"), so keep replacing until no "{{" remains.
  let out = text;
  while (out.includes("{{")) out = out.replace(/\{\{/g, "{ {");
  return out;
}

export function apply(ctx: CtxLike, config: { dshHome?: string }): void {
  const systemPrompt = ctx.get("systemPrompt") as SystemPromptSeatLike | undefined;
  if (systemPrompt === undefined) {
    ctx.logger.warn("balbes-home: systemPrompt service missing; self.md not injected");
    return;
  }
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const selfPath = join(dshHome, "agent", "self.md");
  let cachedMtime = -1;
  let cachedText = "";
  const renderSelf = (): string => {
    try {
      const info = statSync(selfPath);
      if (info.mtimeMs !== cachedMtime) {
        cachedMtime = info.mtimeMs;
        cachedText = readFileSync(selfPath, "utf8").trim();
      }
    } catch {
      cachedMtime = -1;
      cachedText = "";
    }
    if (cachedText === "") return "";
    return `${SECTION_LABEL}\n\n${escapeInterpolation(cachedText)}`;
  };
  systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: renderSelf });
}
