# OpenCode Control: Product Roadmap

Актуальный план развития локального control plane для OpenCode. Документ описывает
только оставшуюся работу. Реализованные этапы приведены кратко, без старых checklist
и вариантов реализации.

Обновлено: 29 июля 2026.

## Принципы

- Local-first: проекты, история и конфигурация остаются на машине пользователя.
- OpenCode остаётся execution engine; Control не дублирует его agent runtime.
- Надёжность и сохранность данных важнее количества экранов.
- Не обещать exactly-once там, где внешний OpenCode HTTP API не предоставляет
  idempotency key.
- macOS и Linux являются целевыми платформами текущей alpha-версии.
- GitHub CI, public releases и Windows support отложены до отдельного решения.

## Реализованный фундамент

- Проекты, managed и external OpenCode servers.
- Sessions, chat, attachments, agents, models, todos и permissions.
- Tasks с несколькими Sessions, ручным rerun, abort и cron-расписанием.
- Agents, Skills, MCP, `AGENTS.md` и безопасное редактирование конфигурации.
- Provider auth и file-backed secrets без возврата значений в браузер.
- Git status, diff, stage, commit, revert и защищённый reset.
- Backend redaction известных secret-полей и command arguments.
- Полное переименование в OpenCode Control и безопасная миграция данных Studio.
- Локальная alpha-установка через `install.sh`, wheel и `uv tool`.
- CLI `start`, `restart`, `stop`, `status`, `logs` и безопасный `uninstall`.
- Ротация логов, timestamps и диагностика runtime.
- Atomic lifecycle Control: launch/runtime locks, cleanup startup failure и
  восстановление включённых managed project servers после restart.
- Durable scheduled runs: отдельные записи запусков, atomic materialization,
  lease fencing, recovery после restart, schedule revision, overlap history и
  явное состояние неопределённого dispatch.
- Slash Commands Manager: project/global Markdown, автоматические project defaults,
  structured editor, Skills palette и нативный запуск `/command arguments`.
- Сквозной model variant для Session, Tasks, cron, Commands и rerun.
- Transactional config lifecycle для MCP, providers и ручного editor: real OpenCode
  preflight, exact temporary backup, crash recovery, rollback и global isolation.
- Structured process diagnostics, per-project lifecycle locks и проверка совместимости
  OpenCode.
- Lazy Markdown chunk; production bundle остаётся ниже warning threshold Vite.
- Безопасный импорт Skills по HTTPS: pinned public IP, redirect revalidation, bounded
  UTF-8 Markdown и полные GitHub directory bundles, commit pinning, manifest preview,
  project/global scope и конфликты `skip`/`overwrite`/`rename`.
- Native Skills можно переименовывать и переносить между project/global scope вместе
  со всеми scripts, references, data, templates и другими sidecar-файлами.
- Project/global Dashboard с периодами, message-level usage, дедупликацией,
  локальной timezone и breakdown по моделям, providers, agents и cache.
- Dashboard вынесен из монолитного `App.tsx` в самостоятельный screen module; добавлен
  typed RU/EN translation catalog как основа постепенной локализации.

## Текущие ограничения

- Строгий exactly-once dispatch невозможен без idempotency key OpenCode. Control
  сохраняет неоднозначный HTTP-результат как `ambiguous` и не делает blind retry.
- Локальные secrets хранятся plaintext-файлами с правами `0600`.
- Большинство frontend-экранов всё ещё находится в `App.tsx`; Dashboard уже вынесен,
  остальные экраны будут переноситься вместе с локализацией.

## 1. Локализация и декомпозиция UI

- [x] Добавить небольшой typed translation layer без тяжёлого i18n framework.
- [ ] Вынести русские строки в словарь.
- [ ] Добавить английский словарь.
- [ ] Учитывать язык браузера и сохранять выбор пользователя.
- [ ] Локализовать даты, числа, стоимость и timezone labels.
- [ ] Добавить тест полноты translation keys.
- [x] Начать разделение `App.tsx` по экранам с Dashboard без отдельного rewrite.

## Техническая полировка

Эти задачи можно выполнять небольшими независимыми изменениями между продуктовыми
этапами.

- [x] Сделать одну точку хранения версии для package, API, User-Agent и UI.
- [x] Сохранять комментарии и форматирование JSONC при точечных изменениях.
- [x] Расширить redaction для cookies, нестандартных credential keys и вложенных
  provider options.
- [ ] Добавить runtime access token для read/write API перед публичным release.

## Отложено

### GitHub, CI и публичные releases

Отложено по текущему решению. Docker image для CI не требуется. Когда проект будет
готовиться к публичному распространению, вернуться к следующим пунктам:

- GitHub Actions для Ruff, mypy, pytest, ESLint, TypeScript, Vitest и Vite build.
- Clean wheel install и start/health/assets/stop smoke test на macOS и Ubuntu.
- `CHANGELOG.md`, SemVer, checksums и GitHub Releases.
- PyPI trusted publishing и установка без клонирования репозитория.
- README screenshots и воспроизводимый demo-сценарий.

### Plugins Manager

Отложен до отдельного security design. Plugin является исполняемым
JS/TS-кодом с правами пользователя и может читать credentials, выполнять shell и
отправлять данные в сеть. URL/npm installation не должна появляться раньше preview,
pinned versions, source verification, backup и явного подтверждения.

### Windows

Отложен до стабилизации macOS/Linux. Потребуется отдельная реализация process groups,
signals, file locks, workspace security для reparse points и native Windows tests.

## Рекомендуемый порядок

1. Локализация вместе с постепенным разбиением frontend.
2. Возврат к CI/releases, Plugins и Windows только после отдельного решения.
