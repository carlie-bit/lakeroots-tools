const https = require("https");

// ── CONFIG ──────────────────────────────────────────────────
const DRY_RUN = process.env.GMAIL_PARSER_DRY_RUN === "true";

const GMAIL_SEARCH = "from:no-reply@toasttab.com subject:\"New Event lead:\" -label:Toast-Parsed";

const LABEL_PARSED = "Toast-Parsed";
const LABEL_FAILED = "Toast-Parse-Failed";

// ── HTTP HELPER ─────────────────────────────────────────────
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (_) { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function get(url, headers) {
  const u = new URL(url);
  return request(u, {
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: "GET",
    headers: headers || {},
  });
}

function post(url, headers, body) {
  const u = new URL(url);
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return request(u, {
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
      ...headers,
    },
  }, bodyStr);
}

function patch(url, headers, body) {
  const u = new URL(url);
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return request(u, {
    hostname: u.hostname,
    path: u.pathname + u.search,
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
      ...headers,
    },
  }, bodyStr);
}

// ── GMAIL AUTH ──────────────────────────────────────────────
async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }).toString();

  const u = new URL("https://oauth2.googleapis.com/token");
  const data = await request(u, {
    hostname: u.hostname,
    path: u.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  if (!data.access_token) throw new Error("No access_token in OAuth response");
  return data.access_token;
}

// ── GMAIL HELPERS ───────────────────────────────────────────
async function gmailGet(path, token) {
  return get(
    `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    { Authorization: `Bearer ${token}` }
  );
}

async function gmailPost(path, token, body) {
  return post(
    `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    { Authorization: `Bearer ${token}` },
    body
  );
}

async function ensureLabel(token, labelName) {
  const labelsRes = await gmailGet("labels", token);
  const existing = (labelsRes.labels || []).find(
    (l) => l.name === labelName
  );
  if (existing) return existing.id;

  const created = await gmailPost("labels", token, {
    name: labelName,
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  });
  return created.id;
}

async function labelThread(token, threadId, labelId) {
  return gmailPost(`threads/${threadId}/modify`, token, {
    addLabelIds: [labelId],
  });
}

async function searchMessages(token, query) {
  const q = encodeURIComponent(query);
  const res = await gmailGet(`messages?q=${q}&maxResults=50`, token);
  return res.messages || [];
}

async function getMessage(token, messageId) {
  return gmailGet(`messages/${messageId}?format=full`, token);
}

// ── EMAIL PARSER ────────────────────────────────────────────
function decodeBase64Url(str) {
  if (!str) return "";
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function getMessageBody(msg) {
  const payload = msg.payload;
  if (!payload) return "";

  // Simple single-part message
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — look for text/plain first, then text/html
  const parts = payload.parts || [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body && part.body.data) {
      return decodeBase64Url(part.body.data);
    }
  }
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body && part.body.data) {
      return decodeBase64Url(part.body.data);
    }
  }

  // Nested multipart
  for (const part of parts) {
    if (part.parts) {
      for (const sub of part.parts) {
        if (sub.body && sub.body.data) {
          return decodeBase64Url(sub.body.data);
        }
      }
    }
  }

  return "";
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractField(text, fieldName) {
  // Try "FIELD: value" or "FIELD\nvalue" patterns
  const patterns = [
    new RegExp(fieldName + "\\s*:\\s*(.+)", "i"),
    new RegExp(fieldName + "\\s*\\n\\s*(.+)", "i"),
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

function extractLeadUuid(text) {
  // Look for /leads/UUID pattern in the email body or links
  const match = text.match(/\/leads\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

function extractToastLeadUrl(text) {
  // Look for the full Toast admin URL
  const match = text.match(/(https:\/\/[^\s"<]+\/leads\/[0-9a-f-]{36}[^\s"<]*)/i);
  return match ? match[1] : null;
}

function parseEventDate(dateStr) {
  if (!dateStr) return null;
  // Format: "Friday, April 9, 2027" or similar
  const cleaned = dateStr.replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, "");
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function parseTime(timeStr) {
  if (!timeStr) return null;
  // Format: "6:00 PM"
  return timeStr.trim();
}

function parseToastEmail(msg) {
  const headers = msg.payload.headers || [];
  const subject = (headers.find((h) => h.name.toLowerCase() === "subject") || {}).value || "";
  const dateHeader = (headers.find((h) => h.name.toLowerCase() === "date") || {}).value || "";

  const rawBody = getMessageBody(msg);
  const body = stripHtml(rawBody);

  // Extract contact name from subject: "New Event lead: [Name]"
  const nameFromSubject = subject.replace(/^New Event lead:\s*/i, "").trim();

  const name = extractField(body, "NAME") || nameFromSubject || null;
  const email = extractField(body, "EMAIL") || null;
  const phone = extractField(body, "PHONE") || null;
  const eventDateStr = extractField(body, "EVENT DATE");
  const timeStr = extractField(body, "TIME");
  const endDateStr = extractField(body, "EVENT END DATE");
  const endTimeStr = extractField(body, "END TIME");
  const occasion = extractField(body, "Occasion") || extractField(body, "OCCASION");
  const guestCount = extractField(body, "Guest count") || extractField(body, "GUEST COUNT");
  const spacePreference = extractField(body, "Event Space Preference") || extractField(body, "EVENT SPACE PREFERENCE");
  const notes = extractField(body, "Notes") || extractField(body, "NOTES");

  const toastLeadUuid = extractLeadUuid(rawBody) || extractLeadUuid(body);
  const toastLeadUrl = extractToastLeadUrl(rawBody) || extractToastLeadUrl(body);

  const emailDate = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

  // Parse guest count to integer
  let guestCountNum = null;
  if (guestCount) {
    const parsed = parseInt(guestCount.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(parsed)) guestCountNum = parsed;
  }

  return {
    toast_lead_uuid: toastLeadUuid,
    contact_name: name,
    contact_email: email,
    contact_phone: phone,
    event_date: parseEventDate(eventDateStr),
    event_time: parseTime(timeStr),
    event_end_date: parseEventDate(endDateStr),
    event_end_time: parseTime(endTimeStr),
    occasion: occasion,
    guest_count: guestCountNum,
    space_preference: spacePreference,
    notes: notes,
    status: "new_inquiry",
    event_type: "onsite_private",
    source: "toast_lead",
    toast_lead_url: toastLeadUrl || (msg.threadId ? `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}` : null),
    created_at: emailDate,
    last_activity_at: emailDate,
    _threadId: msg.threadId,
    _messageId: msg.id,
    _subject: subject,
  };
}

// ── SUPABASE INSERT ─────────────────────────────────────────
async function insertEvent(record) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Strip internal fields before inserting
  const row = { ...record };
  delete row._threadId;
  delete row._messageId;
  delete row._subject;

  const url = `${supabaseUrl}/rest/v1/events`;
  return post(
    url,
    {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "return=representation",
    },
    row
  );
}

// ── MAIN HANDLER ────────────────────────────────────────────
const handler = async (event) => {
  const log = [];
  const addLog = (msg) => { log.push(`[${new Date().toISOString()}] ${msg}`); console.log(msg); };

  addLog(`Gmail parser starting (DRY_RUN=${DRY_RUN})`);

  // Validate env vars
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    addLog(`ERROR: Missing env vars: ${missing.join(", ")}`);
    return { statusCode: 200, body: JSON.stringify({ error: "Missing env vars", missing, log }) };
  }

  let token;
  try {
    token = await getAccessToken();
    addLog("OAuth token acquired");
  } catch (e) {
    addLog(`ERROR: OAuth failed — ${e.message}`);
    return { statusCode: 200, body: JSON.stringify({ error: "OAuth failed", log }) };
  }

  // Ensure labels exist
  let parsedLabelId, failedLabelId;
  try {
    parsedLabelId = await ensureLabel(token, LABEL_PARSED);
    failedLabelId = await ensureLabel(token, LABEL_FAILED);
    addLog(`Labels ready: ${LABEL_PARSED}=${parsedLabelId}, ${LABEL_FAILED}=${failedLabelId}`);
  } catch (e) {
    addLog(`ERROR: Label setup failed — ${e.message}`);
    return { statusCode: 200, body: JSON.stringify({ error: "Label setup failed", log }) };
  }

  // Search for unprocessed Toast lead emails
  let messages;
  try {
    messages = await searchMessages(token, GMAIL_SEARCH);
    addLog(`Found ${messages.length} unprocessed message(s)`);
  } catch (e) {
    addLog(`ERROR: Gmail search failed — ${e.message}`);
    return { statusCode: 200, body: JSON.stringify({ error: "Search failed", log }) };
  }

  if (messages.length === 0) {
    addLog("No new messages — done");
    return { statusCode: 200, body: JSON.stringify({ processed: 0, log }) };
  }

  // Process each message
  let processed = 0;
  let failed = 0;
  const results = [];

  // Dedupe by threadId — only process first message per thread
  const seenThreads = new Set();

  for (const msgRef of messages) {
    try {
      const msg = await getMessage(token, msgRef.id);
      const threadId = msg.threadId;

      if (seenThreads.has(threadId)) {
        addLog(`Skipping duplicate thread ${threadId}`);
        continue;
      }
      seenThreads.add(threadId);

      const parsed = parseToastEmail(msg);

      if (!parsed.toast_lead_uuid) {
        addLog(`WARN: No UUID found in message ${msgRef.id} (subject: "${parsed._subject}") — labeling as failed`);
        if (!DRY_RUN) await labelThread(token, threadId, failedLabelId);
        failed++;
        continue;
      }

      addLog(`Parsed: ${parsed.contact_name || "Unknown"} — UUID: ${parsed.toast_lead_uuid} — Date: ${parsed.event_date || "none"}`);

      if (DRY_RUN) {
        addLog(`DRY RUN — would insert: ${JSON.stringify({
          name: parsed.contact_name,
          email: parsed.contact_email,
          uuid: parsed.toast_lead_uuid,
          event_date: parsed.event_date,
          guests: parsed.guest_count,
          occasion: parsed.occasion,
        })}`);
        results.push({ dryRun: true, name: parsed.contact_name, uuid: parsed.toast_lead_uuid });
      } else {
        try {
          await insertEvent(parsed);
          addLog(`Inserted: ${parsed.contact_name} (${parsed.toast_lead_uuid})`);
          await labelThread(token, threadId, parsedLabelId);
          addLog(`Labeled thread ${threadId} as ${LABEL_PARSED}`);
          processed++;
          results.push({ inserted: true, name: parsed.contact_name, uuid: parsed.toast_lead_uuid });
        } catch (insertErr) {
          // Check for duplicate (Supabase returns 409 on unique constraint)
          if (insertErr.message && insertErr.message.includes("409")) {
            addLog(`DUPLICATE: ${parsed.toast_lead_uuid} already exists — labeling as parsed`);
            await labelThread(token, threadId, parsedLabelId);
            results.push({ duplicate: true, name: parsed.contact_name, uuid: parsed.toast_lead_uuid });
          } else if (insertErr.message && insertErr.message.includes("23505")) {
            // Postgres unique violation
            addLog(`DUPLICATE: ${parsed.toast_lead_uuid} already exists — labeling as parsed`);
            await labelThread(token, threadId, parsedLabelId);
            results.push({ duplicate: true, name: parsed.contact_name, uuid: parsed.toast_lead_uuid });
          } else {
            addLog(`ERROR inserting ${parsed.contact_name}: ${insertErr.message}`);
            await labelThread(token, threadId, failedLabelId);
            failed++;
            results.push({ error: true, name: parsed.contact_name, message: insertErr.message });
          }
        }
      }
    } catch (e) {
      addLog(`ERROR processing message ${msgRef.id}: ${e.message}`);
      try {
        if (!DRY_RUN) await labelThread(token, msgRef.threadId || msgRef.id, failedLabelId);
      } catch (_) { /* best effort */ }
      failed++;
    }
  }

  addLog(`Done — processed: ${processed}, failed: ${failed}, total messages: ${messages.length}`);

  return {
    statusCode: 200,
    body: JSON.stringify({ processed, failed, results, dryRun: DRY_RUN, log }),
  };
};

module.exports = { handler };
