function redactInput(value) {
  const copy = JSON.parse(JSON.stringify(value ?? {}));
  if (copy.botToken) copy.botToken = '***redacted***';
  if (copy.auth) copy.auth = '***redacted***';
  if (copy.session) copy.session = '***redacted***';
  return copy;
}

function normalizeChatIdValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  if (!str) return null;
  if (/^-?\d+$/.test(str)) return Number(str);
  return str.startsWith('@') ? str : `@${str}`;
}

function collectChatsFromUpdate(update) {
  const chats = [];
  const push = (chat) => {
    if (chat && typeof chat === 'object' && chat.id !== undefined && chat.id !== null) chats.push(chat);
  };

  push(update.message?.chat);
  push(update.edited_message?.chat);
  push(update.channel_post?.chat);
  push(update.edited_channel_post?.chat);
  push(update.my_chat_member?.chat);
  push(update.chat_member?.chat);
  push(update.callback_query?.message?.chat);
  push(update.business_message?.chat);
  push(update.edited_business_message?.chat);
  push(update.purchased_paid_media?.from_chat);

  return chats;
}

async function tgRequest(token, method, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }

  const qs = params.toString();
  const url = `https://api.telegram.org/bot${token}/${method}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

export async function run(rawInput = {}) {
  const input = rawInput && typeof rawInput === 'object' && rawInput.body && typeof rawInput.body === 'object'
    ? rawInput.body
    : rawInput;

  const mode = String(input.mode || (input.botToken ? 'bot' : 'user')).toLowerCase();
  const botToken = String(input.botToken || '').trim();
  const rawChatIds = input.chatIds ?? input.chat_ids ?? [];
  const maxBatches = Math.max(1, Math.min(Number(input.maxBatches ?? 10), 50));
  const maxChats = Math.max(1, Math.min(Number(input.maxChats ?? 100), 200));

  if (mode === 'user') {
    return {
      ok: false,
      mode,
      message: 'Telegram user auth needs MTProto/TDLib/GramJS. The Bot API cannot enumerate all dialogs for a user account, so this workflow only implements the bot-token path directly.',
      suggestion: 'If you want, I can add a small sidecar service for user-auth later and connect this workflow to it.',
      inputReceived: redactInput(input)
    };
  }

  if (!botToken) {
    return {
      ok: false,
      mode: 'bot',
      message: 'Missing botToken. Send { "mode": "bot", "botToken": "123456:ABC..." }'
    };
  }

  const me = await tgRequest(botToken, 'getMe');
  if (!me.ok) {
    return {
      ok: false,
      mode: 'bot',
      message: 'Bot token validation failed.',
      telegram: me
    };
  }

  const manualChatIds = Array.isArray(rawChatIds)
    ? rawChatIds
    : String(rawChatIds)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

  const seen = new Map();
  const addChat = (chat, source) => {
    if (!chat || chat.id === undefined || chat.id === null) return;
    const key = String(chat.id);
    if (!seen.has(key)) {
      seen.set(key, {
        id: chat.id,
        type: chat.type,
        title: chat.title ?? chat.first_name ?? chat.username ?? null,
        username: chat.username ?? null,
        source,
        raw: chat
      });
    }
  };

  if (manualChatIds.length > 0) {
    for (const value of manualChatIds.slice(0, maxChats)) {
      addChat({ id: normalizeChatIdValue(value) }, 'manual-input');
    }
  } else {
    let offset = Number(input.offset ?? 0);
    let batches = 0;
    const updates = [];

    while (batches < maxBatches) {
      const page = await tgRequest(botToken, 'getUpdates', { offset, limit: 100, timeout: 0 });

      if (!page.ok) {
        return {
          ok: false,
          mode: 'bot',
          message: 'Failed to fetch updates from Telegram.',
          telegram: page
        };
      }

      const batch = Array.isArray(page.result) ? page.result : [];
      if (batch.length === 0) break;

      updates.push(...batch);
      offset = batch[batch.length - 1].update_id + 1;
      batches += 1;
    }

    for (const update of updates) {
      for (const chat of collectChatsFromUpdate(update)) addChat(chat, 'update');
    }
  }

  const chats = [...seen.values()].slice(0, maxChats);
  const enriched = [];

  for (const chat of chats) {
    if (typeof chat.id !== 'number' && typeof chat.id !== 'string') continue;
    const resolved = await tgRequest(botToken, 'getChat', { chat_id: chat.id });
    if (resolved.ok) {
      enriched.push({
        id: resolved.result.id,
        type: resolved.result.type,
        title: resolved.result.title ?? resolved.result.first_name ?? resolved.result.username ?? null,
        username: resolved.result.username ?? null,
        description: resolved.result.description ?? null,
        invite_link: resolved.result.invite_link ?? null,
        permissions: resolved.result.permissions ?? null,
        raw: resolved.result
      });
    } else {
      enriched.push({ ...chat, lookupError: resolved });
    }
  }

  return {
    ok: true,
    mode: 'bot',
    bot: {
      id: me.result.id,
      username: me.result.username ?? null,
      first_name: me.result.first_name ?? null,
      can_join_groups: me.result.can_join_groups ?? null,
      can_read_all_group_messages: me.result.can_read_all_group_messages ?? null
    },
    note: 'This lists only groups/chats that Telegram has exposed to the bot via updates or the manual chatIds input. The Bot API cannot enumerate every group the bot belongs to on its own.',
    count: enriched.length,
    chats: enriched,
    inputReceived: redactInput(input)
  };
}

async function main() {
  const b64 = process.env.N8N_INPUT_B64;
  if (!b64) {
    return;
  }

  const input = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const result = await run(input);
  process.stdout.write(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
