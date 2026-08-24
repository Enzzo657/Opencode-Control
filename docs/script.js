const dictionaries = {
  en: {
    "meta.description": "OpenCode Control is a local-first control plane for OpenCode projects, agents, sessions, tasks, MCP servers, Git, and artifacts.",
    "nav.features": "Features",
    "nav.screenshots": "Screenshots",
    "nav.quickStart": "Quick Start",
    "hero.eyebrow": "Local-first alpha",
    "hero.copy": "A local control plane for OpenCode projects, agents, tasks, configuration, Git workflows, and generated artifacts.",
    "cta.github": "View on GitHub",
    "cta.start": "Get Started",
    "cta.docs": "Documentation",
    "cta.repository": "View repository",
    "facts.runsOn": "Runs on",
    "facts.platforms": "macOS and Linux",
    "facts.dataModel": "Data model",
    "facts.localData": "Local SQLite and files",
    "facts.license": "License",
    "preview.eyebrow": "Product Preview",
    "preview.title": "A dashboard for day-to-day agent operations.",
    "preview.copy": "OpenCode Control keeps the execution engine in OpenCode, then adds the workspace, runtime, usage, and project controls around it.",
    "preview.alt": "OpenCode Control dashboard with usage metrics, model breakdown, project runtime, and navigation.",
    "preview.caption": "Dashboard view with usage, cost, model ranking, project runtime, and local project navigation.",
    "features.eyebrow": "Features",
    "features.title": "Real controls around real OpenCode workflows.",
    "feature.projects.title": "Projects and runtime",
    "feature.projects.copy": "Manage multiple local projects, managed <code>opencode serve</code> processes, external loopback endpoints, and restored servers.",
    "feature.sessions.title": "Sessions and Tasks",
    "feature.sessions.copy": "Continue conversations, answer permission requests, run managed Tasks, rerun or abort work, and schedule recurring agent runs.",
    "feature.config.title": "Native configuration",
    "feature.config.copy": "Edit project and global Agents, Skills, Commands, MCP, providers, secrets, <code>AGENTS.md</code>, and OpenCode JSON/JSONC config.",
    "feature.dashboard.title": "Usage dashboard",
    "feature.dashboard.copy": "Track tokens, cache reuse, cost, Sessions, providers, models, agents, and project-level breakdowns locally.",
    "feature.search.title": "Search and artifacts",
    "feature.search.copy": "Search local Session history with deep links, then preview images, PDFs, CSV, JSON, Markdown, logs, ZIP files, and more.",
    "feature.git.title": "Git and safety",
    "feature.git.copy": "Use status, diff, stage, commit, revert, and guarded reset while config writes stay atomic with preflight and rollback.",
    "how.eyebrow": "How It Works",
    "how.title": "OpenCode stays the engine. Control becomes the operating layer.",
    "how.browser.title": "Browser UI",
    "how.browser.copy": "Local web interface",
    "how.control.copy": "Orchestration, state, search, events",
    "how.runtime.title": "OpenCode runtimes",
    "how.runtime.copy": "Managed or external project servers",
    "how.note": "The app listens on loopback, stores Control state on your machine, and keeps OpenCode files such as Agents, Skills, Commands, MCP, and <code>AGENTS.md</code> native.",
    "screens.eyebrow": "Screenshots",
    "screens.title": "See OpenCode Control in action.",
    "screens.copy": "Real product screens from the repository, arranged around common agent workflows.",
    "screen.sessions.alt": "OpenCode Control Sessions screen.",
    "screen.sessions.title": "Session history with context",
    "screen.sessions.copy": "Grouped Task runs, exact timestamps, statuses, usage, Markdown, tool calls, attachments, todos, and child subagent Sessions.",
    "screen.tasks.alt": "OpenCode Control Tasks screen.",
    "screen.tasks.title": "Managed and scheduled Tasks",
    "screen.tasks.copy": "Create manual or recurring agent runs, pause or resume schedules, rerun work, abort active runs, and inspect run history.",
    "screen.mcp.alt": "OpenCode Control MCP servers screen.",
    "screen.mcp.title": "MCP configuration you can trust",
    "screen.mcp.copy": "Compare global config, project overrides, and live runtime connection state before applying changes to OpenCode.",
    "screen.artifacts.alt": "OpenCode Control Artifacts screen.",
    "screen.artifacts.title": "Artifact previews without broad filesystem scans",
    "screen.artifacts.copy": "Open generated images, PDFs, CSV, JSON, Markdown, text, logs, and ZIP archives from explicit artifact locations.",
    "quick.eyebrow": "Quick Start",
    "quick.title": "Install from a local clone.",
    "quick.copy": "The installer builds the frontend and Python wheel, installs <code>opencode-control</code> with <code>uv tool</code>, then starts the local browser UI.",
    "quick.copyButton": "Copy",
    "quick.copied": "Copied",
    "quick.selectText": "Select text",
    "quick.note": "After installation, run <code>opencode-control start</code> to open the local Control UI again.",
    "open.eyebrow": "Open Source",
    "open.title": "Inspect the code, open an issue, or contribute a fix.",
    "open.copy": "OpenCode Control is MIT licensed and designed as a local-first layer around the OpenCode CLI and its native project files.",
    "footer.license": "MIT License",
  },
  ru: {
    "meta.description": "OpenCode Control - локальная control plane для проектов OpenCode, агентов, sessions, tasks, MCP-серверов, Git и артефактов.",
    "nav.features": "Возможности",
    "nav.screenshots": "Скриншоты",
    "nav.quickStart": "Быстрый старт",
    "hero.eyebrow": "Local-first alpha",
    "hero.copy": "Локальная control plane для проектов OpenCode, агентов, задач, конфигурации, Git-workflow и созданных артефактов.",
    "cta.github": "Открыть GitHub",
    "cta.start": "Быстрый старт",
    "cta.docs": "Документация",
    "cta.repository": "Открыть репозиторий",
    "facts.runsOn": "Платформы",
    "facts.platforms": "macOS и Linux",
    "facts.dataModel": "Данные",
    "facts.localData": "Локальные SQLite и файлы",
    "facts.license": "Лицензия",
    "preview.eyebrow": "Превью продукта",
    "preview.title": "Дашборд для ежедневной работы с агентами.",
    "preview.copy": "OpenCode Control оставляет execution engine внутри OpenCode и добавляет вокруг него workspace, runtime, usage и управление проектами.",
    "preview.alt": "Дашборд OpenCode Control с usage-метриками, разбивкой по моделям, runtime проекта и навигацией.",
    "preview.caption": "Dashboard с usage, cost, рейтингом моделей, runtime проекта и навигацией по локальным проектам.",
    "features.eyebrow": "Возможности",
    "features.title": "Реальное управление реальными OpenCode workflow.",
    "feature.projects.title": "Projects и runtime",
    "feature.projects.copy": "Управляйте несколькими локальными проектами, managed <code>opencode serve</code>, external loopback endpoints и восстановлением серверов.",
    "feature.sessions.title": "Sessions и Tasks",
    "feature.sessions.copy": "Продолжайте диалоги, отвечайте на permission requests, запускайте managed Tasks, делайте rerun или abort и планируйте регулярные запуски.",
    "feature.config.title": "Нативная конфигурация",
    "feature.config.copy": "Редактируйте project/global Agents, Skills, Commands, MCP, providers, secrets, <code>AGENTS.md</code> и OpenCode JSON/JSONC config.",
    "feature.dashboard.title": "Usage dashboard",
    "feature.dashboard.copy": "Отслеживайте tokens, cache reuse, cost, Sessions, providers, models, agents и breakdown по проектам локально.",
    "feature.search.title": "Search и artifacts",
    "feature.search.copy": "Ищите по локальной истории Sessions с deep links и открывайте preview изображений, PDF, CSV, JSON, Markdown, logs, ZIP и других файлов.",
    "feature.git.title": "Git и безопасность",
    "feature.git.copy": "Используйте status, diff, stage, commit, revert и защищенный reset, пока config writes проходят атомарно с preflight и rollback.",
    "how.eyebrow": "Как это работает",
    "how.title": "OpenCode остается engine. Control становится операционным слоем.",
    "how.browser.title": "Browser UI",
    "how.browser.copy": "Локальный web-интерфейс",
    "how.control.copy": "Оркестрация, состояние, поиск, события",
    "how.runtime.title": "OpenCode runtimes",
    "how.runtime.copy": "Managed или external project servers",
    "how.note": "Приложение слушает loopback, хранит состояние Control на вашей машине и оставляет Agents, Skills, Commands, MCP и <code>AGENTS.md</code> нативными файлами OpenCode.",
    "screens.eyebrow": "Скриншоты",
    "screens.title": "OpenCode Control в действии.",
    "screens.copy": "Реальные экраны продукта из репозитория, собранные вокруг основных agent workflow.",
    "screen.sessions.alt": "Экран Sessions в OpenCode Control.",
    "screen.sessions.title": "История Sessions с контекстом",
    "screen.sessions.copy": "Сгруппированные Task runs, точные даты, статусы, usage, Markdown, tool calls, attachments, todos и дочерние subagent Sessions.",
    "screen.tasks.alt": "Экран Tasks в OpenCode Control.",
    "screen.tasks.title": "Managed и scheduled Tasks",
    "screen.tasks.copy": "Создавайте ручные или регулярные agent runs, ставьте расписания на pause/resume, запускайте rerun, abort и смотрите историю запусков.",
    "screen.mcp.alt": "Экран MCP servers в OpenCode Control.",
    "screen.mcp.title": "MCP-конфигурация без угадываний",
    "screen.mcp.copy": "Сравнивайте global config, project overrides и live runtime connection state до применения изменений в OpenCode.",
    "screen.artifacts.alt": "Экран Artifacts в OpenCode Control.",
    "screen.artifacts.title": "Preview артефактов без широкого сканирования filesystem",
    "screen.artifacts.copy": "Открывайте generated images, PDF, CSV, JSON, Markdown, text, logs и ZIP из явных artifact locations.",
    "quick.eyebrow": "Быстрый старт",
    "quick.title": "Установка из локального клона.",
    "quick.copy": "Installer собирает frontend и Python wheel, устанавливает <code>opencode-control</code> через <code>uv tool</code>, затем запускает локальный browser UI.",
    "quick.copyButton": "Копировать",
    "quick.copied": "Скопировано",
    "quick.selectText": "Выделите текст",
    "quick.note": "После установки запустите <code>opencode-control start</code>, чтобы снова открыть локальный Control UI.",
    "open.eyebrow": "Open Source",
    "open.title": "Посмотрите код, откройте issue или предложите fix.",
    "open.copy": "OpenCode Control распространяется под MIT license и задуман как local-first слой вокруг OpenCode CLI и его нативных project files.",
    "footer.license": "MIT License",
  },
};

const screenshotNames = {
  dashboard: "dashboard",
  sessions: "sessions",
  tasks: "tasks",
  mcp: "mcp",
  artifacts: "artifacts",
};

const languageButtons = document.querySelectorAll("[data-lang-switch]");
const docLink = document.querySelector("[data-doc-link]");
const copyButtons = document.querySelectorAll("[data-copy-target]");

function initialLanguage() {
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested === "ru" || requested === "en") return requested;
  const stored = window.localStorage.getItem("opencode-control-language");
  if (stored === "ru" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function text(language, key) {
  return dictionaries[language][key] ?? dictionaries.en[key] ?? "";
}

function applyLanguage(language) {
  document.documentElement.lang = language;
  document.documentElement.style.setProperty("--hero-image", `url("images/dashboard-${language}.png")`);
  document.body.dataset.lang = language;
  document.title = "OpenCode Control";

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.innerHTML = text(language, element.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-attr]").forEach((element) => {
    element.dataset.i18nAttr.split(";").forEach((pair) => {
      const [attribute, key] = pair.split(":");
      if (attribute && key) element.setAttribute(attribute, text(language, key));
    });
  });

  document.querySelectorAll("[data-shot]").forEach((image) => {
    const name = screenshotNames[image.dataset.shot];
    if (name) image.src = `images/${name}-${language}.png`;
  });

  if (docLink) {
    docLink.href = language === "ru"
      ? "https://github.com/Enzzo657/Opencode-Control/blob/main/README.md"
      : "https://github.com/Enzzo657/Opencode-Control/blob/main/README_en.md";
  }

  languageButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.langSwitch === language));
  });

  window.localStorage.setItem("opencode-control-language", language);
}

languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const language = button.dataset.langSwitch;
    if (language === "ru" || language === "en") applyLanguage(language);
  });
});

copyButtons.forEach((button) => {
  const label = button.querySelector("[data-copy-label]");

  button.addEventListener("click", async () => {
    const language = document.documentElement.lang === "ru" ? "ru" : "en";
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target || !label) return;

    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.classList.add("is-copied");
      label.textContent = text(language, "quick.copied");
      window.setTimeout(() => {
        button.classList.remove("is-copied");
        label.textContent = text(language, "quick.copyButton");
      }, 1800);
    } catch {
      label.textContent = text(language, "quick.selectText");
      window.setTimeout(() => {
        label.textContent = text(language, "quick.copyButton");
      }, 1800);
    }
  });
});

applyLanguage(initialLanguage());
