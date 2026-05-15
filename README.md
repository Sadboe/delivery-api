# Delivery API для BotHelp

API проверяет адрес доставки:

1. Получает адрес из BotHelp.
2. Отправляет адрес в Яндекс Геокодер.
3. Получает координаты дома.
4. Проверяет координаты по зонам из `zones.geojson`.
5. Возвращает стоимость, время и статус.

## Важная логика

В коде нет списка разрешённых городов/районов. Заказать можно только туда, где координаты попали в одну из зон `zones.geojson`.

Если адрес в Москве, Турции или любом другом месте, Яндекс вернёт координаты, но они не попадут в зоны, и API вернёт:

```json
{
  "status": "out_of_zone"
}
```

Если Яндекс не смог определить дом, API вернёт:

```json
{
  "status": "error"
}
```

## Локальный запуск

Создать `.env`:

```env
YANDEX_GEOCODER_API_KEY=ваш_ключ_яндекса
PORT=3000
DEBUG_RESPONSE=true
```

Установить зависимости и запустить:

```bash
npm install
npm start
```

Проверка:

```powershell
.\test-local.ps1
```

## Railway

В Railway нужно добавить переменную:

```text
YANDEX_GEOCODER_API_KEY=ваш_ключ_яндекса
```

`PORT` добавлять не надо.

## BotHelp

Внешний запрос:

```text
POST https://ваш-домен/delivery
```

Заголовок:

```text
Content-Type: application/json
```

Тело:

```json
{
  "user_id": "{%user_id%}",
  "address": "{%address%}",
  "phone": "{%phone%}"
}
```

Сопоставление ответов:

```text
$.delivery_price -> delivery_price
$.delivery_time  -> delivery_time1
$.status         -> status
$.message        -> message
$.zone           -> zone
```

Условие после запроса:

```text
status соответствует ok
```

Да — продолжить оформление заказа.

Нет — показать сообщение, что адрес вне зоны доставки или введён некорректно.
