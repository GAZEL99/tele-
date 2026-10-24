// Telegram Video Downloader Bot — Cloudflare Workers + SaverAPI
// Secrets wajib : BOT_TOKEN, SAVERAPI_KEY, WEBHOOK_SECRET
// Variabel opsional: ALLOWED_USER_IDS (contoh: "123456789,987654321")

const API_URL = 'https://saverapi.net/api/all-in-one-downloader-api';

const CFG = {
  maxInflight: 3,               // permintaan SaverAPI bersamaan per isolate
  cooldownMs: 8_000,            // jeda antar-permintaan per pengguna
  dailyLimit: 15,               // panggilan SaverAPI per pengguna per hari (UTC)
  mediaTtlMs: 10 * 60_000,      // cache download_url (CDN cepat kedaluwarsa)
  fileIdTtlMs: 6 * 3600_000,    // cache file_id Telegram
  seenTtlMs: 10 * 60_000,       // dedup update_id
  maxJsonChars: 100_000,        // batas ukuran respons SaverAPI
  videoUrlLimit: 20 * 1024 * 1024, // batas kirim video via URL
  photoUrlLimit: 5 * 1024 * 1024,  // batas kirim foto via URL
};

// Domain yang diizinkan (SaverAPI mendokumentasikan platform ini; YouTube
// memakai endpoint terpisah berbiaya 9.5 kredit sehingga sengaja tidak diaktifkan).
const SUPPORTED = [
  'instagram.com', 'tiktok.com', 'facebook.com', 'fb.watch', 'x.com',
  'twitter.com', 'pinterest.com', 'pin.it', 'threads.net', 'threads.com',
  'vimeo.com', 'snapchat.com', 'likee.video', 'soundcloud.com',
  'spotify.com', 'twitch.tv', 'weibo.com', 'weibo.cn',
];

// State best-effort di memori isolate (hilang saat isolate di-restart).
const state = {
  seen: new Map(),   // update_id -> ts
  last: new Map(),   // userId -> ts
  daily: new Map(),  // userId -> {day, count}
  cache: new Map(),  // link -> {mediaAt, media, fileAt, fileId, kind}
  inflight: 0,
};

const START_TEXT =
  'Halo! 👋 Kirim tautan video/foto publik dari Instagram, TikTok, Facebook, X (Twitter), ' +
  'Pinterest, Threads, Vimeo, dan beberapa platform lain, nanti saya kirimkan filenya di sini.\n\n' +
  'Ketik /help untuk petunjuk.';

const HELP_TEXT =
  'Cara pakai:\n' +
  '1. Salin tautan postingan publik.\n' +
  '2. Kirim tautannya ke chat ini.\n' +
  '3. Tunggu beberapa detik.\n\n' +
  'Catatan:\n' +
  '• Hanya konten publik (bukan akun privat / butuh login).\n' +
  '• YouTube belum didukung.\n' +
  '• Ada jeda antar-permintaan dan batas harian untuk menghemat kuota.\n' +
  '• Unduh hanya konten yang kamu berhak simpan dan bagikan.\n\n' +
  'Perintah: /start, /help, /id';

// ───────────────────────── Entry point ─────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('OK');

    if (!env.BOT_TOKEN || !env.SAVERAPI_KEY || !env.WEBHOOK_SECRET) {
      return new Response('Not configured', { status: 500 });
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return webhook(request, env, ctx);
    }
    if ((url.pathname === '/setup' || url.pathname === '/disable') && request.method === 'GET') {
      return admin(url, env);
    }
    return new Response('Not found', { status: 404 });
  },
};

async function webhook(request, env, ctx) {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!safeEqual(got, env.WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 });

  const len = Number(request.headers.get('content-length') || 0);
  if (len > 100_000) return new Response('ok');

  let update;
  try { update = await request.json(); } catch { return new Response('ok'); }

  // Balas 200 secepatnya; proses di latar belakang agar Telegram tidak mengirim ulang.
  ctx.waitUntil(
    handleUpdate(update, env).catch((e) => console.error('handleUpdate gagal:', e?.name || 'error'))
  );
  return new Response('ok');
}

// /setup?secret=WEBHOOK_SECRET  -> pasang webhook ke URL Worker ini
// /disable?secret=WEBHOOK_SECRET -> hapus webhook (kill switch)
async function admin(url, env) {
  if (!safeEqual(url.searchParams.get('secret') || '', env.WEBHOOK_SECRET)) {
    return new Response('Forbidden', { status: 403 });
  }
  const r = url.pathname === '/setup'
    ? await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message'],
        drop_pending_updates: true,
        max_connections: 5,
      })
    : await tg(env, 'deleteWebhook', { drop_pending_updates: true });
  return new Response(JSON.stringify({ ok: !!r.ok, description: r.description || null }), {
    headers: { 'content-type': 'application/json' },
  });
}

// ───────────────────────── Handler pesan ─────────────────────────

async function handleUpdate(update, env) {
  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string' || !msg.from || msg.chat?.type !== 'private') return;

  const now = Date.now();
  if (typeof update.update_id === 'number') {
    if (state.seen.has(update.update_id)) return; // duplikat
    state.seen.set(update.update_id, now);
    prune(state.seen, CFG.seenTtlMs, now);
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const replyTo = msg.message_id;
  const text = msg.text.trim();
  const cmd = text.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase();

  if (cmd === 'id') return send(env, chatId, replyTo, `ID Telegram kamu: ${userId}`);

  const allowed = parseIds(env.ALLOWED_USER_IDS);
  if (allowed.size && !allowed.has(String(userId))) {
    return send(env, chatId, replyTo, 'Maaf, bot ini bersifat pribadi.');
  }

  if (cmd === 'start') return send(env, chatId, replyTo, START_TEXT);
  if (cmd === 'help') return send(env, chatId, replyTo, HELP_TEXT);
  if (cmd) return send(env, chatId, replyTo, 'Perintah tidak dikenal. Ketik /help.');

  await handleLink(env, { chatId, userId, replyTo, text, now });
}

async function handleLink(env, { chatId, userId, replyTo, text, now }) {
  const parsed = extractLink(text);
  if (parsed.error) return send(env, chatId, replyTo, parsed.error);
  const link = parsed.url;

  // Cooldown per pengguna
  const last = state.last.get(userId) || 0;
  if (now - last < CFG.cooldownMs) {
    const wait = Math.ceil((CFG.cooldownMs - (now - last)) / 1000);
    return send(env, chatId, replyTo, `Tunggu ${wait} detik sebelum mengirim tautan berikutnya.`);
  }
  state.last.set(userId, now);
  prune(state.last, 3600_000, now);

  const status = await send(env, chatId, replyTo, '⏳ Memproses tautan…');
  const statusId = status?.result?.message_id;

  try {
    const entry = state.cache.get(link);

    // 1) file_id tersimpan: tanpa kredit API, tanpa unggah ulang
    if (entry?.fileId && now - entry.fileAt < CFG.fileIdTtlMs) {
      const r = await sendMedia(env, chatId, replyTo, entry.kind, entry.fileId, entry.caption);
      if (r.ok) return cleanup(env, chatId, statusId);
    }

    // 2) media tersimpan: tanpa kredit API
    let media = entry?.media && now - entry.mediaAt < CFG.mediaTtlMs ? entry.media : null;

    // 3) panggil SaverAPI
    if (!media) {
      const day = new Date(now).toISOString().slice(0, 10);
      const d = state.daily.get(userId);
      const count = d && d.day === day ? d.count : 0;
      if (count >= CFG.dailyLimit) {
        return fail(env, chatId, statusId, 'Batas harian tercapai. Coba lagi besok.');
      }
      if (state.inflight >= CFG.maxInflight) {
        return fail(env, chatId, statusId, 'Bot sedang sibuk. Coba lagi sebentar lagi.');
      }
      state.daily.set(userId, { day, count: count + 1 });
      prune(state.daily, 2 * 86400_000, now, (v) => Date.parse(v.day));

      state.inflight++;
      let res;
      try { res = await fetchMedia(env, link); } finally { state.inflight--; }
      if (!res.ok) return fail(env, chatId, statusId, saverMessage(res.code));
      media = res.media;
      state.cache.set(link, { ...(entry || {}), mediaAt: Date.now(), media });
      prune(state.cache, CFG.fileIdTtlMs, Date.now(), (v) => v.fileAt || v.mediaAt);
    }

    await deliver(env, { chatId, replyTo, statusId, link, media });
  } catch (e) {
    console.error('handleLink gagal:', e?.name || 'error');
    await fail(env, chatId, statusId, 'Terjadi kesalahan tak terduga. Coba lagi nanti.');
  }
}

// ───────────────────────── SaverAPI ─────────────────────────

async function fetchMedia(env, link) {
  const api = new URL(API_URL);
  api.searchParams.set('url', link);

  for (let attempt = 0; attempt < 2; attempt++) {
    let res, raw;
    try {
      res = await fetch(api, {
        headers: { 'x-api-key': env.SAVERAPI_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      raw = await res.text();
    } catch {
      return { ok: false, code: 'timeout' }; // tidak di-retry: bisa jadi sudah ditagih
    }
    if (raw.length > CFG.maxJsonChars) return { ok: false, code: 'bad_response' };

    // 502/504 tidak ditagih menurut dokumentasi -> boleh 1x retry
    if (res.status === 502 || res.status === 504) {
      if (attempt === 0) { await sleep(1500); continue; }
      return { ok: false, code: 'upstream' };
    }
    if (!res.ok) return { ok: false, code: String(res.status) };

    let data;
    try { data = JSON.parse(raw); } catch { return { ok: false, code: 'bad_response' }; }
    if (!data || typeof data !== 'object' || data.error !== false) return { ok: false, code: 'failed' };

    const type = data.type;
    if ((type !== 'video' && type !== 'image') || !isSafeHttps(data.download_url)) {
      return { ok: false, code: 'bad_response' };
    }
    return {
      ok: true,
      media: {
        type,
        download_url: data.download_url,
        caption: typeof data.caption === 'string' ? data.caption.slice(0, 900) : '',
      },
    };
  }
  return { ok: false, code: 'upstream' };
}

function saverMessage(code) {
  switch (code) {
    case '400': return 'Tautan tidak dapat diproses. Pastikan tautannya lengkap dan benar.';
    case '401':
    case '402':
    case '403': return 'Layanan downloader sedang tidak tersedia (masalah akun/kuota). Hubungi pemilik bot.';
    case '429': return 'Layanan sedang ramai. Coba lagi beberapa saat lagi.';
    case 'timeout':
    case 'upstream': return 'Layanan downloader tidak merespons. Coba lagi nanti.';
    case 'failed': return 'Media tidak dapat diambil. Postingan mungkin privat, dihapus, atau dibatasi wilayah.';
    case 'bad_response': return 'Respons layanan tidak valid atau media tidak didukung.';
    default: return 'Gagal memproses tautan. Coba lagi nanti.';
  }
}

// ───────────────────────── Pengiriman media ─────────────────────────

async function deliver(env, { chatId, replyTo, statusId, link, media }) {
  const kind = media.type === 'image' ? 'photo' : 'video';
  const limit = kind === 'photo' ? CFG.photoUrlLimit : CFG.videoUrlLimit;

  const head = await probe(media.download_url);
  if (head.ct && (head.ct.startsWith('text/') || head.ct.includes('json'))) {
    return fail(env, chatId, statusId, 'Tautan hasil bukan file media yang valid.');
  }
  if (head.size && head.size > limit) {
    const mb = Math.round(head.size / 1048576);
    return linkFallback(env, chatId, replyTo, statusId, media,
      `Ukuran file (~${mb} MB) melebihi batas kirim langsung bot ini.`);
  }

  const r = await sendMedia(env, chatId, replyTo, kind, media.download_url, media.caption);
  if (!r.ok) {
    console.error('Telegram kirim media gagal, kode:', r.error_code || 'n/a');
    return linkFallback(env, chatId, replyTo, statusId, media,
      'Telegram tidak bisa mengambil file ini secara langsung.');
  }

  // Terkirim (sudah dikonfirmasi Telegram) -> simpan file_id untuk permintaan berikutnya
  const fileId = kind === 'photo'
    ? r.result?.photo?.at(-1)?.file_id
    : r.result?.video?.file_id || r.result?.document?.file_id;
  if (fileId) {
    const prev = state.cache.get(link) || {};
    state.cache.set(link, { ...prev, fileAt: Date.now(), fileId, kind, caption: media.caption });
  }
  await cleanup(env, chatId, statusId);
}

function sendMedia(env, chatId, replyTo, kind, file, caption) {
  const base = {
    chat_id: chatId,
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    ...(caption ? { caption: caption.slice(0, 1024) } : {}),
  };
  return kind === 'photo'
    ? tg(env, 'sendPhoto', { ...base, photo: file })
    : tg(env, 'sendVideo', { ...base, video: file, supports_streaming: true });
}

async function linkFallback(env, chatId, replyTo, statusId, media, reason) {
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    text: `${reason}\nKamu bisa mengunduhnya lewat tombol di bawah (tautan bersifat sementara).`,
    reply_markup: { inline_keyboard: [[{ text: '⬇️ Buka / Unduh', url: media.download_url }]] },
  });
  await cleanup(env, chatId, statusId);
}

// HEAD hanya membaca header (tidak mengunduh isi file).
async function probe(u) {
  try {
    const r = await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    const n = Number(r.headers.get('content-length'));
    return {
      size: Number.isFinite(n) && n > 0 ? n : null,
      ct: (r.headers.get('content-type') || '').toLowerCase(),
    };
  } catch {
    return { size: null, ct: '' };
  }
}

// ───────────────────────── Telegram helpers ─────────────────────────

async function tg(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => null);
    return data && typeof data === 'object' ? data : { ok: false, error_code: res.status };
  } catch {
    return { ok: false, error_code: 'network' };
  }
}

function send(env, chatId, replyTo, text) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
  });
}

function cleanup(env, chatId, statusId) {
  return statusId ? tg(env, 'deleteMessage', { chat_id: chatId, message_id: statusId }) : null;
}

async function fail(env, chatId, statusId, text) {
  if (statusId) {
    const r = await tg(env, 'editMessageText', { chat_id: chatId, message_id: statusId, text: `❌ ${text}` });
    if (r.ok) return;
  }
  await tg(env, 'sendMessage', { chat_id: chatId, text: `❌ ${text}` });
}

// ───────────────────────── Validasi & util ─────────────────────────

function extractLink(text) {
  const m = text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/i);
  if (!m) return { error: 'Kirim tautan lengkap yang diawali http:// atau https://. Ketik /help untuk petunjuk.' };

  let u;
  try { u = new URL(m[0].replace(/[),.;!?]+$/, '')); }
  catch { return { error: 'Tautan tidak valid.' }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: 'Hanya tautan http/https yang didukung.' };
  }
  if (u.username || u.password) return { error: 'Tautan tidak valid.' };
  if (!isPublicHost(u.hostname)) return { error: 'Tautan tidak valid.' };

  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    return { error: 'YouTube belum didukung oleh bot ini.' };
  }
  if (!SUPPORTED.some((d) => host === d || host.endsWith('.' + d))) {
    return { error: 'Platform ini belum didukung. Ketik /help untuk daftar singkat.' };
  }
  u.hash = '';
  return { url: u.href };
}

function isPublicHost(h) {
  h = h.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.includes(':') || h.startsWith('[')) return false;          // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;             // IPv4 literal
  return true;
}

function isSafeHttps(s) {
  if (typeof s !== 'string' || s.length > 4096) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && isPublicHost(u.hostname);
  } catch { return false; }
}

function parseIds(v) {
  return new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function prune(map, ttlMs, now, getTs = (v) => (typeof v === 'number' ? v : v.at)) {
  if (map.size < 200) return;
  for (const [k, v] of map) if (now - getTs(v) > ttlMs) map.delete(k);
  if (map.size > 2000) map.clear();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
