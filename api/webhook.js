// api/webhook.js
//
// Telegram-бот: принимает свободный текст. Для каждой темы (категории)
// сообщений заводится отдельная Notion-база. Если сообщение относится к уже
// существующей категории — бот сам находит нужную базу и сохраняет запись.
// Если это новая тема — бот предлагает название категории и список полей,
// ждёт подтверждения (или правки) следующим сообщением, и только после
// подтверждения создаёт базу и сохраняет запись.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // старая общая база (архив/для ручного разделения)
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;
const TIMEZONE = "Asia/Jerusalem";
const NOTION_VERSION = "2022-06-28";

const ALLOWED_TYPES = ["text", "number", "date", "select"];

const CONFIRM_RE = /^(да|ок|окей|хорошо|подтверждаю|создавай|го|давай|конечно|yes|confirm)\b/i;
const CANCEL_RE = /^(нет|отмена|cancel|не надо|не нужно)\b/i;

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
        "Привет! Пиши мне свободным текстом, что сделал.\n\n" +
          "Если тема новая — я предложу, какую базу и поля под неё завести, и подожду твоего подтверждения.\n" +
          "Если тема уже знакомая — сразу сохраню запись в нужную базу.\n\n" +
          "Ещё есть ручная команда: «раздели <категория>» — перенесёт записи с таким значением поля «Категория» из старой общей базы в отдельную."
      );
      res.status(200).json({ ok: true });
      return;
    }

    // Команда на разделение старой общей базы (ручной сценарий, категория — любой текст)
    const splitCategory = parseSplitCommand(userText);
    if (splitCategory) {
      await performSplit(splitCategory, chatId);
      res.status(200).json({ ok: true });
      return;
    }

    const { date: defaultDate, time: defaultTime } = getMessageDateTime(message);

    // Есть ли незавершённое предложение по новой категории для этого чата?
    const pending = await getPendingProposal(chatId);

    if (pending) {
      await handlePendingResponse(pending, userText, chatId, defaultDate, defaultTime);
      res.status(200).json({ ok: true });
      return;
    }

    // Обычный поток: определяем, существующая это категория или новая
    const existingCategories = await listCategoryDatabases();
    const classification = await classifyOrProposeCategory(userText, existingCategories);

    if (classification.existing_category) {
      const match = existingCategories.find((c) => c.category === classification.existing_category);
      if (match) {
        await logAndSaveEntry(userText, match.category, match.databaseId, defaultDate, defaultTime, chatId);
        res.status(200).json({ ok: true });
        return;
      }
      // Модель сослалась на категорию, которой на самом деле нет в списке — считаем новой
    }

    // Новая категория — предлагаем структуру и ждём подтверждения
    const category = classification.new_category || classification.existing_category || "Другое";
    const fields = classification.fields || [];

    await setPendingProposal(chatId, category, fields, userText);
    await sendTelegramMessage(chatId, buildProposalText(category, fields));

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ ok: false, error: String(err) });
  }
};

// ---------- Обработка ответа на предложение новой категории ----------

async function handlePendingResponse(pending, userText, chatId, defaultDate, defaultTime) {
  if (CONFIRM_RE.test(userText)) {
    const databaseId = await createCategoryDatabase(pending.category, pending.fields);
    await clearPendingProposal(chatId);
    await sendTelegramMessage(chatId, `✅ Создал базу «${pending.category}». Сохраняю запись...`);
    await logAndSaveEntry(pending.originalText, pending.category, databaseId, defaultDate, defaultTime, chatId);
    return;
  }

  if (CANCEL_RE.test(userText)) {
    await clearPendingProposal(chatId);
    await sendTelegramMessage(chatId, "Ок, не создаю. Напиши сообщение заново, если передумаешь.");
    return;
  }

  // Считаем это правкой предложенной структуры
  const revised = await reviseProposal(pending.category, pending.fields, userText);
  await setPendingProposal(chatId, revised.category, revised.fields, pending.originalText);
  await sendTelegramMessage(chatId, buildProposalText(revised.category, revised.fields, true));
}

function buildProposalText(category, fields, isRevision) {
  const lines = [
    isRevision
      ? `Обновил предложение. Новая категория: «${category}»`
      : `У тебя ещё нет базы для темы «${category}». Предлагаю такие доп. поля:`,
  ];

  if (fields.length === 0) {
    lines.push("(доп. полей не требуется — только стандартные)");
  } else {
    for (const f of fields) {
      lines.push(`• ${f.name} (${f.type})`);
    }
  }

  lines.push("(Дата, Время и Категория добавятся автоматически)");
  lines.push('\nВсё верно? Напиши "да" чтобы создать, или опиши, что поправить.');

  return lines.join("\n");
}

// ---------- Логирование обычной записи в конкретную базу ----------

async function logAndSaveEntry(userText, category, targetDatabaseId, defaultDate, defaultTime, chatId) {
  const { schema, selectOptions } = await getNotionSchemaAndOptions(targetDatabaseId);
  const existingTitles = await getExistingTitles(targetDatabaseId);

  const parsed = await parseWithGemini(userText, {
    schema,
    selectOptions,
    existingTitles,
    defaultDate,
    defaultTime,
    category,
  });

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

  await createNotionPage(parsed, targetDatabaseId);

  const summary = buildConfirmationText(parsed, category);
  await sendTelegramMessage(chatId, summary);
}

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

// ---------- Список существующих категорий-баз ----------

async function listChildDatabases() {
  if (!NOTION_PARENT_PAGE_ID) return [];

  const results = [];
  let cursor = undefined;

  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${NOTION_PARENT_PAGE_ID}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
      },
    });

    if (!resp.ok) {
      console.error("Notion listChildren failed:", resp.status, await resp.text());
      break;
    }

    const data = await resp.json();
    for (const block of data.results || []) {
      if (block.type === "child_database") {
        results.push({ id: block.id, title: block.child_database.title || "" });
      }
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function listCategoryDatabases() {
  const children = await listChildDatabases();
  return children
    .filter((db) => db.title.startsWith("Life Log — "))
    .map((db) => ({ category: db.title.replace("Life Log — ", ""), databaseId: db.id }));
}

async function resolveDatabaseForCategory(category) {
  const all = await listCategoryDatabases();
  const match = all.find((c) => c.category === category);
  return match ? match.databaseId : null;
}

// ---------- Notion: схема / варианты / названия ----------

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
  const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: limit }),
  });

  if (!resp.ok) return [];

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

// ---------- Notion: создание новой базы под категорию ----------

async function createCategoryDatabase(category, extraFields) {
  const properties = {
    Name: { title: {} },
    Дата: buildNotionPropertySchema("date"),
    Время: buildNotionPropertySchema("text"),
    Категория: buildNotionPropertySchema("select", [category]),
  };

  for (const f of extraFields || []) {
    if (!ALLOWED_TYPES.includes(f.type)) continue;
    if (properties[f.name]) continue;
    properties[f.name] = buildNotionPropertySchema(f.type);
  }

  const resp = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: NOTION_PARENT_PAGE_ID },
      title: [{ type: "text", text: { content: `Life Log — ${category}` } }],
      properties,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Notion createCategoryDatabase failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  return data.id;
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

// ---------- Ручное разделение старой общей базы ----------

function parseSplitCommand(text) {
  const m = text.match(/^(раздели|вынеси|перенеси)\s+(.+)/i);
  if (!m) return null;
  return m[2].trim();
}

async function performSplit(category, chatId) {
  if (!NOTION_PARENT_PAGE_ID || !NOTION_DATABASE_ID) {
    await sendTelegramMessage(chatId, "Не настроены NOTION_PARENT_PAGE_ID / NOTION_DATABASE_ID.");
    return;
  }

  const existingDbId = await resolveDatabaseForCategory(category);
  if (existingDbId) {
    await sendTelegramMessage(chatId, `База для «${category}» уже есть, новые записи и так пишутся туда.`);
    return;
  }

  await sendTelegramMessage(chatId, `Ищу записи «${category}» в старой базе и переношу...`);

  const { schema, selectOptions } = await getNotionSchemaAndOptions(NOTION_DATABASE_ID);
  const extraFields = Object.entries(schema)
    .filter(([name]) => !["Name", "Дата", "Время", "Категория"].includes(name))
    .map(([name, type]) => ({ name, type }));

  const newDbId = await createCategoryDatabase(category, extraFields.length > 0 ? extraFields : []);

  let allPages = [];
  let cursor = undefined;
  do {
    const queryResp = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
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
    });

    if (!queryResp.ok) break;
    const queryData = await queryResp.json();
    allPages = allPages.concat(queryData.results || []);
    cursor = queryData.has_more ? queryData.next_cursor : undefined;
  } while (cursor);

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

  await sendTelegramMessage(chatId, `✅ Перенёс ${moved} записей категории «${category}» в новую базу.`);
}

// ---------- Bot State (хранение незавершённых предложений) ----------

async function getOrCreateBotStateDb() {
  const children = await listChildDatabases();
  const existing = children.find((db) => db.title === "Bot State");
  if (existing) return existing.id;

  const createResp = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: NOTION_PARENT_PAGE_ID },
      title: [{ type: "text", text: { content: "Bot State" } }],
      properties: {
        Name: { title: {} },
        Category: { rich_text: {} },
        FieldsJson: { rich_text: {} },
        OriginalText: { rich_text: {} },
      },
    }),
  });

  if (!createResp.ok) {
    throw new Error(`Notion createBotStateDb failed: ${createResp.status} ${await createResp.text()}`);
  }

  const created = await createResp.json();
  return created.id;
}

async function getPendingProposal(chatId) {
  const dbId = await getOrCreateBotStateDb();

  const resp = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { property: "Name", title: { equals: String(chatId) } },
      page_size: 1,
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const page = (data.results || [])[0];
  if (!page) return null;

  const category = (page.properties.Category.rich_text || []).map((t) => t.plain_text).join("");
  const fieldsJson = (page.properties.FieldsJson.rich_text || []).map((t) => t.plain_text).join("");
  const originalText = (page.properties.OriginalText.rich_text || []).map((t) => t.plain_text).join("");

  let fields = [];
  try {
    fields = JSON.parse(fieldsJson);
  } catch (e) {
    fields = [];
  }

  return { pageId: page.id, category, fields, originalText };
}

async function setPendingProposal(chatId, category, fields, originalText) {
  const dbId = await getOrCreateBotStateDb();
  const existing = await getPendingProposal(chatId);

  const properties = {
    Name: { title: [{ text: { content: String(chatId) } }] },
    Category: { rich_text: [{ text: { content: category } }] },
    FieldsJson: { rich_text: [{ text: { content: JSON.stringify(fields).slice(0, 1900) } }] },
    OriginalText: { rich_text: [{ text: { content: originalText.slice(0, 1900) } }] },
  };

  if (existing) {
    await fetch(`https://api.notion.com/v1/pages/${existing.pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });
  } else {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parent: { database_id: dbId }, properties }),
    });
  }
}

async function clearPendingProposal(chatId) {
  const existing = await getPendingProposal(chatId);
  if (!existing) return;

  await fetch(`https://api.notion.com/v1/pages/${existing.pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ archived: true }),
  });
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

async function classifyOrProposeCategory(userText, existingCategories) {
  const categoryNames = existingCategories.map((c) => c.category);
  const listText = categoryNames.length > 0 ? categoryNames.join(", ") : "(пока нет ни одной)";

  const prompt = `У пользователя уже есть отдельные базы под такие категории: ${listText}.

Проанализируй сообщение пользователя и реши:
1. Если оно явно относится к одной из существующих категорий — верни {"existing_category": "<точное имя из списка>"}.
2. Если это новый тип записи, для которого пока нет подходящей категории — предложи короткое название категории (без цифр, в том же стиле, что и существующие) и список ДОПОЛНИТЕЛЬНЫХ полей, которые пригодятся для будущих записей такого рода (НЕ включай Дата/Время/Категория — они добавляются всегда автоматически). Верни {"new_category": "...", "fields": [{"name":"...","type":"text|number|date|select"}]}.

Разрешённые типы полей: text, number, date, select.
Верни ТОЛЬКО валидный JSON, без markdown, без пояснений.

Сообщение пользователя: "${userText}"`;

  return generateGeminiJSON(prompt);
}

async function reviseProposal(category, fields, correctionText) {
  const prompt = `Ранее было предложено создать категорию "${category}" с полями:
${JSON.stringify(fields)}

Пользователь прислал правку: "${correctionText}"

Учти эту правку (это может быть изменение названия категории, добавление/удаление/переименование полей, смена типа поля). Верни ТОЛЬКО валидный JSON, без markdown, в структуре:
{"category": "...", "fields": [{"name":"...","type":"text|number|date|select"}]}`;

  return generateGeminiJSON(prompt);
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
Категория этого сообщения: "${category}".

Уже существующие поля в базе:
${schemaDescription}

Уже использованные названия записей (поле Name): ${titlesDescription}

ПРАВИЛА:
1. "Дата" (date) — всегда дата отправки (${defaultDate}), если пользователь явно не указал другую.
2. "Время" (text, HH:MM) — по умолчанию время отправки (${defaultTime}). Меняй только при явной привязке времени к событию. Голое число без привязки — это длительность или другая метрика, не время.
3. "Категория" (select, значение всегда "${category}") — включай как обычное поле.
4. "title" — короткое, без цифр. Если в списке названий есть подходящее — используй его точное написание.
5. Для повторяющихся категориальных признаков используй select, переиспользуя существующие варианты дословно.
6. Числовые метрики — number. Разрешённые типы: text, number, date, select.
7. Верни ТОЛЬКО валидный JSON:

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
