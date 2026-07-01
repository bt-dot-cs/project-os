/**
 * Telegram webhook receiver — Vercel Function
 *
 * GET  ?setup=1  — registers this URL as the Telegram webhook (run once after deploy)
 * POST           — receives incoming Telegram messages/voice notes
 *
 * After deploy, run once:
 *   curl https://project-os-opal.vercel.app/api/telegram?setup=1
 *
 * Env vars required (all in Vercel):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY
 *   NOTION_TOKEN, NOTION_PROJECTS_DB_ID, NOTION_TASKS_DB_ID, NOTION_AGENT_SESSIONS_DB_ID
 */

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID   || '';
const ANTH_KEY   = process.env.ANTHROPIC_API_KEY  || '';
const OAI_KEY    = process.env.OPENAI_API_KEY     || '';
const NOTION_TOK = process.env.NOTION_TOKEN       || '';
const PROJ_DB    = process.env.NOTION_PROJECTS_DB_ID          || '';
const TASKS_DB   = process.env.NOTION_TASKS_DB_ID             || '';
const SESS_DB    = process.env.NOTION_AGENT_SESSIONS_DB_ID    || '';

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VER  = '2022-06-28';
const TG_BASE     = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Notion helpers ─────────────────────────────────────────────────────────

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOK}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VER,
  };
}

async function notionPost(path, body) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion POST ${path}: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function notionPatch(path, props) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method: 'PATCH',
    headers: notionHeaders(),
    body: JSON.stringify({ properties: props }),
  });
  if (!res.ok) throw new Error(`Notion PATCH ${path}: ${res.status}`);
  return res.json();
}

async function notionQuery(dbId, filter) {
  const res = await notionPost(`/databases/${dbId}/query`, { filter, page_size: 10 });
  return res.results || [];
}

// ── Notion property helpers ────────────────────────────────────────────────

const nbt = v => ({ title: [{ text: { content: (v || '').slice(0, 2000) } }] });
const nbrt = v => ({ rich_text: [{ text: { content: (v || '').slice(0, 2000) } }] });
const nbs = v => v ? { select: { name: v } } : { select: null };
const nbrel = ids => ({ relation: ids.map(id => ({ id })) });
const nbd = v => ({ date: { start: v } });

// ── Telegram helpers ───────────────────────────────────────────────────────

async function tgSend(chatId, text) {
  await fetch(`${TG_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgGetFileUrl(fileId) {
  const res = await fetch(`${TG_BASE}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile failed: ${JSON.stringify(data)}`);
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
}

// ── OpenAI Whisper ─────────────────────────────────────────────────────────

async function transcribeVoice(fileId) {
  const audioUrl = await tgGetFileUrl(fileId);
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`audio download failed: ${audioRes.status}`);
  const audioBuffer = await audioRes.arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OAI_KEY}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Whisper error: ${JSON.stringify(data)}`);
  return data.text || '';
}

// ── Claude parsing ─────────────────────────────────────────────────────────

async function parseStatusUpdate(text) {
  const prompt = `Parse this project status update and return ONLY a valid JSON object with these exact fields:
- "project": string — project name mentioned (or null)
- "tasksCompleted": string[] — tasks described as done or completed (empty array if none)
- "nextStep": string — the next action described (or null)
- "blockers": string — any blockers, issues, or stuck points (or null)
- "notes": string — any other relevant information (or null)

Status update:
"${text.replace(/"/g, '\\"')}"

Return only the JSON object, no markdown, no explanation.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTH_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude error: ${JSON.stringify(data)}`);

  const raw = (data.content?.[0]?.text || '').trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1) throw new Error('No JSON in Claude response');
  return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
}

// ── Notion writes ──────────────────────────────────────────────────────────

async function applyToNotion(rawText, parsed, chatId) {
  const results = {
    projectFound: false,
    projectId: null,
    projectName: parsed.project || null,
    tasksMarkedDone: [],
    nextStepUpdated: false,
    sessionId: null,
  };

  // Find project
  if (parsed.project && PROJ_DB) {
    try {
      const pages = await notionQuery(PROJ_DB, {
        property: 'Name',
        title: { equals: parsed.project },
      });
      if (pages.length) {
        results.projectFound = true;
        results.projectId = pages[0].id;

        // Update Next Step if provided
        if (parsed.nextStep) {
          await notionPatch(`/pages/${results.projectId}`, {
            'Next Step': nbrt(parsed.nextStep),
          });
          results.nextStepUpdated = true;
        }
      }
    } catch (e) {
      console.error('[telegram] project lookup error:', e.message);
    }
  }

  // Mark tasks done
  if ((parsed.tasksCompleted || []).length && TASKS_DB) {
    for (const taskName of parsed.tasksCompleted) {
      try {
        const filter = results.projectId
          ? {
              and: [
                { property: 'Name', title: { contains: taskName } },
                { property: 'Project', relation: { contains: results.projectId } },
              ],
            }
          : { property: 'Name', title: { contains: taskName } };

        const taskPages = await notionQuery(TASKS_DB, filter);
        if (taskPages.length) {
          await notionPatch(`/pages/${taskPages[0].id}`, {
            Status: nbs('done'),
          });
          results.tasksMarkedDone.push(taskName);
        }
      } catch (e) {
        console.error(`[telegram] task update error (${taskName}):`, e.message);
      }
    }
  }

  // Log agent session
  if (SESS_DB) {
    try {
      const sessionProps = {
        Name: nbt(`Telegram update — ${new Date().toISOString().slice(0, 10)}`),
        'Agent Type': nbs('claude'),
        Status: nbs('completed'),
        'Started At': nbd(new Date().toISOString()),
        Input: nbrt(rawText),
        Output: nbrt(JSON.stringify(parsed)),
      };
      if (results.projectId) sessionProps.Project = nbrel([results.projectId]);

      const sessionPage = await notionPost('/pages', {
        parent: { database_id: SESS_DB },
        properties: sessionProps,
      });
      results.sessionId = sessionPage.id;
    } catch (e) {
      console.error('[telegram] session log error:', e.message);
    }
  }

  return results;
}

// ── Build reply ────────────────────────────────────────────────────────────

function buildReply(parsed, results) {
  const parts = ['Logged'];

  if (results.projectFound && results.projectName) {
    parts[0] += ` for ${results.projectName}`;
  } else if (results.projectName && !results.projectFound) {
    parts[0] += ` (project "${results.projectName}" not found in Notion — check spelling)`;
  }

  if (results.tasksMarkedDone.length) {
    parts.push(`Marked done: ${results.tasksMarkedDone.join(', ')}`);
  } else if ((parsed.tasksCompleted || []).length) {
    parts.push(`Tasks mentioned as done but not matched in Notion: ${parsed.tasksCompleted.join(', ')}`);
  }

  if (results.nextStepUpdated) {
    const ns = (parsed.nextStep || '').slice(0, 80);
    parts.push(`Next step → "${ns}${parsed.nextStep.length > 80 ? '…' : ''}"`);
  }

  if (parsed.blockers) {
    parts.push(`Blockers noted: ${parsed.blockers.slice(0, 100)}`);
  }

  return parts.join('\n');
}

// ── Webhook setup ──────────────────────────────────────────────────────────

async function setWebhook(hostUrl) {
  const webhookUrl = `${hostUrl}/api/telegram`;
  const res = await fetch(`${TG_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  return res.json();
}

// ── Main handler ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Webhook setup endpoint
  if (req.method === 'GET' && req.query.setup === '1') {
    const host = `https://${req.headers.host}`;
    const result = await setWebhook(host);
    res.status(200).json(result);
    return;
  }

  // Only accept POST for webhook events
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true });
    return;
  }

  const update = req.body;
  const message = update?.message;
  if (!message) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = String(message.chat?.id || '');

  // Only process messages from our known chat
  if (CHAT_ID && chatId !== String(CHAT_ID)) {
    console.warn('[telegram] ignored message from unknown chat:', chatId);
    res.status(200).json({ ok: true });
    return;
  }

  let rawText = '';
  let inputType = 'text';

  try {
    if (message.voice) {
      inputType = 'voice';
      console.log('[telegram] transcribing voice note...');
      rawText = await transcribeVoice(message.voice.file_id);
      if (!rawText) {
        await tgSend(chatId, 'Could not transcribe voice note — try again or send as text.');
        res.status(200).json({ ok: true });
        return;
      }
    } else if (message.text) {
      rawText = message.text;
    } else {
      await tgSend(chatId, 'Only text and voice messages are supported.');
      res.status(200).json({ ok: true });
      return;
    }

    console.log(`[telegram] processing ${inputType} message: "${rawText.slice(0, 100)}"`);

    // Parse with Claude
    const parsed = await parseStatusUpdate(rawText);
    console.log('[telegram] parsed:', JSON.stringify(parsed));

    // Apply to Notion
    const results = await applyToNotion(rawText, parsed, chatId);

    // Reply
    const reply = buildReply(parsed, results);
    await tgSend(chatId, reply);

  } catch (err) {
    console.error('[telegram] error:', err.message, err.stack);
    try {
      await tgSend(chatId, `Error processing update: ${err.message.slice(0, 200)}`);
    } catch (_) {}
  }

  res.status(200).json({ ok: true });
};
