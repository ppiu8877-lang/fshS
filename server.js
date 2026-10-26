"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const products = require("./js/products.js");

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const databasePath = path.resolve(process.env.ORDERS_DB_PATH || path.join(root, "data", "orders.sqlite"));
const governorates = new Set(["العاصمة", "حولي", "الفروانية", "مبارك الكبير", "الأحمدي", "الجهراء"]);
const productsById = new Map(products.map((product) => [product.id, product]));
const legacyProducts = new Map();

for (const product of products) {
  const legacyId = `${product.category}|${product.brand}|${product.title}`;
  const candidates = legacyProducts.get(legacyId) || [];
  candidates.push(product);
  legacyProducts.set(legacyId, candidates);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    country TEXT NOT NULL,
    governorate TEXT NOT NULL,
    area TEXT NOT NULL,
    street TEXT NOT NULL,
    house_details TEXT NOT NULL,
    total_fils INTEGER NOT NULL CHECK (total_fils >= 0),
    telegram_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    title TEXT NOT NULL,
    brand TEXT NOT NULL,
    unit_price_fils INTEGER NOT NULL CHECK (unit_price_fils >= 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    line_total_fils INTEGER NOT NULL CHECK (line_total_fils >= 0)
  );
  CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
  CREATE TABLE IF NOT EXISTS payment_events (
    event_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount_fils INTEGER NOT NULL CHECK (amount_fils >= 0),
    payment_method TEXT NOT NULL,
    card_last4 TEXT,
    telegram_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS payment_events_order_id_idx ON payment_events(order_id);
  CREATE TABLE IF NOT EXISTS visitors (
    visitor_id TEXT PRIMARY KEY,
    visitor_name TEXT NOT NULL,
    country TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    visit_count INTEGER NOT NULL CHECK (visit_count > 0)
  );
`);

function ensureOrdersColumn(name, definition) {
  const columns = database.prepare("PRAGMA table_info(orders)").all();
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
  }
}

ensureOrdersColumn("payment_status", "TEXT NOT NULL DEFAULT 'unpaid'");
ensureOrdersColumn("paid_at", "TEXT");

const insertOrder = database.prepare(`
  INSERT INTO orders (
    id, first_name, last_name, phone, country, governorate, area, street,
    house_details, total_fils, telegram_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertOrderItem = database.prepare(`
  INSERT INTO order_items (
    order_id, product_id, title, brand, unit_price_fils, quantity, line_total_fils
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateTelegramStatus = database.prepare("UPDATE orders SET telegram_status = ? WHERE id = ?");
const selectOrderForPayment = database.prepare(`
  SELECT id, first_name, last_name, total_fils, payment_status
  FROM orders WHERE id = ?
`);
const selectPaymentEvent = database.prepare("SELECT * FROM payment_events WHERE event_id = ?");
const insertPaymentEvent = database.prepare(`
  INSERT INTO payment_events (event_id, order_id, amount_fils, payment_method, card_last4, telegram_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updatePaymentEventTelegramStatus = database.prepare(
  "UPDATE payment_events SET telegram_status = ? WHERE event_id = ?"
);
const markOrderPaid = database.prepare(
  "UPDATE orders SET payment_status = 'paid', paid_at = ? WHERE id = ?"
);
const selectVisitor = database.prepare("SELECT visitor_name, country, visit_count FROM visitors WHERE visitor_id = ?");
const insertVisitor = database.prepare(`
  INSERT INTO visitors (visitor_id, visitor_name, country, first_seen, last_seen, visit_count)
  VALUES (?, ?, ?, ?, ?, 1)
`);
const updateVisitor = database.prepare(`
  UPDATE visitors SET visitor_name = ?, country = ?, last_seen = ?, visit_count = visit_count + 1
  WHERE visitor_id = ?
`);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 32 * 1024) {
        tooLarge = true;
        reject(Object.assign(new Error("حجم بيانات الطلب أكبر من المسموح."), { statusCode: 413 }));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("صيغة بيانات الطلب غير صالحة."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") {
    throw Object.assign(new Error(`حقل ${field} مطلوب.`), { statusCode: 400 });
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw Object.assign(new Error(`تحقق من قيمة حقل ${field}.`), { statusCode: 400 });
  }
  return text;
}

function toFils(price) {
  const fils = Math.round((price + Number.EPSILON) * 1000);
  if (!Number.isSafeInteger(fils) || fils < 0) {
    throw Object.assign(new Error("سعر أحد المنتجات غير صالح."), { statusCode: 400 });
  }
  return fils;
}

function canonicalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw Object.assign(new Error("عدد المنتجات في الطلب غير صالح."), { statusCode: 400 });
  }

  let totalFils = 0;
  const canonicalItems = items.map((item) => {
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw Object.assign(new Error("كمية أحد المنتجات غير صالحة."), { statusCode: 400 });
    }

    let product = typeof item.id === "string" ? productsById.get(item.id) : undefined;
    if (!product && typeof item.id === "string") {
      const candidates = legacyProducts.get(item.id) || [];
      const suppliedPriceFils = Number.isFinite(item.price) && item.price >= 0 ? toFils(item.price) : null;
      product = candidates.find((candidate) => toFils(candidate.price) === suppliedPriceFils);
    }
    if (!product) {
      throw Object.assign(new Error("تعذر التحقق من أحد المنتجات. أعد إضافته إلى السلة."), { statusCode: 400 });
    }

    const unitPriceFils = toFils(product.price);
    const lineTotalFils = unitPriceFils * item.quantity;
    if (!Number.isSafeInteger(lineTotalFils)) {
      throw Object.assign(new Error("إجمالي أحد المنتجات أكبر من الحد المسموح."), { statusCode: 400 });
    }
    totalFils += lineTotalFils;
    if (!Number.isSafeInteger(totalFils)) {
      throw Object.assign(new Error("إجمالي الطلب أكبر من الحد المسموح."), { statusCode: 400 });
    }
    return {
      id: product.id,
      title: product.title,
      brand: product.brand,
      unitPriceFils,
      quantity: item.quantity,
      lineTotalFils,
    };
  });

  return { items: canonicalItems, totalFils };
}

function validateOrder(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("بيانات الطلب غير صالحة."), { statusCode: 400 });
  }

  const phone = requiredText(payload.phone, "رقم الجوال", 16)
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  if (!/^[0-9]{8}$/.test(phone)) {
    throw Object.assign(new Error("أدخل رقم جوال كويتيًا صحيحًا من 8 أرقام."), { statusCode: 400 });
  }
  if (payload.country !== "KW" || !governorates.has(payload.governorate)) {
    throw Object.assign(new Error("الدولة أو المحافظة غير صالحة."), { statusCode: 400 });
  }

  return {
    firstName: requiredText(payload.firstName, "الاسم الأول", 60),
    lastName: requiredText(payload.lastName, "اسم العائلة", 60),
    phone,
    country: "KW",
    governorate: payload.governorate,
    area: requiredText(payload.area, "المنطقة", 100),
    street: requiredText(payload.street, "الشارع", 120),
    houseDetails: requiredText(payload.houseDetails, "وصف المنزل", 300),
    ...canonicalizeItems(payload.items),
  };
}

function saveOrder(order, id, createdAt) {
  database.exec("BEGIN IMMEDIATE");
  try {
    insertOrder.run(
      id,
      order.firstName,
      order.lastName,
      order.phone,
      order.country,
      order.governorate,
      order.area,
      order.street,
      order.houseDetails,
      order.totalFils,
      "pending",
      createdAt,
    );
    for (const item of order.items) {
      insertOrderItem.run(
        id,
        item.id,
        item.title,
        item.brand,
        item.unitPriceFils,
        item.quantity,
        item.lineTotalFils,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

async function sendTelegram(order, id) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not_configured";
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) {
    throw new Error("Telegram configuration is invalid.");
  }

  const lines = [
    `<b>طلب جديد #${escapeHtml(id.slice(0, 8))}</b>`,
    `الاسم: ${escapeHtml(`${order.firstName} ${order.lastName}`)}`,
    `الهاتف: ${escapeHtml(order.phone)}`,
    `العنوان: ${escapeHtml(`${order.governorate}، ${order.area}، ${order.street}، ${order.houseDetails}`)}`,
    "",
    ...order.items.map((item) =>
      `${escapeHtml(item.title)} × ${item.quantity} — ${(item.lineTotalFils / 1000).toFixed(3)} د.ك`
    ),
    "",
    `الإجمالي: ${(order.totalFils / 1000).toFixed(3)} د.ك`,
  ];
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    throw new Error(`Telegram rejected the order notification (HTTP ${response.status}).`);
  }
  return "sent";
}

async function sendTelegramPaymentConfirmation(order, payment) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not_configured";

  const lines = [
    `<b>تم تأكيد الدفع للطلب #${escapeHtml(order.id.slice(0, 8))}</b>`,
    `العميل: ${escapeHtml(`${order.first_name} ${order.last_name}`)}`,
    `المبلغ: ${(order.total_fils / 1000).toFixed(3)} د.ك`,
    `طريقة الدفع: ${escapeHtml(payment.paymentMethod)}`,
  ];
  if (payment.cardLast4) lines.push(`البطاقة: **** ${payment.cardLast4}`);
  lines.push("لم يتم استلام أو حفظ رقم البطاقة الكامل أو CVV أو رمز التحقق.");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    throw new Error(`Telegram rejected the payment notification (HTTP ${response.status}).`);
  }
  return "sent";
}

function hasValidWebhookSecret(request) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET;
  const supplied = request.headers["x-payment-webhook-secret"];
  if (!expected || typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function validatePaymentEvent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("Invalid payment event."), { statusCode: 400 });
  }
  if (typeof payload.eventId !== "string" || !/^[A-Za-z0-9_-]{8,120}$/.test(payload.eventId)) {
    throw Object.assign(new Error("Invalid payment event ID."), { statusCode: 400 });
  }
  if (typeof payload.orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.orderId)) {
    throw Object.assign(new Error("Invalid order ID."), { statusCode: 400 });
  }
  if (payload.status !== "paid" || !Number.isSafeInteger(payload.amountFils) || payload.amountFils < 0) {
    throw Object.assign(new Error("The event must confirm a paid amount in fils."), { statusCode: 400 });
  }
  const paymentMethod = optionalText(payload.paymentMethod, "card", 40);
  const cardLast4 = typeof payload.cardLast4 === "string" && /^\d{4}$/.test(payload.cardLast4)
    ? payload.cardLast4
    : null;
  return { eventId: payload.eventId, orderId: payload.orderId, amountFils: payload.amountFils, paymentMethod, cardLast4 };
}

async function handlePaymentWebhook(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Unsupported method." });
    return;
  }
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "Payment events must be JSON." });
    return;
  }
  if (!process.env.PAYMENT_WEBHOOK_SECRET) {
    sendJson(response, 503, { error: "Payment webhook is not configured." });
    return;
  }
  if (!hasValidWebhookSecret(request)) {
    sendJson(response, 401, { error: "Unauthorized payment webhook." });
    return;
  }

  try {
    const payment = validatePaymentEvent(await readJson(request));
    const order = selectOrderForPayment.get(payment.orderId);
    if (!order) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
    if (order.total_fils !== payment.amountFils) {
      throw Object.assign(new Error("Paid amount does not match the order."), { statusCode: 400 });
    }

    let event = selectPaymentEvent.get(payment.eventId);
    if (event && (event.order_id !== payment.orderId || event.amount_fils !== payment.amountFils)) {
      throw Object.assign(new Error("Payment event conflicts with an existing payment."), { statusCode: 409 });
    }
    if (!event) {
      const createdAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        insertPaymentEvent.run(payment.eventId, payment.orderId, payment.amountFils, payment.paymentMethod, payment.cardLast4, "pending", createdAt);
        markOrderPaid.run(createdAt, payment.orderId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      event = selectPaymentEvent.get(payment.eventId);
    }

    if (event.telegram_status === "sent" || event.telegram_status === "not_configured") {
      sendJson(response, 200, { ok: true, duplicate: true, telegramStatus: event.telegram_status });
      return;
    }

    let telegramStatus;
    try {
      telegramStatus = await sendTelegramPaymentConfirmation(order, {
        paymentMethod: event.payment_method,
        cardLast4: event.card_last4,
      });
    } catch (error) {
      telegramStatus = "failed";
      console.error("Unable to send payment confirmation to Telegram", payment.eventId, error);
    }
    updatePaymentEventTelegramStatus.run(telegramStatus, payment.eventId);
    sendJson(response, 200, { ok: true, telegramStatus });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "Unable to process payment event." });
  }
}

async function sendTelegramVisitor(visitor, isNew) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not_configured";
  const label = isNew ? "زائر جديد" : "زائر سابق عاد للموقع";
  const lines = [
    `<b>${label}</b>`,
    `الاسم: ${escapeHtml(visitor.name)}`,
    `الدولة: ${escapeHtml(visitor.country)}`,
    `الصفحة: ${escapeHtml(visitor.page)}`,
    `عدد الزيارات: ${visitor.visitCount}`,
  ];
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    throw new Error(`Telegram rejected the visitor notification (HTTP ${response.status}).`);
  }
  return "sent";
}

async function sendTelegramCustomerInfo(customer) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not_configured";
  const lines = [
    "<b>بيانات عميل جديدة</b>",
    `الاسم: ${escapeHtml(`${customer.firstName} ${customer.lastName}`)}`,
    `رقم الهاتف: ${escapeHtml(customer.phone)}`,
    `الدولة: ${escapeHtml(customer.country)}`,
  ];
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(`Telegram rejected the customer notification (HTTP ${response.status}).`);
  return "sent";
}

async function sendTelegramPaymentChoice(customer) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not_configured";
  const lines = [
    "<b>صفحة اختيار طريقة الدفع</b>",
    `رقم الهاتف: ${escapeHtml(customer.phone)}`,
    `الاسم: ${escapeHtml(`${customer.firstName} ${customer.lastName}`)}`,
    `الدولة: ${escapeHtml(customer.country)}`,
    `حالة الزائر: ${escapeHtml(customer.visitorStatus)}`,
    `الصفحة: ${escapeHtml(customer.page)}`,
  ];
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(`Telegram rejected the payment-choice notification (HTTP ${response.status}).`);
  return "sent";
}

function optionalText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text && text.length <= maxLength ? text : fallback;
}

async function handleVisit(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "طريقة الزيارة غير مدعومة." });
    return;
  }
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "يجب إرسال بيانات الزيارة بصيغة JSON." });
    return;
  }
  try {
    const payload = await readJson(request);
    if (!payload || typeof payload.visitorId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(payload.visitorId)) {
      throw Object.assign(new Error("معرّف الزائر غير صالح."), { statusCode: 400 });
    }
    const now = new Date().toISOString();
    const name = optionalText(payload.name, "غير معروف", 80);
    const country = optionalText(payload.country, "غير معروف", 80);
    const page = optionalText(payload.page, "/", 160);
    const existing = selectVisitor.get(payload.visitorId);
    const isNew = !existing;
    const visitCount = isNew ? 1 : existing.visit_count + 1;
    if (isNew) {
      insertVisitor.run(payload.visitorId, name, country, now, now);
    } else {
      updateVisitor.run(name, country, now, payload.visitorId);
    }
    let telegramStatus = "not_configured";
    try {
      telegramStatus = await sendTelegramVisitor({ name, country, page, visitCount }, isNew);
    } catch (error) {
      telegramStatus = "failed";
      console.error("تعذر إرسال إشعار زيارة Telegram", error);
    }
    sendJson(response, 201, { ok: true, isNew, visitCount, telegramStatus });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "تعذر تسجيل الزيارة." });
  }
}

async function handleCustomerInfo(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Unsupported method." });
    return;
  }
  try {
    const payload = await readJson(request);
    const firstName = requiredText(payload.firstName, "firstName", 60);
    const lastName = requiredText(payload.lastName, "lastName", 60);
    const phone = requiredText(payload.phone, "phone", 16)
      .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
    if (!/^\d{8}$/.test(phone)) throw Object.assign(new Error("Phone must contain 8 digits."), { statusCode: 400 });
    const telegramStatus = await sendTelegramCustomerInfo({
      firstName,
      lastName,
      phone,
      country: optionalText(payload.country, "غير معروف", 80),
    });
    sendJson(response, 201, { ok: true, telegramStatus });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "Unable to send customer data." });
  }
}

async function handlePaymentChoice(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Unsupported method." });
    return;
  }
  try {
    const payload = await readJson(request);
    const firstName = requiredText(payload.firstName, "firstName", 60);
    const lastName = requiredText(payload.lastName, "lastName", 60);
    const phone = requiredText(payload.phone, "phone", 16)
      .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
    if (!/^\d{8}$/.test(phone)) throw Object.assign(new Error("Phone must contain 8 digits."), { statusCode: 400 });
    const telegramStatus = await sendTelegramPaymentChoice({
      firstName,
      lastName,
      phone,
      country: optionalText(payload.country, "غير معروف", 80),
      visitorStatus: optionalText(payload.visitorStatus, "غير معروف", 40),
      page: optionalText(payload.page, "/step3.html", 160),
    });
    sendJson(response, 201, { ok: true, telegramStatus });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "Unable to send payment-choice data." });
  }
}

function isAllowedStaticFile(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (/^[^/]+\.html$/i.test(normalized)) return true;
  if (/^js\/[^/]+\.js$/i.test(normalized)) return true;
  if (/^css\/[^/]+\.css$/i.test(normalized)) return true;
  if (/^(images|assets)\/.+$/i.test(normalized)) return true;
  return /^paymen_files\/[^/]+\.(?:css|js|png|jpe?g|webp|svg)$/i.test(normalized);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

async function handleOrder(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
    return;
  }
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { error: "يجب إرسال الطلب بصيغة JSON." });
    return;
  }

  try {
    const payload = await readJson(request);
    const order = validateOrder(payload);
    const id = require("node:crypto").randomUUID();
    const createdAt = new Date().toISOString();
    saveOrder(order, id, createdAt);

    let telegramStatus;
    try {
      telegramStatus = await sendTelegram(order, id);
    } catch (error) {
      telegramStatus = "failed";
      console.error("تعذر إرسال إشعار Telegram للطلب", id, error);
    }
    updateTelegramStatus.run(telegramStatus, id);

    sendJson(response, 201, {
      ok: true,
      orderId: id,
      telegramStatus,
      warning: telegramStatus === "sent"
        ? undefined
        : "تم حفظ الطلب، لكن لم يصل إشعار Telegram. يرجى التواصل مع المتجر للتأكد.",
    });
  } catch (error) {
    if (error.statusCode) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    console.error("تعذر حفظ الطلب:", error);
    sendJson(response, 500, { error: "تعذر حفظ الطلب بسبب خطأ في الخادم. حاول لاحقًا." });
  }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const requestPath = pathname === "/" ? "/1index.html" : pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const filePath = path.resolve(root, `.${decodedPath}`);
  const relativePath = path.relative(root, filePath);
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    !isAllowedStaticFile(relativePath)
  ) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const contents = await fs.promises.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": path.extname(filePath).toLowerCase() === ".html" ? "no-cache" : "public, max-age=3600",
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404).end("Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (requestUrl.pathname === "/api/orders") {
      await handleOrder(request, response);
      return;
    }
    if (requestUrl.pathname === "/api/payment-webhook") {
      await handlePaymentWebhook(request, response);
      return;
    }
    if (requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    await serveStatic(request, response, requestUrl.pathname);
  } catch (error) {
    console.error("خطأ غير متوقع في طلب HTTP:", error);
    if (!response.headersSent) sendJson(response, 500, { error: "حدث خطأ غير متوقع في الخادم." });
    else response.destroy();
  }
});

server.listen(port, () => {
  console.log(`Store server listening on port ${port}`);
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram notifications are disabled until TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are configured.");
  }
});

function close() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
