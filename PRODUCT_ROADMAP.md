# OpenCode Control: Product Roadmap

Актуальный план развития локального control plane для OpenCode. Документ описывает
только оставшуюся работу. Реализованные этапы приведены кратко, без старых checklist
и вариантов реализации.

Обновлено: 17 августа 2026.

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
- Устойчивая project root identity: обычная смена macOS device ID после reboot не
  требует повторной регистрации, а замена корневой директории по-прежнему блокируется.
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
- [x] Отдельные RU/EN README и обезличенная галерея основных desktop/mobile экранов.
- Воспроизводимый demo-сценарий для release screenshots.

### Plugins Manager

Отложен до отдельного security design. Plugin является исполняемым
JS/TS-кодом с правами пользователя и может читать credentials, выполнять shell и
отправлять данные в сеть. URL/npm installation не должна появляться раньше preview,
pinned versions, source verification, backup и явного подтверждения.

### Windows

Отложен до стабилизации macOS/Linux. Потребуется отдельная реализация process groups,
signals, file locks, workspace security для reparse points и native Windows tests.

## 2. Центр событий

Следующий продуктовый этап после завершения Search и Artifacts.

- [x] Собрать завершения и ошибки Tasks и Sessions в единый локальный event stream.
- [x] Показывать события во встроенной панели независимо от открытого экрана.
- [x] Добавить unread state, фильтры по проекту и переход к исходной Session.
- [x] Хранить successful history без unread badge и проблемы/permissions с badge.
- [x] Не сохранять prompt, message text и secrets в event payload.
- Системные уведомления macOS/Linux не планируются: события остаются внутри Control.

## Рекомендуемый порядок

### Подтверждённые проверки

- [x] 12-часовой scheduler/recovery soak завершён 13 августа 2026: 43 200 циклов
  за 44 429,884 секунды, 43 200 terminal events, 3 021 crash recovery,
  0 активных runs и `PRAGMA integrity_check = ok`.
- [x] Выполнен реальный reboot macOS с сохранением Control SQLite, Tasks, Sessions и
  managed project registry. Обнаруженная смена APFS device ID исправлена через
  устойчивую root identity и закрыта regression-тестами.
- Проверка после внезапного power loss отдельно не проводилась.

### Завершённый resilience pass

- [x] Автоматически обновлять CSRF session открытой SPA после restart Control.
- [x] Не завершать Tasks по degraded snapshot без sessions/statuses.
- [x] Reconcile Task только по текущей execution Session, а не по всей истории.
- [x] Выполнять reconciliation из snapshot-потока и фонового scheduler cycle.
- [x] Сохранять последний полный Sessions snapshot во время reconnect.
- [x] Не дублировать server lifecycle и scheduled terminal events при retry.
- [x] Дожидаться background commands перед закрытием SQLite и managed OpenCode.
- [x] Принимать healthy managed OpenCode process после `SIGKILL` без второго spawn.
- [x] Проверять orphan через root identity и authenticated health из private registry.
- [x] Закрыть config transaction crash-window между write и manifest update.
- [x] Использовать at-most-once recovery для scheduled session creation.
- [x] Пропускать downtime cron runs старше двух минут без массового catch-up.
- [x] Добавить изолированный scheduler/recovery soak harness с SQLite integrity check.

1. Добавить runtime access token перед публичным распространением.
2. Подключить GitHub Actions и clean wheel smoke tests на macOS и Ubuntu.
3. После release checks решить, готова ли alpha к public release.
4. Возврат к Plugins и Windows только после отдельного security/platform решения.
