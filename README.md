# Life Log Bot

Telegram-бот: пишешь свободным текстом что сделал (тренировка, еда, траты),
бот через Gemini раскладывает это по полям и сохраняет в Notion-базу.
Если нужного поля ещё нет — бот сам добавляет его в базу.

## Важно: настройка Notion-базы перед первым запуском

В Notion-базе первое (title) свойство по умолчанию называется **"Name"**.
Код в `api/webhook.js` ожидает именно это название. Если ты переименовал
первую колонку в базе — поменяй значение `Name` на своё в функции
`createNotionPage` внутри `api/webhook.js`.

## Деплой на Vercel

1. Залей этот проект в свой GitHub-репозиторий (например `life-log-bot`).
2. На vercel.com → "Add New Project" → выбери репозиторий → Deploy.
3. В настройках проекта → Environment Variables → добавь:
   - `TELEGRAM_TOKEN`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (необязательно, по умолчанию `gemini-2.5-flash`)
   - `NOTION_API_KEY`
   - `NOTION_DATABASE_ID`
4. После деплоя скопируй URL проекта, например:
   `https://life-log-bot.vercel.app`

## Подключение Telegram webhook

Вставь в браузер (замени токен и домен на свои):

```
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://life-log-bot.vercel.app/api/webhook
```

Должен прийти ответ `{"ok":true,"result":true,"description":"Webhook was set"}`.

## Проверка

Напиши боту в Telegram, например:

```
сделал планку 6 минут
```

Бот должен ответить подтверждением, и в Notion-базе появится новая строка.

## Как найти NOTION_DATABASE_ID

Открой свою базу в Notion в браузере, URL будет вида:

```
https://www.notion.so/myworkspace/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=...
```

ID базы — это 32-символьная строка сразу после последнего `/` и до `?`.
