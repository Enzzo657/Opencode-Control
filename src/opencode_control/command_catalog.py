# ruff: noqa: RUF001

from __future__ import annotations

from typing import TypedDict


class StarterCommand(TypedDict):
    title: str
    summary: str
    examples: tuple[str, ...]
    content: str


STARTER_COMMANDS_VERSION = 1

# Removed from the starter set after OpenCode added its own richer runtime /review.
# Exact comparison lets the migration preserve any user-edited review command.
LEGACY_REVIEW_COMMAND_CONTENT = """---
description: Проверить текущие изменения без исправления кода
agent: plan
subtask: false
---

Проведи code review текущих изменений. Сначала изучи инструкции проекта и git diff.

Покажи findings по критичности со ссылками на файлы и строки. Ищи ошибки,
поведенческие регрессии, риски безопасности и недостающие тесты. Не изменяй файлы.

Дополнительный фокус пользователя: $ARGUMENTS
"""


STARTER_COMMANDS: dict[str, StarterCommand] = {
    "fix": {
        "title": "Исправить проблему",
        "summary": "Воспроизводит проблему, находит root cause и делает минимальное исправление.",
        "examples": ("/fix 404 повторяется в логах", "/fix проекты не стартуют после restart"),
        "content": """---
description: Найти причину проблемы и сделать минимальное исправление
agent: build
subtask: false
---

Исправь следующую проблему: $ARGUMENTS

Сначала воспроизведи её и установи root cause. Сделай минимальное корректное
изменение, добавь regression-тест и запусти релевантные проверки. Не изменяй
посторонний код и сообщи, что именно было причиной.
""",
    },
    "test": {
        "title": "Запустить проверки",
        "summary": "Выбирает релевантные тесты, запускает их и объясняет причины ошибок.",
        "examples": ("/test", "/test scheduler"),
        "content": """---
description: Запустить и диагностировать релевантные проверки
agent: build
subtask: false
---

Определи и запусти проверки, релевантные текущим изменениям и области:
$ARGUMENTS

Отдели ошибки продукта от проблем окружения. Не исправляй посторонние проблемы.
Сообщи точные команды, результаты и оставшиеся риски.
""",
    },
    "plan": {
        "title": "Подготовить план",
        "summary": "Исследует архитектуру и составляет реалистичный план без изменений кода.",
        "examples": ("/plan добавить импорт Skills", "/plan разделить App.tsx"),
        "content": """---
description: Исследовать задачу и составить план без изменения файлов
agent: plan
subtask: false
---

Подготовь план реализации следующей цели: $ARGUMENTS

Изучи текущую архитектуру и релевантные файлы. Укажи зависимости, риски,
минимальный порядок изменений, необходимые тесты и критерии готовности.
Не изменяй файлы.
""",
    },
    "explain": {
        "title": "Объяснить код",
        "summary": "Объясняет поток данных, ключевые функции и связи с указанием файлов.",
        "examples": ("/explain как работает scheduler", "/explain src/app.py"),
        "content": """---
description: Объяснить существующий код и поток данных
agent: plan
subtask: false
---

Объясни: $ARGUMENTS

Найди релевантные файлы, опиши поток данных, ключевые функции, зависимости и
важные ограничения. Ссылайся на файлы и строки. Не изменяй код.
""",
    },
    "commit-check": {
        "title": "Проверить перед commit",
        "summary": "Проверяет diff, тесты, secrets и предлагает commit message без commit.",
        "examples": ("/commit-check", "/commit-check изменения scheduler"),
        "content": """---
description: Проверить изменения перед commit без создания commit
agent: plan
subtask: false
---

Проверь рабочее дерево перед commit. Изучи git status и diff, найди случайные или
generated файлы, secrets, ошибки и недостающие тесты. Запусти необходимые проверки
и предложи краткий commit message. Не создавай commit.

Дополнительный фокус: $ARGUMENTS
""",
    },
}
