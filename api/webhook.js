// api/webhook.js
//
// Telegram-бот: принимает свободный текст, определяет категорию, разбирает
// сообщение через Gemini (с учётом схемы нужной Notion-базы, уже
// использованных select-вариантов и названий), сохраняет запись.
//
// Также умеет: следить за размером категории в главной базе и предлагать
// вынести её в отдельную Notion-базу; а по команде пользователя ("раздели
// <категория>") — реально создать новую базу и перенести туда все записи
// этой категории из главной базы.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;
const TIMEZONE = "Asia/Jerusalem";
const NOTION_VERSION = "2022-06-28";

const ALLOWED_TYPES = ["text", "number", "date", "select"];
const CATEGORIES = ["Тренировка", "Еда", "Траты", "Привычка", "Другое"];
const SPLIT_THRESHOLD = parseInt(process.env.SPLIT_THRESHOLD || "15", 10);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("OK - webhook is alive");
    return;
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message || !message.text) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = message.chat.id;
    const userText = message.text.trim();

    if (userText.startsWith("/start")) {
      await sendTelegramMessage(
        chatId,
        "Привет! Пиши мне свободным текстом, что сделал — тренировку, еду, траты — и я всё разложу и сохраню.\n\n" +
          "Если в какой-то категории накопится много записей, я сам предложу вынести их в отдельную базу. " +
          "Подтвердить это можно командой вида: раздели еда"
      );
      res.status(200).json({ ok: true });
      return;
    }

    // Проверяем, не команда ли это на разделение базы
    const splitCategory = parseSplitCommand(userText);
    if (splitCategory) {
      await performSplit(splitCategory, chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Обычная запись
    const { date: defaultDate, time: defaultTime } = getMessageDateTime(message);

    // 1. Определяем категорию сообщения
    const category = await classifyCategory(userText);

    // 2. Ищем, есть ли уже отдельная база под эту категорию — если да, пишем туда
    const dedicatedDbId = await resolveDatabaseForCategory(category);
    const targetDatabaseId = dedicatedDbId || NOTION_DATABASE_ID;

    // 3. Забираем схему + select-варианты + уже использованные названия
    // именно из той базы, куда будем писать
    const { schema, selectOptions } = await getNotionSchemaAndOptions(targetDatabaseId);
    const existingTitles = await getExistingTitles(targetDatabaseId);

    // 4. Просим Gemini разобрать сообщение
    const parsed = await parseWithGemini(userText, {
      schema,
      selectOptions,
      existingTitles,
      defaultDate,
      defaultTime,
      category,
    });

    // 5. Добавляем в базу недостающие поля
    const propsToAdd = [];
    const seen = new Set();

    for (const [name, field] of Object.entries(parsed.properties || {})) {
      if (!schema[name] && !seen.has(name)) {
        propsToAdd.push({ name, type: field.type });
        seen.add(name);
      }
    }
    for (const p of parsed.new_properties || []) {
      if (!schema[p.name] && !seen.has(p.name)) {
        propsToAdd.push(p);
        seen.add(p.name);
      }
    }
    if (propsToAdd.length > 0) {
      await addPropertiesToDatabase(propsToAdd, schema, targetDatabaseId);
    }

    // 6. Создаём запись
    await createNotionPage(parsed, targetDatabaseId);

    // 7. Отвечаем подтверждением
    const summary = buildConfirmationText(parsed, category);
    await sendTelegramMessage(chatId, summary);

    // 8. Если это главная база и категория разрослась — предлагаем разделение
    try {
      await maybeSuggestSplit(category, targetDatabaseId, chatId);
    } catch (e) {
      console.error("maybeSuggestSplit failed (не критично):", e);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ ok: false, error: String(err) });
  }
};

// ---------- Время сообщения ----------

function getMessageDateTime(message) {
  const d = new Date(message.date * 1000);
  const date = d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const time = d.toLocaleTimeString("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
  return { date, time };
}

// ---------- Команда на разделение ----------

function parseSplitCommand(text) {
  const m = text.match(
    /^(раздели|вынеси|перенеси|создай\s+(?:отдельную\s+)?базу\s+для)\s+(.+)/i
  );
  if (!m) return null;

  const raw = m[2].trim().toLowerCase();
  return (
    CATEGORIES.find(
      (c) => raw.includes(c.toLowerCase()) || c.toLowerCase().includes(raw)
    ) || null
  );
}

// ---------- Notion: чтение схемы / вариантов / названий ----------

async function getNotionSchemaAndOptions(databaseId) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
  });

  if (!resp.ok) {
    throw new Error(`Notion getSchema failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const schema = {};
  const selectOptions = {};

  for (const [name, prop] of Object.entries(data.properties)) {
    schema[name] = mapNotionTypeToSimple(prop.type);
    if (prop.type === "select" && prop.select && prop.select.options) {
      selectOptions[name] = prop.select.options.map((o) => o.name);
    }
  }

  return { schema, selectOptions };
}

function mapNotionTypeToSimple(notionType) {
  if (notionType === "rich_text" || notionType === "title") return "text";
  if (notionType === "number") return "number";
  if (notionType === "date") return "date";
  if (notionType === "select") return "select";
  return "text";
}

async function getExistingTitles(databaseId, limit = 50) {
  const resp = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: limit }),
    }
  );

  if (!resp.ok) {
    console.error("Notion query (titles) failed:", resp.status, await resp.text());
    return [];
  }

  const data = await resp.json();
  const titles = new Set();

  for (const page of data.results || []) {
    const nameProp = page.properties && page.properties.Name;
    if (nameProp && nameProp.title) {
      const text = nameProp.title.map((t) => t.plain_text).join("").trim();
      if (text) titles.add(text);
    }
  }

  return Array.from(titles);
}

// ---------- Notion: изменение схемы ----------

async function addPropertiesToDatabase(newProperties, existingSchema, databaseId) {
  const propertiesPatch = {};

  for (const prop of newProperties) {
    if (existingSchema[prop.name]) continue;
    if (!ALLOWED_TYPES.includes(prop.type)) continue;
    propertiesPatch[prop.name] = buildNotionPropertySchema(prop.type);
  }

  if (Object.keys(propertiesPatch).length === 0) return;

  const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: propertiesPatch }),
  });

  if (!resp.ok) {
    throw new Error(`Notion addProperties failed: ${resp.status} ${await resp.text()}`);
  }
}

function buildNotionPropertySchema(type, options) {
  switch (type) {
    case "number":
      return { number: { format: "number" } };
    case "date":
      return { date: {} };
    case "select":
      return { select: options ? { options: options.map((o) => ({ name: o })) } : {} };
    case "text":
    default:
      return { rich_text: {} };
  }
}

// ---------- Notion: запись ----------

async function createNotionPage(parsed, databaseId) {
  const properties = {
    Name: { title: [{ text: { content: parsed.title || "Запись" } }] },
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
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  });

  if (!resp.ok) {
    throw new Error(`Notion createPage failed: ${resp.status} ${await resp.text()}`);
  }

  return resp.json();
}

function buildNotionPropertyValue(type, value) {
  switch (type) {
    case "number":
      return { number: typeof value === "number" ? value : parseFloat(value) || null };
    case "date":
      return { date: value ? { start: value } : null };
    case "select":
      return { select: value ? { name: String(value) } : null };
    case "text":
    default:
      return { rich_text: [{ text: { content: String(value ?? "") } }] };
  }
}

// ---------- Разделение базы по категории ----------

async function resolveDatabaseForCategory(category) {
  if (!NOTION_PARENT_PAGE_ID) return null;

  const title = `Life Log — ${category}`;
  const resp = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: title,
      filter: { property: "object", value: "database" },
    }),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  const normalizedParent = NOTION_PARENT_PAGE_ID.replace(/-/g, "");

  for (const result of data.results || []) {
    const resultTitle = (result.title || []).map((t) => t.plain_text).join("");
    const parentId = result.parent && result.parent.page_id
      ? result.parent.page_id.replace(/-/g, "")
      : null;

    if (resultTitle === title && parentId === normalizedParent) {
      return result.id;
    }
  }

  return null;
}

async function countCategoryEntries(databaseId, category) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { property: "Категория", select: { equals: category } },
      page_size: 100,
    }),
  });

  if (!resp.ok) return 0;
  const data = await resp.json();
  return (data.results || []).length;
}

async function maybeSuggestSplit(category, targetDatabaseId, chatId) {
  // Предлагаем разделение только пока всё ещё пишем в главную базу
  if (targetDatabaseId !== NOTION_DATABASE_ID) return;
  if (!NOTION_PARENT_PAGE_ID) return; // без родительской страницы разделение невозможно

  const count = await countCategoryEntries(NOTION_DATABASE_ID, category);

  if (count === SPLIT_THRESHOLD) {
    await sendTelegramMessage(
      chatId,
      `📊 У тебя уже ${count} записей категории «${category}» в общей базе.\n` +
        `Хочешь, я вынесу их в отдельную Notion-базу? Просто напиши:\nраздели ${category.toLowerCase()}`
    );
  }
}

function extractSimpleValue(prop) {
  switch (prop.type) {
    case "title":
      return { type: "text", value: prop.title.map((t) => t.plain_text).join("") };
    case "rich_text":
      return { type: "text", value: prop.rich_text.map((t) => t.plain_text).join("") };
    case "number":
      return { type: "number", value: prop.number };
    case "date":
      return { type: "date", value: prop.date ? prop.date.start : null };
    case "select":
      return { type: "select", value: prop.select ? prop.select.name : null };
    default:
      return null;
  }
}

async function performSplit(category, chatId) {
  if (!NOTION_PARENT_PAGE_ID) {
    await sendTelegramMessage(
      chatId,
      "Не могу создать отдельную базу: не настроена переменная NOTION_PARENT_PAGE_ID."
    );
    return;
  }

  const existingDbId = await resolveDatabaseForCategory(category);
  if (existingDbId) {
    await sendTelegramMessage(
      chatId,
      `База для категории «${category}» уже существует, новые записи этой категории уже пишутся туда.`
    );
    return;
  }

  await sendTelegramMessage(chatId, `Ок, создаю отдельную базу для категории «${category}» и переношу записи...`);

  // 1. Копируем схему главной базы
  const { schema, selectOptions } = await getNotionSchemaAndOptions(NOTION_DATABASE_ID);

  const newDbProperties = { Name: { title: {} } };
  for (const [name, type] of Object.entries(schema)) {
    if (name === "Name") continue;
    newDbProperties[name] = buildNotionPropertySchema(type, selectOptions[name]);
  }

  const createDbResp = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: NOTION_PARENT_PAGE_ID },
      title: [{ type: "text", text: { content: `Life Log — ${category}` } }],
      properties: newDbProperties,
    }),
  });

  if (!createDbResp.ok) {
    const errText = await createDbResp.text();
    await sendTelegramMessage(chatId, `Не удалось создать новую базу: ${errText}`);
    return;
  }

  const newDb = await createDbResp.json();
  const newDbId = newDb.id;
  const newDbUrl = newDb.url;

  // 2. Забираем все записи этой категории из главной базы (с пагинацией)
  let allPages = [];
  let cursor = undefined;
  do {
    const queryResp = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: { property: "Категория", select: { equals: category } },
          start_cursor: cursor,
          page_size: 100,
        }),
      }
    );

    if (!queryResp.ok) break;
    const queryData = await queryResp.json();
    allPages = allPages.concat(queryData.results || []);
    cursor = queryData.has_more ? queryData.next_cursor : undefined;
  } while (cursor);

  // 3. Переносим каждую запись: создаём в новой базе, архивируем в старой
  let moved = 0;
  for (const page of allPages) {
    const properties = {};
    let title = "Запись";

    for (const [name, prop] of Object.entries(page.properties)) {
      const simple = extractSimpleValue(prop);
      if (!simple) continue;
      if (name === "Name") {
        title = simple.value || "Запись";
      } else {
        properties[name] = simple;
      }
    }

    try {
      await createNotionPage({ title, properties }, newDbId);

      await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ archived: true }),
      });

      moved++;
    } catch (e) {
      console.error("Ошибка переноса записи:", e);
    }
  }

  await sendTelegramMessage(
    chatId,
    `✅ Готово! Перенёс ${moved} записей категории «${category}» в новую базу.\n${newDbUrl}`
  );
}

// ---------- Gemini ----------

async function generateGeminiJSON(prompt) {
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

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Не удалось распарсить ответ Gemini как JSON: ${cleaned}`);
  }
}

async function classifyCategory(userText) {
  const prompt = `Определи категорию сообщения пользователя. Выбери РОВНО ОДИН вариант из списка: ${CATEGORIES.join(", ")}.
Верни ТОЛЬКО валидный JSON без markdown, вида: {"category": "..."}

Сообщение: "${userText}"`;

  const result = await generateGeminiJSON(prompt);
  return CATEGORIES.includes(result.category) ? result.category : "Другое";
}

async function parseWithGemini(userText, ctx) {
  const { schema, selectOptions, existingTitles, defaultDate, defaultTime, category } = ctx;

  const schemaDescription =
    Object.entries(schema)
      .filter(([name]) => name !== "Name")
      .map(([name, type]) => {
        if (type === "select" && selectOptions[name] && selectOptions[name].length > 0) {
          return `- ${name} (select, существующие варианты: ${selectOptions[name].join(", ")})`;
        }
        return `- ${name} (${type})`;
      })
      .join("\n") || "(пока пусто, полей ещё нет)";

  const titlesDescription =
    existingTitles.length > 0 ? existingTitles.map((t) => `"${t}"`).join(", ") : "(записей ещё нет)";

  const prompt = `Ты — ассистент, который раскладывает свободный текст пользователя по полям базы данных для личного трекера.

Сообщение отправлено: ${defaultDate}, время отправки: ${defaultTime} (часовой пояс Asia/Jerusalem).
Категория этого сообщения уже определена: "${category}".

Уже существующие поля в базе:
${schemaDescription}

Уже использованные названия записей (поле Name): ${titlesDescription}

ПРАВИЛА:

1. Поле "Дата" (тип date) — всегда равно дате отправки сообщения (${defaultDate}), ЕСЛИ пользователь явно не указал другую дату словами.

2. Поле "Время" (тип text, формат HH:MM) — по умолчанию равно времени отправки сообщения (${defaultTime}). Меняй его ТОЛЬКО если пользователь явно и конкретно привязал время к событию (например "в 17:00 поел гамбургер"). Голое число без явной привязки к моменту события — это НЕ время, а длительность или другая метрика (используй отдельное поле вроде "Длительность"), а "Время" оставь равным времени отправки сообщения.

3. Поле "Категория" (тип select, значение всегда "${category}") — включай его в properties как обычное поле.

4. Поле "title" — короткое, конкретное, БЕЗ ЦИФР (например: "планка", "завтрак", "велосипед", "тренировка ног"). Если в списке уже использованных названий есть подходящее по смыслу — используй ЕГО ТОЧНОЕ НАПИСАНИЕ. Только для принципиально новой активности придумывай новое короткое название в том же стиле.

5. Для повторяющихся категориальных признаков (тип упражнения, вид активности, тип приёма пищи и т.п.) — используй тип "select", а не "text". Если подходящий вариант уже существует в списке выше — используй его точное написание.

6. Числовые метрики — тип "number". Разрешённые типы: "text", "number", "date", "select".

7. Верни ТОЛЬКО валидный JSON, без markdown, строго в такой структуре:

{
  "title": "короткое название без цифр",
  "properties": {
    "Дата": { "type": "date", "value": "YYYY-MM-DD" },
    "Время": { "type": "text", "value": "HH:MM" },
    "Категория": { "type": "select", "value": "${category}" }
  },
  "new_properties": [
    { "name": "Название нового поля", "type": "text|number|date|select" }
  ]
}

Сообщение пользователя: "${userText}"`;

  return generateGeminiJSON(prompt);
}

// ---------- Telegram ----------

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function buildConfirmationText(parsed, category) {
  const lines = [`✅ Сохранил: ${parsed.title || "запись"} (${category})`];

  for (const [name, field] of Object.entries(parsed.properties || {})) {
    if (name === "Категория") continue;
    lines.push(`• ${name}: ${field.value}`);
  }

  if (parsed.new_properties && parsed.new_properties.length > 0) {
    const names = parsed.new_properties.map((p) => p.name).join(", ");
    lines.push(`\n➕ Добавил новые поля в базу: ${names}`);
  }

  return lines.join("\n");
}
