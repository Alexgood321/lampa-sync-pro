# Supabase API v1

Дата аудита и деплоя: **7 ноября 2026 г.** Проект: **Lampa Sync Pro** (`kkrmivgrnfqauvplccqm`, регион `eu-west-1`). Миграции:

- `20261106232355_lsp_sync_v1_initial.sql`
- `20261106232634_lsp_sync_v1_hardening.sql`
- `20261106233416_lsp_sync_v1_reset_resume_consistency.sql`

## Статус

**База и RPC работают в тестах SQL.** Альфа-клиент выполняет Auth и REST-запросы, однако подписанный JWT и HTTP E2E с TV/iOS пока не проверялись. Действующие Lampa/HDRezka/NUM не изменялись.

## Подключение

PostgREST RPC работает через HTTPS:

`https://kkrmivgrnfqauvplccqm.supabase.co/rest/v1/rpc/<имя_функции>`

Клиент должен отправлять **пользовательский JWT Supabase Auth** и публичный publishable key:

```http
POST /rest/v1/rpc/lsp_sync_snapshot HTTP/1.1
Host: kkrmivgrnfqauvplccqm.supabase.co
Content-Type: application/json
apikey: <SUPABASE_PUBLISHABLE_KEY>
Authorization: Bearer <SUPABASE_USER_ACCESS_TOKEN>

{}
```

**Не вставлять `service_role`, secret key, JWT или токены Netlify/HDRezka в репозиторий.** У каждого устройства одна пользовательская идентичность, отдельная локальная Auth-сессия. TV pairing проектируется отдельно.

Доступны 4 функции:

| RPC | JSON параметры | Результат |
|---|---|---|
| `lsp_sync_snapshot` | `{}` | `revision,watch_state,source_progress,resume_pointers` |
| `lsp_sync_pull` | `{"p_since":0,"p_limit":100}` | `server_revision,next_revision,has_more,events` |
| `lsp_sync_push` | `{"p_events":[...],"p_expected_revision":0}` | `status,revision,accepted,duplicates,ignored` |
| `lsp_get_resume` | `{"p_media_key":"tmdb:tv:1000"}` | Позиция и источник либо `null` |

При устаревшей `p_expected_revision` запись не выполняется: возвращается `{"status":"conflict","revision":N}`. **Это прикладной статус, не обязательный HTTP 409.** Клиент должен выполнить pull, согласовать локальные события и повторить push.

## Формат события

```json
{
  "schema": 1,
  "event_id": "a1111111-1111-4111-8111-111111111111",
  "device_id": "d1111111-1111-4111-8111-111111111111",
  "device_seq": 1,
  "base_revision": 0,
  "kind": "started",
  "media_key": "tmdb:tv:1000",
  "episode_key": "s2:e5",
  "playback_session_id": "b1111111-1111-4111-8111-111111111111",
  "source_kind": "torrent",
  "source_recipe": {
    "infohash": "0123456789ABCDEF0123456789ABCDEF01234567",
    "file_index": 4,
    "file_path": "S02E05.mkv"
  },
  "position_seconds": 1120,
  "duration_seconds": 2700
}
```

Все значения примера фиктивны.

### `kind`

- Playback: `started`, `progress`, `paused`, `stopped`, `completed`. Требуют `playback_session_id`, `source_kind`, `source_recipe` и позиции.
- Ручные действия: `marked_complete`, `marked_unwatched`, `deleted`. **Без** `source_kind`, `source_recipe` и позиции.

### `media_key`

`tmdb:tv:1234`, `tmdb:movie:1234`, `imdb:tt123456`, `kinopoisk:1234`, `provider:rezka:1234`.

`episode_key`: `movie` или `s2:e5`. Для TMDb movie допустим только `movie`.

### Источники

- `torrent`: `infohash` (40 HEX или 32 Base32), `file_index` (0..100000), `file_path` (1..600 символов), опционально `torrent_title`. Секреты трекеров, magnet-URL, HTTP-потоки запрещены.
- `hdrezka`: `film_id`, `season_id`, `episode_id`, `translator_id` (числовые идентификаторы в строках); необязательное `voice_label`. **Синхронизация HDRezka ещё не активирована.**

Обе записи хранятся раздельно, даже если относятся к одной серии. Страница HDRezka без подтверждённого TMDb ID не объединяется с похожими названиями.

### Ограничения v1

- Максимум **50 событий** и **100 KB** JSON на один push.
- Позиция/длительность от 0 до 86400 секунд. Нельзя превышать длительность более чем на 30 секунд.
- Pull: `p_limit` от 1 до 200, курсор `p_since >= 0`.
- Snapshot допускает максимум 2500 записей состояния; более крупные истории нужно восстанавливать через `pull` с нулевого курсора.
- `device_seq` строго возрастает внутри одного устройства; повторный `event_id` дедуплицируется.
- Успешно принятые события имеют серверные последовательные ревизии.
- `ignored>0` означает конфликтующее/устаревшее событие, сохранённое в журнале с `applied:false`. Клиент не должен считать его применённым.
- Пользователь, часовой пояс и client timestamp **не передаются** как полномочие изменения чужих строк.

## Доступ к БД

6 таблиц в `public` с включённым RLS и `SELECT` только для `authenticated`. `INSERT/UPDATE/DELETE` на них для клиентских ролей запрещены. Привилегированный писатель расположен в **`lsp_private`** (неэкспонированная схема), доступен только через проверенный `public.lsp_sync_push`.

Внутри SQL writer использует `auth.uid()`, игнорирует переданные значения `user_id`, сериализует ревизии и создаёт атомарные пачки с очисткой разрешённых полей. Проверка прав основана на подписанной пользовательской сессии Supabase Auth, а не на произвольном ID в URL.

## Проверка

Автоматизированный SQL smoke: [`tests/supabase_smoke.sql`](../tests/supabase_smoke.sql). Запускается администратором БД внутри одной транзакции, **все тестовые записи откатываются**. Тесты имитируют `authenticated` и JWT subject через `SET LOCAL ROLE` и `set_config`; это **не эквивалент подписанной HTTP Auth-сессии**.

На 7 ноября 2026 г.: **19/19 SQL-проверок выполнены**, Supabase Security Advisor **0 замечаний**, Performance Advisor **0 замечаний**, пользовательские таблицы пустые.

Для E2E требуется подтвердить настоящий HTTP-запрос с валидным JWT и CORS на устройствах. Пока проверены лишь SQL-транзакции и клиентские моки. [Альфа-клиент](PLUGIN_ALPHA.md).
