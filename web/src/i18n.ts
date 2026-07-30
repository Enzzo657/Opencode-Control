export type Locale = "ru" | "en";

const ru = {
  "dashboard.title": "Дашборд",
  "dashboard.projectDescription": "Активность, использование и Runtime проекта {project}.",
  "dashboard.globalDescription": "Использование OpenCode по всем проектам.",
  "dashboard.runTask": "Запустить задачу",
  "dashboard.projectScope": "Проект · {project}",
  "dashboard.globalScope": "Все проекты",
} as const;

export type TranslationKey = keyof typeof ru;
type TranslationCatalog = Record<TranslationKey, string>;

const en = {
  "dashboard.title": "Dashboard",
  "dashboard.projectDescription": "Activity, usage, and runtime for {project}.",
  "dashboard.globalDescription": "OpenCode usage across all projects.",
  "dashboard.runTask": "Run task",
  "dashboard.projectScope": "Project · {project}",
  "dashboard.globalScope": "All projects",
} satisfies TranslationCatalog;

const catalogs: Record<Locale, TranslationCatalog> = { ru, en };

export function createTranslator(locale: Locale) {
  return (key: TranslationKey, values: Record<string, string> = {}) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      catalogs[locale][key],
    );
}
