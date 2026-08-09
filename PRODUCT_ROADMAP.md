# OpenCode Control: Product Roadmap

Актуальный план развития локального control plane для OpenCode. Документ описывает
только оставшуюся работу. Реализованные этапы приведены кратко, без старых checklist
и вариантов реализации.

Обновлено: 9 августа 2026.

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
- Lazy Markdown и screen chunks; initial bundle остаётся ниже warning threshold Vite.
- Безопасный импорт Skills по HTTPS: pinned public IP, redirect revalidation, bounded
  UTF-8 Markdown и полные GitHub directory bundles, commit pinning, manifest preview,
  project/global scope и конфликты `skip`/`overwrite`/`rename`.
- Native Skills можно переименовывать и переносить между project/global scope вместе
  со всеми scripts, references, data, templates и другими sidecar-файлами.
- Project/global Dashboard с периодами, message-level usage, дедупликацией,
  локальной timezone, adaptive day/week/month buckets, читаемой шкалой и breakdown по
  моделям, providers, agents и cache.
- Dashboard вынесен из монолитного `App.tsx` в самостоятельный screen module; добавлен
  typed RU/EN translation catalog как основа постепенной локализации.
- Локальный поиск по названиям Sessions и тексту user/assistant messages для текущего
  проекта и global scope с incremental SQLite index, ranked pagination, permanent
  message deep links, keyboard shortcut и partial results.
- Полный Artifacts lifecycle для текущего или всех проектов: безопасные previews для
  image/PDF/CSV/JSON/TXT/Markdown/LOG/ZIP, filters и sort в URL, deep link к исходному
  сообщению, Finder, системная Корзина, bulk ZIP и bulk trash без сканирования project root.
- Локальные изображения в Sessions с inline preview, полноэкранной gallery, Finder и
  системной Корзиной; действия имеют mouse, touch и keyboard states.

## Текущие ограничения

- Строгий exactly-once dispatch невозможен без idempotency key OpenCode. Control
  сохраняет неоднозначный HTTP-результат как `ambiguous` и не делает blind retry.
- Локальные secrets хранятся plaintext-файлами с правами `0600`.

## 1. Локализация и декомпозиция UI

- [x] Добавить небольшой typed translation layer без тяжёлого i18n framework.
- [x] Вынести русские строки в словарь.
- [x] Добавить английский словарь.
- [x] Учитывать язык браузера и сохранять выбор пользователя.
- [x] Локализовать даты, числа, стоимость и timezone labels.
- [x] Добавить тест полноты translation keys.
- [x] Разделить `App.tsx` на экраны, shell-компоненты и общие UI-модули.
- [x] Разделить translation runtime и RU/EN каталоги и заменить transitional ключи
  семантическими именами.

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

## 2. Центр событий и уведомлений

Следующий продуктовый этап после завершения Search и Artifacts.

- [ ] Собрать завершения и ошибки Tasks и Sessions в единый локальный event stream.
- [ ] Показывать ненавязчивые in-app уведомления без зависимости от открытого экрана.
- [ ] Добавить unread state, фильтры по проекту и переход к исходной Task или Session.
- [ ] Подключить системные уведомления как явную opt-in настройку.
- [ ] Не сохранять prompt, message text и secrets в notification payload.

## Рекомендуемый порядок

1. Реализовать локальный центр событий и in-app уведомления.
2. После него провести stabilization pass и решить, готова ли alpha к public release.
3. Возврат к Plugins и Windows только после отдельного security/platform решения.
