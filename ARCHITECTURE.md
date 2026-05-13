# AnchorClaw — Architecture (vs OpenClaw memory-core / PostClaw)

## TL;DR

AnchorClaw делает **Postgres источником правды** для долговременной памяти, но сохраняет **совместимость с OpenClaw memory интерфейсами** (tools + `MemorySearchManager`), чтобы `status/doctor/CLI` продолжали работать прозрачно.

MVP намеренно **SQL-first и детерминированный** (без embeddings). Семантика/персона/граф знаний — отдельные, опциональные слои “поверх”, которые можно подключить позже без поломки базовых путей.

## Почему не просто PostClaw

PostClaw — DB+embeddings-first архитектура с более “AI-native” фичами (семантика, persona, knowledge graph).

AnchorClaw решает другую задачу:

- сохранить OpenClaw UX и совместимость (contracts, corpuses, CLI/doctor/status)
- сделать долговременную память **структурированной и обновляемой** (canonical upsert, стабильная сортировка, аудит)
- обеспечить базовую надежность и предсказуемость **без обязательной модели embeddings**

## Источники данных (MVP)

- `corpus="memory"`: Postgres (`memory_items`) — долговременная память (MVP: `fact` + `note`)
- `corpus="sessions"`: best-effort скан session JSONL на диске (совместимость, без индекса пока)
- `corpus="all"`: детерминированный merge (`memory + sessions`)
- `corpus="wiki"`: заглушка (пока); wiki-слой — future

## “Виртуальный” MEMORY.md

OpenClaw core по историческим причинам ожидает, что `MEMORY.md` можно читать.

В AnchorClaw:

- `memory_get(path="MEMORY.md")` и `MemorySearchManager.readFile({relPath:"MEMORY.md"})` возвращают **snapshot из Postgres** (виртуальное представление)
- физический файл `MEMORY.md` после миграции по умолчанию становится HTML-comment-only stub’ом, чтобы:
  - OpenClaw bootstrap не дублировал память в prompt
  - люди понимали, где лежит backup и что source-of-truth — Postgres

## Модель данных (упрощённо)

Durable слой:

- `memory_items`: активные долговременные знания
  - canonical upsert через `(type, namespace, canonical_key)` (MVP namespace=default)
  - `status='active'|'deleted'` (soft delete)
- `memory_audit_log`: след изменений (before/after) — future: retention/redaction policy

История/эпизоды (задел под PostClaw parity):

- `memory_events`: append-only события (MVP: импорт `memory/*.md` как snapshot event)

## Identity и scope-resolve (MVP)

Все чтения/записи идут в scope `(user_id, workspace_id)`.

- `workspace_id`:
  - вычисляется из `workspaceDir` (`name = dir:<sha256(resolved workspaceDir)>`)
  - поэтому смена workspace директории создаёт новый memory scope.
- `user_id`:
  - приоритет: `identity.externalId` из plugin config (stable key, `channel=anchorclaw-config`)
  - fallback: `sha256(normalized OS username)` (`channel=openclaw-cli`)

Операционный вывод:

- Для Docker/production обязательно задавать `identity.externalId`, иначе при смене OS user в контейнере scope может "прыгать".
- Плагин всегда логирует startup warning, если `identity.externalId` не задан.

## Где появятся PostClaw-style фичи

### Semantic layer (optional)

- отдельная таблица embeddings (vector) + “hybrid retrieval”
- контракт надежности: если embeddings отключены/ошибка — fallback на lexical (FTS) без деградации tool API

### Persona context (optional)

- отдельные типы/таблицы для persona/profile
- отдельные бюджеты на инжект (не смешивать с durable facts)

### Knowledge graph (optional)

- `entity_edges`-style связи
- multi-hop добор связанных узлов при retrieval

## Известные ограничения MVP

- sessions corpus: best-effort scan + cap + `score=1` (пока нет индекса)
- `corpus="wiki"`: не реализован
- типы кроме `fact/note` отложены до явной политики инжекта/записи
