# Delivery API

## Быстрый запуск

1. Откройте терминал в этой папке.
2. Выполните:

```powershell
npm.cmd install
npm.cmd start
```

Или запустите:

```powershell
.\start-local.ps1
```

API будет доступен по адресу:

```text
http://localhost:3000
```

Проверка доставки:

```text
POST http://localhost:3000/delivery
```

## Файл .env

В архив уже добавлен `.env`:

```env
YANDEX_GEOCODER_API_KEY=...
PORT=3000
```

Перед публикацией в GitHub лучше удалить `.env` из репозитория и хранить ключ в переменных окружения Railway.
