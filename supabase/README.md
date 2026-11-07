# Supabase для Lampa Sync Pro

Этот каталог зарезервирован для версионируемых SQL-миграций, RLS-политик и тестов базы данных.

**Применены четыре миграции** к отдельному Supabase-проекту `kkrmivgrnfqauvplccqm`:

- [`20261106232355_lsp_sync_v1_initial.sql`](migrations/20261106232355_lsp_sync_v1_initial.sql)
- [`20261106232634_lsp_sync_v1_hardening.sql`](migrations/20261106232634_lsp_sync_v1_hardening.sql)
- [`20261106233416_lsp_sync_v1_reset_resume_consistency.sql`](migrations/20261106233416_lsp_sync_v1_reset_resume_consistency.sql)
- [`20261107004025_lsp_sync_v1_preserve_position_on_start.sql`](migrations/20261107004025_lsp_sync_v1_preserve_position_on_start.sql)

6 таблиц в `public`, RLS для владельца, транзакционный writer в `lsp_private`, четыре RPC для клиента. Схема проверена SQL-тестами: [`tests/supabase_smoke.sql`](../tests/supabase_smoke.sql) (15), [`tests/supabase_reset_smoke.sql`](../tests/supabase_reset_smoke.sql) (4) и [`tests/supabase_preserve_checkpoint_smoke.sql`](../tests/supabase_preserve_checkpoint_smoke.sql) (5). Все тестовые данные откатились. Рабочий JS-клиент альфа доступен, реальный E2E Auth/CORS на устройствах ещё не проводился.

[Актуальный контракт API](../docs/API_V1.md).

Порядок будущего развёртывания:

1. Снять снимок текущей схемы отдельного проекта Lampa Sync Pro.
2. Подготовить и проверить миграции, включая запрет доступа между пользователями.
3. Применить миграцию к целевому проекту.
4. Проверить реальные REST-запросы от двух тестовых пользователей.
5. Сохранить процедуру отката.

Ключи проекта, сервисные JWT и приватные токены не должны попадать в репозиторий.
