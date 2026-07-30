import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";

describe("typed translation catalog", () => {
  it("renders dashboard copy and placeholders in both prepared locales", () => {
    expect(createTranslator("ru")("dashboard.projectScope", { project: "Control" })).toBe(
      "Проект · Control",
    );
    expect(createTranslator("en")("dashboard.projectScope", { project: "Control" })).toBe(
      "Project · Control",
    );
  });
});
