/** Normalize skill names stored in session options from older daemon data. */
export function normalizeSkillSelection(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ].slice(0, 128)
    : [];
}
