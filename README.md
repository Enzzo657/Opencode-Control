# OpenCode Control

OpenCode Control is a local-first control plane for OpenCode. It keeps projects,
sessions, tasks, agents, skills, MCP servers and workspace instructions in one
clear interface while OpenCode remains the execution engine.

## Development

```bash
uv sync --extra dev
npm install --prefix web
npm run build --prefix web
uv run opencode-control
```

Open `http://127.0.0.1:8765`. The server never binds to a non-loopback address.

## Запуск для обычного использования

### Первый запуск

Откройте Terminal и выполните команды по очереди:

```bash
cd /path/to/opencode-control
uv sync --extra dev
npm install --prefix web
npm run build --prefix web
uv run opencode-control --background --open
```

Последняя команда запускает **OpenCode Control** в фоне на
`http://127.0.0.1:8765` и открывает браузер. Terminal после этого можно закрыть.

### Последующие запуски

```bash
cd /path/to/opencode-control
uv run opencode-control --background --open
```

Управление фоновым процессом:

```bash
uv run opencode-control --status
uv run opencode-control --restart --open
uv run opencode-control --stop
```

### Миграция с OpenCode Studio

Первый запуск новой команды безопасно переносит локальное состояние из
`~/.opencode-studio` в `~/.opencode-control`:

```bash
uv run opencode-control --restart --open
```

Команда штатно останавливает старый runtime, создаёт согласованную копию SQLite
через Backup API, проверяет integrity и связи проектов, задач и сессий, переносит
логи и запускает OpenCode Control. Старый `~/.opencode-studio` не удаляется и
остаётся резервной копией. PID и временные WAL/SHM-файлы не переносятся.

Новый каталог можно переопределить переменной `OPENCODE_CONTROL_HOME`.

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

Файлы можно выбрать кнопкой или перетащить в форму или чат. Cron-задачи не принимают
вложения, потому что Control не сохраняет base64-вложения в SQLite для будущих
запусков.

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
