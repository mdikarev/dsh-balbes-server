/** Credentials ref for the single GitHub PAT used by private clones. */
export const BALBES_GITHUB_TOKEN = "BALBES_GITHUB_TOKEN";

/** Structural slice of the engine credentials service (mirrors models/telegram). */
export interface GitCredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  resolve(ref: string): Promise<{ value: string } | undefined>;
}
