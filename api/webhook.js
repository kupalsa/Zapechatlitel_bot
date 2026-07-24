// api/webhook.js
//
// Telegram bot: accepts free-form text. Each topic (category) gets its own
// Notion database. If a message belongs to an existing category, the bot finds
// the right database and saves the entry. If it's a new topic, the bot proposes
// a category name and field list, waits for confirmation (or corrections), and
// only then creates the database and saves the entry.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // legacy shared database
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;
const TIMEZONE = "Asia/Jerusalem";
const NOTION_VERSION = "2022-06-28";

const ALLOWED_TYPES = ["text", "number", "date", "select"];

// Core fields every category database gets automatically.
const CORE_FIELDS = ["Name", "Logged Date", "Logged Time", "Event Date", "Event Time", "Category", "Type", "Note"];

// NOTE: no \b here — in JS word boundaries are ASCII-based, so they fail after
// Cyrillic words. Confirmation must be the whole message, so that
// "yes, but add a field" is treated as a correction instead.
const CONFIRM_RE = /^\s*(yes|yep|yeah|ok|okay|sure|confirm|correct|create|go|да|ага|ок|окей|хорошо|создавай)\s*[!.]*\s*$/i;
const CANCEL_RE = /^\s*(no|nope|cancel|stop|нет|отмена|стоп)\s*[!.]*\s*$/i;

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
        "Hi! Just write freely about what you did.\n\n" +
          "If the topic is new, I'll propose a database and fields for it and wait for your confirmation.\n" +
          "If the topic already exists, I'll save the entry right away.\n\n" +
          "Manual command: \"split <category>\" — moves entries with that Category value out of the legacy shared database into a dedicated one."
      );
      res.status(200).json({ ok: true });
      return;
    }

    const splitCategory = parseSplitCommand(userText);
    if (splitCategory) {
      await performSplit(splitCategory, chatId);
      res.status(200).json({ ok: true });
      return;
    }

    const { date: loggedDate, time: loggedTime } = getMessageDateTime(message);

    const pending = await getPendingProposal(chatId);
    if (pending) {
      await handlePendingResponse(pending, userText, chatId, loggedDate, loggedTime);
      res.status(200).json({ ok: true });
      return;
    }

    const existingCategories = await listCategoryDatabases();
    const classification = await classifyOrProposeCategory(userText, existingCategories);

    if (classification.existing_category) {
      const match = existingCategories.find((c) => c.category === classification.existing_category);
      if (match) {
        await saveEntry(userText, match.category, match.databaseId, loggedDate, loggedTime, chatId);
        res.status(200).json({ ok: true });
        return;
      }
    }

    const category = classification.new_category || classification.existing_category || "Other";
    const fields = classification.fields || [];

    await setPendingProposal(chatId, category, fields, userText);
    await sendTelegramMessage(chatId, buildProposalText(category, fields));

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).json({ ok: false, error: String(err) });
  }
};

// ---------- Pending proposal flow ----------

async function handlePendingResponse(pending, userText, chatId, loggedDate, loggedTime) {
  if (CONFIRM_RE.test(userText)) {
    const databaseId = await createCategoryDatabase(pending.category, pending.fields);
    await clearPendingProposal(chatId);
    await sendTelegramMessage(chatId, `✅ Created database "${pending.category}". Saving the entry...`);
    await saveEntry(pending.originalText, pending.category, databaseId, loggedDate, loggedTime, chatId);
    return;
  }

  if (CANCEL_RE.test(userText)) {
    await clearPendingProposal(chatId);
    await sendTelegramMessage(chatId, "Okay, not creating it. Send the message again whenever you want.");
    return;
  }

  const revised = await reviseProposal(pending.category, pending.fields, userText);
  await setPendingProposal(chatId, revised.category, revised.fields, pending.originalText);
  await sendTelegramMessage(chatId, buildProposalText(revised.category, revised.fields, true));
}

function buildProposalText(category, fields, isRevision) {
  const lines = [
    isRevision
      ? `Updated proposal. Category: "${category}"`
      : `You don't have a database for "${category}" yet. Suggested extra fields:`,
  ];

  if (!fields || fields.length === 0) {
    lines.push("(no extra fields needed — core fields only)");
  } else {
    for (const f of fields) {
      lines.push(`• ${f.name} (${f.type})`);
    }
  }

  lines.push("(Logged Date/Time, Event Date/Time, Category, Type and Note are added automatically)");
  lines.push('\nLooks right? Reply "yes" to create it, or tell me what to change.');

  return lines.join("\n");
}

// ---------- Saving an entry ----------

async function saveEntry(userText, category, targetDatabaseId, loggedDate, loggedTime, chatId) {
  const { schema, selectOptions } = await getNotionSchemaAndOptions(targetDatabaseId);
  const existingTypes = selectOptions["Type"] || [];

  const parsed = await parseWithGemini(userText, {
    schema,
    selectOptions,
    existingTypes,
    loggedDate,
    loggedTime,
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

  // Name is always the raw message, so the original wording is never lost.
  parsed.title = userText;

  await createNotionPage(parsed, targetDatabaseId);
  await sendTelegramMessage(chatId, buildConfirmationText(parsed, category));
}

// ---------- Message timestamp ----------

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

// ---------- Listing child databases (immediate, unlike search API) ----------

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

// ---------- Notion: schema ----------

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

// ---------- Notion: create category database ----------

async function createCategoryDatabase(category, extraFields) {
  const properties = {
    Name: { title: {} },
    "Logged Date": buildNotionPropertySchema("date"),
    "Logged Time": buildNotionPropertySchema("text"),
    "Event Date": buildNotionPropertySchema("date"),
    "Event Time": buildNotionPropertySchema("text"),
    Category: buildNotionPropertySchema("select", [category]),
    Type: buildNotionPropertySchema("select"),
    Note: buildNotionPropertySchema("text"),
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

// ---------- Notion: pages ----------

async function createNotionPage(parsed, databaseId) {
  const properties = {
    Name: { title: [{ text: { content: (parsed.title || "Entry").slice(0, 1900) } }] },
  };

  for (const [name, field] of Object.entries(parsed.properties || {})) {
    if (!ALLOWED_TYPES.includes(field.type)) continue;
    if (field.value === null || field.value === undefined || field.value === "") continue;
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
      return { date: { start: value } };
    case "select":
      return { select: { name: String(value).slice(0, 90) } };
    case "text":
    default:
      return { rich_text: [{ text: { content: String(value).slice(0, 1900) } }] };
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

// ---------- Manual split of the legacy shared database ----------

function parseSplitCommand(text) {
  const m = text.match(/^(split|move|раздели|вынеси|перенеси)\s+(.+)/i);
  if (!m) return null;
  return m[2].trim();
}

async function performSplit(category, chatId) {
  if (!NOTION_PARENT_PAGE_ID || !NOTION_DATABASE_ID) {
    await sendTelegramMessage(chatId, "NOTION_PARENT_PAGE_ID / NOTION_DATABASE_ID are not configured.");
    return;
  }

  const existingDbId = await resolveDatabaseForCategory(category);
  if (existingDbId) {
    await sendTelegramMessage(chatId, `A database for "${category}" already exists — new entries go there already.`);
    return;
  }

  await sendTelegramMessage(chatId, `Looking for "${category}" entries in the legacy database and moving them...`);

  const { schema } = await getNotionSchemaAndOptions(NOTION_DATABASE_ID);
  const extraFields = Object.entries(schema)
    .filter(([name]) => !CORE_FIELDS.includes(name))
    .map(([name, type]) => ({ name, type }));

  const newDbId = await createCategoryDatabase(category, extraFields);

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
        filter: { property: "Category", select: { equals: category } },
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
    let title = "Entry";

    for (const [name, prop] of Object.entries(page.properties)) {
      const simple = extractSimpleValue(prop);
      if (!simple) continue;
      if (name === "Name") {
        title = simple.value || "Entry";
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
      console.error("Failed to move entry:", e);
    }
  }

  await sendTelegramMessage(chatId, `✅ Moved ${moved} "${category}" entries into the new database.`);
}

// ---------- Bot State (pending proposals) ----------

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

  const readText = (prop) => (prop && prop.rich_text ? prop.rich_text.map((t) => t.plain_text).join("") : "");

  const category = readText(page.properties.Category);
  const fieldsJson = readText(page.properties.FieldsJson);
  const originalText = readText(page.properties.OriginalText);

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
    throw new Error(`Failed to parse Gemini response as JSON: ${cleaned}`);
  }
}

async function classifyOrProposeCategory(userText, existingCategories) {
  const categoryNames = existingCategories.map((c) => c.category);
  const listText = categoryNames.length > 0 ? categoryNames.join(", ") : "(none yet)";

  const prompt = `The user already has separate databases for these categories: ${listText}.

Analyse the user's message and decide:
1. If it clearly belongs to one of the existing categories, return {"existing_category": "<exact name from the list>"}.
2. If it's a new kind of entry with no suitable category yet, propose a short English category name (no digits, same style as the existing ones) plus a list of ADDITIONAL fields useful for future entries of this kind. Do NOT include Logged Date, Logged Time, Event Date, Event Time, Category, Type or Note — those are always added automatically. Return {"new_category": "...", "fields": [{"name":"...","type":"text|number|date|select"}]}.

All field names must be in English. Allowed types: text, number, date, select.
Return ONLY valid JSON, no markdown, no explanations.

User message: "${userText}"`;

  return generateGeminiJSON(prompt);
}

async function reviseProposal(category, fields, correctionText) {
  const prompt = `A proposal was made to create category "${category}" with these fields:
${JSON.stringify(fields)}

The user replied with a correction: "${correctionText}"

Apply that correction (it may rename the category, add/remove/rename fields, or change field types). All names must be in English. Return ONLY valid JSON, no markdown:
{"category": "...", "fields": [{"name":"...","type":"text|number|date|select"}]}`;

  return generateGeminiJSON(prompt);
}

async function parseWithGemini(userText, ctx) {
  const { schema, selectOptions, existingTypes, loggedDate, loggedTime, category } = ctx;

  const schemaDescription =
    Object.entries(schema)
      .filter(([name]) => name !== "Name")
      .map(([name, type]) => {
        if (type === "select" && selectOptions[name] && selectOptions[name].length > 0) {
          return `- ${name} (select, existing options: ${selectOptions[name].join(", ")})`;
        }
        return `- ${name} (${type})`;
      })
      .join("\n") || "(empty, no fields yet)";

  const typesDescription = existingTypes.length > 0 ? existingTypes.join(", ") : "(none yet)";

  const prompt = `You extract structured data from a user's free-form personal-tracking message.

Message was sent on ${loggedDate} at ${loggedTime} (timezone Asia/Jerusalem).
Category of this message: "${category}".

Existing fields in the database:
${schemaDescription}

Existing options of the "Type" field: ${typesDescription}

RULES:

1. "Logged Date" (date) = ${loggedDate} and "Logged Time" (text, HH:MM) = ${loggedTime}. ALWAYS these exact values — they record when the message was sent and must never be inferred from the text.

2. "Event Date" (date) and "Event Time" (text, HH:MM) = when the thing actually happened. Default them to ${loggedDate} and ${loggedTime}. Override ONLY on an explicit signal in the text: a stated date ("yesterday", "on July 3rd", "last Monday") or a time explicitly tied to the event ("ate at 17:00", "log this at 9am"). A bare number or duration-looking value ("plank 6 minutes", "7:50") is NOT an event time — treat it as a duration or other metric in its own field, and keep Event Time at the sent time.

3. "Type" (select) — a short concrete English label for the activity, NO DIGITS, usually one word or a short set phrase ("plank", "breakfast", "cycling", "leg workout", "groceries", "cafe"). This is the main grouping field, so if a suitable option already exists in the list above, reuse its EXACT spelling. Only invent a new option for a genuinely new kind of activity.

4. "Note" (text) — leave it OUT entirely in the normal case. Include it ONLY when something was genuinely ambiguous or you had to guess: an unclear number, an assumed unit or currency, a date inferred from vague wording, or information you couldn't place in any field. Keep it to one short English sentence explaining the ambiguity, so the user learns to phrase things more precisely. Never use it for generic remarks like "parsed successfully".

5. For other recurring categorical attributes use select as well, reusing existing options verbatim. Numeric metrics use number. Allowed types: text, number, date, select. All new field names must be in English.

6. Return ONLY valid JSON, no markdown:

{
  "properties": {
    "Logged Date": { "type": "date", "value": "${loggedDate}" },
    "Logged Time": { "type": "text", "value": "${loggedTime}" },
    "Event Date": { "type": "date", "value": "YYYY-MM-DD" },
    "Event Time": { "type": "text", "value": "HH:MM" },
    "Category": { "type": "select", "value": "${category}" },
    "Type": { "type": "select", "value": "short label without digits" }
  },
  "new_properties": [
    { "name": "New field name", "type": "text|number|date|select" }
  ]
}

User message: "${userText}"`;

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
  const props = parsed.properties || {};
  const typeValue = props["Type"] ? props["Type"].value : null;

  const lines = [typeValue ? `✅ Saved: ${typeValue} (${category})` : `✅ Saved to "${category}"`];

  for (const [name, field] of Object.entries(props)) {
    if (["Category", "Type", "Logged Date", "Logged Time", "Note"].includes(name)) continue;
    lines.push(`• ${name}: ${field.value}`);
  }

  if (props["Note"] && props["Note"].value) {
    lines.push(`\n⚠️ ${props["Note"].value}`);
  }

  if (parsed.new_properties && parsed.new_properties.length > 0) {
    const names = parsed.new_properties.map((p) => p.name).join(", ");
    lines.push(`\n➕ Added new fields: ${names}`);
  }

  return lines.join("\n");
}
