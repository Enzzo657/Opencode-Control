# OpenCode Control

OpenCode Control is a local-first control plane for OpenCode. It keeps projects,
sessions, tasks, agents, skills, MCP servers and workspace instructions in one
clear interface while OpenCode remains the execution engine.

## Требования

- macOS или Linux;
- `uv` с доступным Python 3.12;
- Node.js и npm для локальной сборки alpha-версии;
- OpenCode CLI в `PATH` для запуска managed project servers.

Control работает только на loopback. Проекты с external OpenCode endpoint можно
настраивать и без локального OpenCode CLI.

## Установка

После клонирования репозитория выполните из его корня:

```bash
./install.sh
```

Installer выполнит `npm ci`, соберёт frontend и wheel, установит его в отдельное
окружение через `uv tool install` и запустит Control. Node.js нужен только во
время локальной сборки; установленное приложение запускается без Node.js.
Если каталог команд `uv` отсутствует в `PATH`, installer предложит добавить его
через `uv tool update-shell`; изменение применяется в новом Terminal.

Если Control уже работает, installer спросит, перезапускать ли его. Отказ не
прерывает активные managed OpenCode sessions: новая версия установится, а
перезапуск можно выполнить позже.

Если команда `opencode-control` не появилась в новом Terminal:

```bash
uv tool update-shell
```

## Управление

```bash
opencode-control start
opencode-control status
opencode-control restart
opencode-control stop
opencode-control logs
```

`start` и `restart` запускают Control в фоне на `http://127.0.0.1:8765` и
открывают браузер. Чтобы не открывать браузер:

```bash
opencode-control start --no-open
```

Control защищён от параллельного запуска file lock-ами и удаляет незавершённый
дочерний процесс, если startup не завершился. Managed project servers запоминают
состояние: Start включает автоматическое восстановление при следующем запуске
Control, а Stop для конкретного проекта отключает его. Поэтому общий restart
Control временно перезапускает ранее включённые project servers автоматически.

## Дашборд и usage

Главный экран `Дашборд` объединяет Runtime выбранного проекта и аналитику OpenCode.
Можно переключаться между текущим проектом и всеми проектами, а также выбирать период:
сегодня, 7 дней, 30 дней или всё доступное время. При открытии выбран период `Сегодня`.
Usage считается по assistant messages
с дедупликацией message ID и группируется в timezone браузера.

Дашборд показывает input/output/reasoning tokens, cache read/write, стоимость, Sessions,
динамику по дням и breakdown по моделям, providers, agents и проектам. Основной total,
дневной график и рейтинги считают только input + output + reasoning. Cache показан
отдельной карточкой и в общей полоске распределения, но не раздувает обычные токены.
OpenCode рассчитывает стоимость отдельно по тарифам input, output, reasoning и cache.
В global scope недоступный проект не ломает всю сводку: интерфейс показывает частичный
результат и явное предупреждение. Аналитика строится по истории, которая ещё доступна
в OpenCode; после удаления Session или Task её usage сразу удаляется из totals.
Дочерние subagent Sessions учитываются в токенах и стоимости родительской Session, но
не увеличивают число пользовательских Sessions в карточках и рейтингах.

## Версия, JSONC и redaction

Версия продукта хранится в `src/opencode_control/__init__.py`. Hatch использует её для
wheel metadata, FastAPI и `/health` возвращают то же значение, HTTP User-Agent и sidebar
Control также получают версию из этого источника. Версия private frontend package не
является версией продукта.

Точечные изменения MCP, providers и structured configuration используют позиционный
JSONC patcher. Он сохраняет комментарии, отступы, порядок ключей, trailing commas,
пустые строки и CRLF/LF, изменяя только нужные values или object members. Duplicate
keys и неоднозначный JSONC блокируют операцию до записи; полной сериализации как
fallback нет. Preflight, backup и rollback продолжают применяться после patching.

Общий redaction layer очищает cookies, Basic/Bearer authorization, известные API token
formats, credentials и query values в URL, secret CLI arguments, provider/tool errors,
startup diagnostics и log tail. Ссылки вида `{env:NAME}` и `{file:path}` остаются
видимыми, поскольку не содержат literal secret.

Для другого loopback-порта:

```bash
opencode-control start --port 8876
```

Последние 100 строк основного лога:

```bash
opencode-control logs
```

Непрерывный просмотр до `Ctrl+C` и другой размер истории:

```bash
opencode-control logs --follow --lines 250
```

## Обновление alpha-версии

Получите изменения репозитория и повторно запустите:

```bash
./install.sh
```

Проекты, задачи, сессии и конфигурация хранятся отдельно в
`~/.opencode-control` и при переустановке wheel не удаляются.
Каталог данных можно переопределить переменной `OPENCODE_CONTROL_HOME`.

Интерактивное удаление отдельно спросит, нужно ли удалить локальные данные:

```bash
opencode-control uninstall
```

Для автоматизированного безопасного вызова без вопросов используйте
`opencode-control uninstall --yes`: данные сохранятся. Явное полное удаление:

```bash
opencode-control uninstall --yes --purge-data
```

Purge удаляет только проверенное содержимое `~/.opencode-control`.

## Ручная копия данных

Project-файлы, Agents, Skills, Commands и `AGENTS.md` уже находятся в директории
проекта и переносятся через Git или обычное копирование. Отдельный export Control
для них не нужен. Внутреннее состояние Tasks и расписаний хранится в SQLite.

Перед копированием SQLite остановите Control, чтобы последние WAL-изменения были
записаны в основной файл:

```bash
opencode-control stop
cp ~/.opencode-control/control.sqlite ~/control-backup.sqlite
opencode-control start --no-open
```

Для восстановления остановите Control, верните файл на место, установите права
`0600` и снова запустите его. История сообщений OpenCode хранится отдельно в
`~/.local/share/opencode/`, а global config — в `~/.config/opencode/`.

## Логи

Основной лог находится в `~/.opencode-control/control.log`, project logs — в
`~/.opencode-control/logs/`. Перед каждым запуском файл больше 10 MB ротируется;
сохраняются три backup-файла `.1`, `.2`, `.3`. В активный лог попадает только
новый запуск, поэтому старый большой лог не продолжает бесконечно расти. Строки
основного runtime-лога содержат локальные дату и время.

## Development

```bash
uv sync --extra dev
npm ci --prefix web
npm run build --prefix web
uv run uvicorn opencode_control.app:create_app --host 127.0.0.1 --port 8765
```

### Что именно запускается

- `opencode-control` — локальный веб-интерфейс на порту `8765`. Он хранит список
  добавленных проектов и показывает Sessions, Tasks, Agents, Skills и MCP.
- Кнопка `Start server` внутри Control запускает для выбранного проекта отдельный
  процесс `opencode serve` на случайном локальном порту.
- Этот отдельный OpenCode server читает global config из
  `~/.config/opencode/`, затем добавляет настройки выбранного проекта.
- TUI, запущенный отдельно в Terminal, и managed server внутри Control — два
  разных процесса. У них общие конфигурационные файлы, но отдельные текущие MCP
  соединения и состояние запуска.
- После изменения Agent или Skill Control автоматически обновляет работающий
  managed OpenCode server выбранного проекта.
- Проектные инструкции лежат в `<project>/AGENTS.md`. Нативные project Skills
  сохраняются в `<project>/.opencode/skills/<name>/SKILL.md`; отдельный
  `skills.paths` для этого не требуется.

## Как импортировать Skill по HTTPS

Ручное создание Skills осталось доступно без изменений. На экране `Навыки` нажмите
`Создать навык` и выберите одну из вкладок:

- `Вручную` открывает обычный редактор `SKILL.md`.
- `По HTTPS` скачивает готовый Skill только после безопасной проверки и сначала
  показывает полный preview.

Проще всего взять ссылку на GitHub. Если рядом с `SKILL.md` есть `scripts/`,
`references/`, `data/`, `templates/` или другие файлы, скопируйте URL всего каталога:

```text
https://github.com/owner/repository/tree/main/path/to/skill
```

Control зафиксирует branch/tag на конкретный commit SHA и импортирует полный каталог.
Обычная GitHub-ссылка на `blob/.../SKILL.md` также автоматически импортирует весь
родительский каталог. Только прямой Raw URL используется как явный однофайловый импорт:

```text
https://github.com/owner/repository/blob/main/path/SKILL.md
https://raw.githubusercontent.com/owner/repository/main/path/SKILL.md
```

Также подходит прямая HTTPS-ссылка с другого сайта, если она возвращает Markdown или
plain text. До подтверждения Control ничего не записывает и не перезапускает. Он
проверяет публичный DNS/IP, каждый redirect, TLS, MIME type, максимум 200 файлов,
лимит 1 MiB на файл и 10 MiB на bundle, строгий UTF-8 для `SKILL.md` и обязательные
`name`/`description` в frontmatter. Localhost, private networks, HTTP downgrade,
symlinks, submodules, credentials в URL и compressed responses отклоняются.

В preview видны исходный URL, конечный URL после redirects, путь назначения, SHA-256,
rendered Markdown, полный исходный `SKILL.md` и manifest всех файлов bundle. При
конфликте можно:

- пропустить импорт;
- явно перезаписать native Skill выбранного scope;
- переименовать одновременно каталог и поле `name`, после чего проверить новый
  итоговый preview.

Project Skill сохраняется в `<project>/.opencode/skills/<name>/SKILL.md`, global Skill
в `~/.config/opencode/skills/<name>/SKILL.md`. Skills из `.claude/skills` и
`.agents/skills` не перезаписываются импортом. Загруженный Markdown не выполняется во
время preview. Скрипты сохраняются с bundle рядом с `SKILL.md`, но Control их не
запускает. После установки Skill становится инструкцией для агента, поэтому источник,
manifest и содержимое нужно проверить перед подтверждением.

Собственный native Skill можно переименовать или перенести между project/global scope
через основные поля редактора. Control переносит весь каталог вместе с sidecar-файлами,
а не только `SKILL.md`.

## Как работают MCP-настройки

Control показывает три связанных, но разных состояния MCP:

- **Для всех проектов** — полное базовое описание из global config в
  `~/.config/opencode/opencode.json(c)`: тип, команда или URL, headers и
  `enabled`.
- **Для проекта** — локальная запись из `<project>/opencode.json(c)`. OpenCode
  глубоко объединяет ее с одноименной общей настройкой, поэтому для локального
  включения или выключения достаточно `{ "enabled": false }` либо
  `{ "enabled": true }`.
- **Сейчас в OpenCode** — не третья настройка, а фактическое состояние MCP в
  уже запущенном OpenCode server: подключен, отключен или завершился с ошибкой.

Если общий MCP включен, а пользователь выключает его только для проекта, Control
создает минимальное локальное переопределение:

```json
{
  "mcp": {
    "context7": {
      "enabled": false
    }
  }
}
```

При повторном включении Control не оставляет лишнее `{ "enabled": true }`, если
оно совпадает с общей настройкой. Локальная запись удаляется, и проект снова
наследует глобальное состояние. Кнопка `Использовать общую настройку` также
явно удаляет project override. Если в локальной записи есть другие поля, Control
удаляет только избыточный `enabled`, сохраняя остальные проектные настройки.

Изменения записываются сразу. Уже работающий managed OpenCode server Control
автоматически быстро перезапускает, поэтому пользователь ничего не должен делать
вручную. Остановленный managed server остается остановленным до обычного запуска.
Если пользователь сам подключил отдельно запущенный external endpoint, Control
изменит конфигурационный файл, но не будет управлять жизненным циклом чужого
процесса.

## Как работает запуск задачи

1. В переключателе проектов выберите нужную директорию.
2. Убедитесь, что для проекта показан статус `Server online`.
3. Откройте `Задачи` и нажмите `Запустить задачу`.
4. Control создаст основную OpenCode-сессию с рабочей директорией выбранного
   проекта. Агент будет читать и изменять файлы именно там.
5. OpenCode применит global config и global `AGENTS.md`, затем настройки,
   `AGENTS.md`, Agents и Skills выбранного проекта.
6. Если агент и модель не выбраны явно, используется `default_agent`, модель
   агента, последняя модель сессии или provider default — в таком порядке.
7. Control сохраняет фактическую модель задачи и подставляет её при продолжении
   связанных диалогов. Для следующего сообщения модель можно поменять вручную.
8. Task может владеть несколькими самостоятельными OpenCode-сессиями. Реальные
   вызовы подагентов остаются дочерними сессиями OpenCode.
9. Удаление Task удаляет все связанные с ней сессии и их дочерние subagent runs.
   Сессии, созданные напрямую в Control или CLI, не привязываются к Task.
10. Task можно повторно запустить вручную либо создать через понятный конструктор:
    каждые N минут, каждые N часов, каждый день или каждые N дней. Control сам
    формирует пяти-польный cron с выбранной IANA timezone. По умолчанию каждый
    автоматический запуск получает новую Session без истории прошлых запусков;
     при необходимости в редакторе расписания можно продолжать предыдущую Session.
     Расписание проверяется раз в 15 секунд, пока Control работает. Параллельный
     cron-run пропускается.
11. Каждый cron occurrence сначала атомарно сохраняется в SQLite и только затем
    отправляется в OpenCode. Run использует lease token, поэтому два scheduler worker
    не выполнят один и тот же сохранённый запуск одновременно. После restart Control
    восстанавливает claim, если внешние действия ещё не начинались.
12. Если соединение оборвалось в момент отправки prompt и нельзя доказать, принял ли
    его OpenCode, run получает состояние `ambiguous`: Control проверяет Session и не
    делает blind retry, который мог бы продублировать работу. Результат последнего
    запуска и причины `failed`, `skipped` или `cancelled` видны в карточке Task.

Файлы можно выбрать кнопкой или перетащить в форму или чат. Cron-задачи не принимают
вложения, потому что Control не сохраняет base64-вложения в SQLite для будущих
запусков.

## Slash Commands

Slash Command — нативный prompt-шаблон OpenCode. Project Commands хранятся в
`<project>/.opencode/commands/<name>.md`, global Commands — в
`~/.config/opencode/commands/<name>.md`. Они доступны одновременно в Control и
OpenCode TUI.

При добавлении проекта Control один раз создаёт в нём стартовые `/fix`, `/test`,
`/plan`, `/explain` и `/commit-check`. Это обычные project-файлы: их можно менять
или удалять, и после удаления Control не создаёт их повторно. Существующие файлы с
такими именами не перезаписываются. `/review` предоставляет сам OpenCode как runtime
Command; при необходимости её можно переопределить собственным project- или global-файлом.

В текущей Session введите команду и аргументы:

```text
/review авторизация и хранение токенов
```

Control вызывает нативный endpoint OpenCode `/session/{id}/command`; OpenCode сам
применяет `agent`, `model`, `variant`, `subtask`, `$ARGUMENTS` и `$1`, `$2`.
Неизвестная команда не отправляется как обычный prompt. Конструкция
`` !`shell command` `` выполняется самим OpenCode без дополнительного подтверждения;
в editor она помечается как Shell, а сохранение Command её не запускает.

Системная `/init` изучает репозиторий и создаёт или обновляет project `AGENTS.md`;
обычно она нужна один раз при первичной настройке проекта. Некоторые версии
OpenCode также публикуют Skills (`/customize-opencode`, `/context7-mcp` и project
Skills) через command API. Control показывает их отдельным сворачиваемым списком и
в обычном `/` palette, поэтому Skill можно выбрать вручную или оставить выбор агенту.

## Безопасное изменение конфигурации

Изменения MCP, providers и ручного `opencode.json/jsonc` проходят единый lifecycle:

1. Control создаёт candidate и проверяет его реальным `opencode --pure debug config`.
2. Global candidate должен пройти проверку для каждого зарегистрированного проекта.
3. До записи сохраняются точные bytes, mode и наличие затронутых файлов.
4. Candidate записывается атомарно, после чего перезапускаются только ранее работавшие
   managed servers.
5. При ошибке исходные файлы восстанавливаются byte-for-byte, а уже затронутые серверы
   запускаются на предыдущей конфигурации.

Pending backup существует только до commit или rollback в
`~/.opencode-control/config-transactions/`. После аварийного завершения Control
восстанавливает незавершённую транзакцию до запуска project servers. OpenCode старше
проверенной release line разрешается после preflight с предупреждением; версия без
обязательных config/API capabilities блокирует изменение. Недоступный внешний MCP не
откатывает healthy OpenCode server: он отображается как отдельная runtime-ошибка.

Список моделей в Control намеренно ограничен провайдерами, которые OpenCode
считает подключёнными или настроенными. Полный встроенный каталог `models.dev`
не показывается. Для текущей конфигурации это:

- OpenAI, подключённый через авторизацию OpenCode;
- встроенный OpenCode Zen;
- `ollama-home` из global `opencode.jsonc`.

Наличие custom/local provider в списке означает, что он настроен. Это не
гарантирует, что локальный Ollama-сервер сейчас включён и отвечает.

## Capabilities

- Register multiple local projects.
- Start and stop one managed `opencode serve` process per project.
- Inspect main sessions separately from child subagent sessions, including models,
  tokens, cost and live state.
- Create sessions, link multiple sessions to one Task, dispatch tasks, abort runs
  and remove individual sessions or a Task together with its sessions. Tasks can
  be rerun manually or scheduled with cron.
- Render session messages as safe GitHub-flavored Markdown and accept image
  attachments through file selection or drag-and-drop.
- See and edit project/global definitions for agents, skills and MCP servers while
  keeping effective configuration separate from live runtime connection state.
- Edit project `AGENTS.md`, `.opencode/agents/*.md`, `.opencode/skills/*/SKILL.md`
  and safe sections of `opencode.json`.
- Choose an available OpenCode agent and `provider/model` override when launching
  a task or session; leaving either empty uses the effective merged defaults.
- Choose a persistent Control palette from the searchable OpenCode-style theme list.
- Managed servers use an in-memory random password and are private to Control.
  To share one backend with a terminal TUI, start `opencode web` yourself,
  attach the TUI to it, and register that loopback URL as an external endpoint.

Project content stays local. OpenCode Control accepts only registered project
identifiers after registration and uses loopback-only OpenCode endpoints.
