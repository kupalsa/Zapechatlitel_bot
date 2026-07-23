// api/webhook.js
//
// Принимает сообщения от Telegram-бота, отправляет текст в Gemini для
// классификации/извлечения полей (с учётом уже существующей схемы Notion-базы),
// при необходимости добавляет новые свойства в базу, создаёт запись и
// отвечает пользователю в Telegram.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const NOTION_VERSION = "2022-06-28";

// Типы полей, которые мы разрешаем модели создавать/использовать.
// text -> rich_text, number -> number, date -> date, select -> select
const ALLOWED_TYPES = ["text", "number", "date", "select"];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("OK - webhook is alive");
    return;
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message || !message.text) {
      // Игнорируем не-текстовые апдейты (стикеры, голосовые пока не обрабатываем и т.п.)
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const userText = message.text.trim();

    if (userText.startsWith("/start")) {
      await sendTelegramMessage(
        chatId,
        "Привет! Просто пиши мне свободным текстом, что сделал — тренировку, еду, траты — и я всё разложу и сохраню."
      );
      res.status(200).json({ ok: true });
      return;
    }

    // 1. Забираем текущую схему базы (какие поля уже есть)
    const schema = await getNotionSchema();

    // 2. Просим Gemini разобрать сообщение с учётом текущей схемы
    const parsed = await parseWithGemini(userText, schema);

    // 3. Если Gemini предложил новые поля — добавляем их в базу
    if (parsed.new_properties && parsed.new_properties.length > 0) {
      await addPropertiesToDatabase(parsed.new_properties, schema);
    }

    // 4. Создаём запись в Notion
    await createNotionPage(parsed);

    // 5. Отвечаем пользователю подтверждением
    const summary = buildConfirmationText(parsed);
    await sendTelegramMessage(chatId, summary);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    // Telegram ждёт 200 даже при ошибке, иначе будет ретраить бесконечно
    res.status(200).json({ ok: false, error: String(err) });
  }
};

// ---------- Notion ----------

async function getNotionSchema() {
  const resp = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`,
    {
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`Notion getSchema failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const properties = {};

  for (const [name, prop] of Object.entries(data.properties)) {
    properties[name] = mapNotionTypeToSimple(prop.type);
  }

  return properties; // { "Длительность_мин": "number", "Категория": "select", ... }
}

function mapNotionTypeToSimple(notionType) {
  if (notionType === "rich_text" || notionType === "title") return "text";
  if (notionType === "number") return "number";
  if (notionType === "date") return "date";
  if (notionType === "select") return "select";
  return "text"; // fallback для неизвестных типов
}

async function addPropertiesToDatabase(newProperties, existingSchema) {
  const propertiesPatch = {};

  for (const prop of newProperties) {
    if (existingSchema[prop.name]) continue; // уже есть, пропускаем
    if (!ALLOWED_TYPES.includes(prop.type)) continue; // неизвестный тип, пропускаем

    propertiesPatch[prop.name] = buildNotionPropertySchema(prop.type);
  }

  if (Object.keys(propertiesPatch).length === 0) return;

  const resp = await fetch(
    `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties: propertiesPatch }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Notion addProperties failed: ${resp.status} ${await resp.text()}`);
  }
}

function buildNotionPropertySchema(type) {
  switch (type) {
    case "number":
      return { number: { format: "number" } };
    case "date":
      return { date: {} };
    case "select":
      return { select: {} };
    case "text":
    default:
      return { rich_text: {} };
  }
}

async function createNotionPage(parsed) {
  const properties = {
    // Первое (title) поле в Notion базе должно называться так же, как в твоей базе.
    // По умолчанию Notion называет его "Name" — поменяй здесь, если у тебя иначе.
    Name: {
      title: [{ text: { content: parsed.title || "Запись" } }],
    },
  };

  for (const [name, field] of Object.entries(parsed.properties || {})) {
    if (!ALLOWED_TYPES.includes(field.type)) continue;
    properties[name] = buildNotionPropertyValue(field.type, field.value);
  }

  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Notion createPage failed: ${resp.status} ${await resp.text()}`);
  }
}

function buildNotionPropertyValue(type, value) {
  switch (type) {
    case "number":
      return { number: typeof value === "number" ? value : parseFloat(value) || null };
    case "date":
      return { date: { start: value } };
    case "select":
      return { select: { name: String(value) } };
    case "text":
    default:
      return { rich_text: [{ text: { content: String(value) } }] };
  }
}

// ---------- Gemini ----------

async function parseWithGemini(userText, schema) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }); // YYYY-MM-DD

  const schemaDescription = Object.entries(schema)
    .filter(([name]) => name !== "Name")
    .map(([name, type]) => `- ${name} (${type})`)
    .join("\n") || "(пока пусто, полей ещё нет)";

  const prompt = `Ты — ассистент, который раскладывает свободный текст пользователя по полям базы данных для личного трекера (тренировки, еда, траты, привычки и т.д.).

Сегодняшняя дата: ${today} (используй её, если пользователь не указал дату явно).

Уже существующие поля в базе:
${schemaDescription}

Правила:
1. Если информация из сообщения подходит под уже существующее поле — используй именно его (то же название, тот же тип).
2. Если это принципиально новая информация, для которой нет подходящего поля — предложи новое поле в "new_properties". Название короткое, на русском, в стиле уже существующих.
3. Разрешённые типы полей: "text", "number", "date", "select".
4. Всегда включай поле "Дата" с типом "date" (используй сегодняшнюю дату, если явно не сказано другое).
5. Верни ТОЛЬКО валидный JSON, без markdown-разметки, без пояснений, строго в такой структуре:

{
  "title": "короткое название записи (3-6 слов)",
  "properties": {
    "Название поля 1": { "type": "text|number|date|select", "value": "..." },
    "Название поля 2": { "type": "...", "value": "..." }
  },
  "new_properties": [
    { "name": "Название нового поля", "type": "text|number|date|select" }
  ]
}

Сообщение пользователя: "${userText}"`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Gemini request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Не удалось распарсить ответ Gemini как JSON: ${cleaned}`);
  }

  return parsed;
}

// ---------- Telegram ----------

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function buildConfirmationText(parsed) {
  const lines = [`✅ Сохранил: ${parsed.title || "запись"}`];

  for (const [name, field] of Object.entries(parsed.properties || {})) {
    lines.push(`• ${name}: ${field.value}`);
  }

  if (parsed.new_properties && parsed.new_properties.length > 0) {
    const names = parsed.new_properties.map((p) => p.name).join(", ");
    lines.push(`\n➕ Добавил новые поля в базу: ${names}`);
  }

  return lines.join("\n");
}
