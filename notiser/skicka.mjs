// KockBot – påminnelser till telefonen
//
// Körs av GitHub (se .github/workflows/kockbot-notiser.yml) var 15:e minut. Programmet läser hushållen
// som har slagit på notiser i KockBot och skickar:
//   1. Kvällen innan (från kl 18 eller den tid ni valt): det som ska förberedas till morgondagens middag,
//      t.ex. "Ta fram laxen ur frysen".
//   2. Samma dag: när det är dags att börja laga (middagstiden minus receptets tid).
// Varje påminnelse skickas en gång – det som skickats antecknas i hushållet (pushLog).
//
// Programmet behöver inga paket, bara Node 18 eller senare, och två hemligheter i GitHub:
//   FIREBASE_SERVICE_ACCOUNT – hela JSON-filen från Firebase → Projektinställningar → Tjänstekonton
//   VAPID_PRIVATE_KEY        – den privata nyckeln som hör ihop med VAPID_PUBLIC_KEY nedan (och i appen)
//
// OBS: loggarna från GitHub syns för alla om ert repo är publikt. Därför skrivs bara antal ut här,
// aldrig hushållskoder, recept eller namn.

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const VAPID_PUBLIC_KEY = 'BMj9WyN0W-yroCku7W5oETxfK4Cxp55OSgm_v-clCosrgJDvWmShEnnFHOylW3BWZuGUiQ_OmKMI5u3qkeV7Sf8';
const APP_ID = process.env.KOCKBOT_APP_ID || 'kockbot-live';
const TIME_ZONE = 'Europe/Stockholm';
const DEFAULT_REMINDER_TIME = '18:00';
const DEFAULT_DINNER_TIME = '17:30';
const LAST_PREP_REMINDER = 23 * 60;      // skicka inte "inför imorgon" efter kl 23
const COOK_FALLBACK_MINUTES = 45;        // recept utan tid: påminn 45 min före middagen
const LOG_DAYS = 7;                      // hur länge anteckningarna om skickade påminnelser sparas

// ---------------------------------------------------------------------------
// Små hjälpfunktioner
// ---------------------------------------------------------------------------
export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Datum och klockslag i Sverige, oavsett var GitHub kör programmet
export const stockholmNow = (date = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
export const addDaysISO = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Samma regler som i appen: "30 min", "1 h", "1 h 30 min", "1,5 timmar", "45-60 min" → minuter
export const parseMinutes = (t) => {
  const s = String(t || '').toLowerCase().replace(',', '.');
  let total = 0, found = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*(h\b|tim)/);
  if (h) { total += parseFloat(h[1]) * 60; found = true; }
  const m = s.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s*(min|m\b)/);
  if (m) { total += parseInt(m[2] || m[1], 10); found = true; }
  if (!found) { const n = s.match(/^\s*(\d+)\s*$/); if (n) { total = parseInt(n[1], 10); found = true; } }
  return found ? Math.round(total) : null;
};
const formatClock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Samma som "Förberedelser dagen innan" i appen
export const suggestPrep = (recipe) => {
  if (!recipe) return '';
  if (typeof recipe.prep === 'string' && recipe.prep.trim()) return recipe.prep.trim();
  const tips = [];
  (recipe.ingredients || []).forEach(i => {
    const name = String(i?.name || '');
    const n = name.toLowerCase();
    if (/(^|\s|,)(djup)?frysta?(\s|,|$)/.test(n)) tips.push(`Ta fram ${name.replace(/(djup)?frysta?/i, '').replace(/^[,\s]+|[,\s]+$/g, '').toLowerCase()} ur frysen`);
    else if (/torkade?\s+(\S+\s+)?(bönor|kikärtor|ärtor)/.test(n)) tips.push(`Lägg ${n} i blöt`);
  });
  if (/(över natten|dagen innan|kvällen innan|dagen före)/i.test(String(recipe.instructions || ''))) tips.push('Läs receptet – något ska göras dagen innan');
  return [...new Set(tips)].join('. ');
};

// ---------------------------------------------------------------------------
// Web Push: kryptering (RFC 8291, aes128gcm) och VAPID (RFC 8292)
// ---------------------------------------------------------------------------
const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

// Krypterar ett meddelande till en prenumeration. asKeys och salt kan anges för testning.
export const encryptPayload = (payload, { p256dh, auth }, { asKeys, salt } = {}) => {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Ogiltig prenumeration');
  const ecdh = asKeys || crypto.createECDH('prime256v1');
  if (!asKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const useSalt = salt || crypto.randomBytes(16);
  const cek = hkdf(useSalt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(useSalt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 2 = sista posten
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  useSalt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
};

// Dekryptering – används bara av testerna för att kontrollera krypteringen
export const decryptPayload = (body, uaPrivate, auth) => {
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(asPublic);
  const ikm = hkdf(fromB64url(auth), sharedSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = body.subarray(21 + idLen);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('Fel avslutning');
  return plain.subarray(0, end).toString();
};

// Nyckelobjekt för VAPID-signaturen
export const vapidKey = (privateKeyB64, publicKeyB64 = VAPID_PUBLIC_KEY) => {
  const pub = fromB64url(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('Ogiltig publik VAPID-nyckel');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: String(privateKeyB64).trim(), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: 'jwk' });
};

export const vapidAuthorization = (endpoint, subject, key, publicKeyB64 = VAPID_PUBLIC_KEY, now = Date.now()) => {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${publicKeyB64}`;
};

// Skickar en notis. Svarar { ok, gone } – gone betyder att telefonen inte längre tar emot (avinstallerad e.d.)
export const sendPush = async (sub, message, { key, subject, fetchImpl = fetch, ttl = 6 * 3600 } = {}) => {
  const body = encryptPayload(JSON.stringify(message), sub.keys || {});
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(sub.endpoint, subject, key),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
};

// ---------------------------------------------------------------------------
// Firestore via REST med tjänstekontot
// ---------------------------------------------------------------------------
export const googleAccessToken = async (sa, fetchImpl = fetch) => {
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: tokenUrl, iat: now, exp: now + 3600 }))}`;
  const assertion = `${unsigned}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key))}`;
  const res = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Kunde inte logga in med tjänstekontot (${res.status}): ${json.error_description || json.error || ''}`);
  return json.access_token;
};

export const fromValue = (v) => {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromValue(x)]));
  return null;
};
export const toValue = (x) => {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toValue(v)])) } };
};
// Fältsökväg: delar med tecken som : eller - måste citeras med `
export const fieldPath = (...segments) => segments.map(s => /^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`').join('.');

export const makeFirestore = ({ projectId, token, base = 'https://firestore.googleapis.com/v1', fetchImpl = fetch }) => {
  const root = `${base}/projects/${projectId}/databases/(default)/documents`;
  const call = async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (res.status === 404) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firestore svarade ${res.status}: ${json?.error?.message || ''}`);
    return json;
  };
  return {
    // Hushållen som har slagit på notiser
    async householdsWithPush() {
      const rows = await call(`${root}/artifacts/${APP_ID}/public/data:runQuery`, {
        method: 'POST',
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'households' }], where: { fieldFilter: { field: { fieldPath: 'pushOn' }, op: 'EQUAL', value: { booleanValue: true } } } } }),
      }) || [];
      return rows.filter(r => r.document).map(r => ({ name: r.document.name, data: fromValue({ mapValue: { fields: r.document.fields || {} } }) }));
    },
    async getRecipe(householdName, recipeId) {
      if (!recipeId || /[\/]/.test(recipeId)) return null;
      const doc = await call(`${base}/${householdName}/recipes/${encodeURIComponent(recipeId)}`);
      return doc ? fromValue({ mapValue: { fields: doc.fields || {} } }) : null;
    },
    // Sätter (värde) eller tar bort (undefined) fält i hushållet. paths: [[segment, ...], värde]
    async update(householdName, changes) {
      if (!changes.length) return;
      const params = new URLSearchParams();
      changes.forEach(([segs]) => params.append('updateMask.fieldPaths', fieldPath(...segs)));
      params.append('currentDocument.exists', 'true');
      const fields = {};
      changes.forEach(([segs, value]) => {
        if (value === undefined) return;
        let target = fields;
        segs.forEach((seg, i) => {
          if (i === segs.length - 1) { target[seg] = toValue(value); return; }
          target[seg] = target[seg] || { mapValue: { fields: {} } };
          target = target[seg].mapValue.fields;
        });
      });
      await call(`${base}/${householdName}?${params.toString()}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
    },
  };
};

// ---------------------------------------------------------------------------
// Vad ska skickas till ett hushåll just nu?
// ---------------------------------------------------------------------------
const recipeIdOf = (day) => day?.recipe?.id || null;
// Rester: dagen har samma recept som dagen innan och är markerad som rester
const isLeftover = (day, byDate) => !!(day?.isLeftover && recipeIdOf(day) && recipeIdOf(byDate[addDaysISO(day.date, -1)]) === recipeIdOf(day));

export const remindersFor = async (data, now, getRecipe = async () => null) => {
  const out = [];
  const days = Object.values(isObject(data.planDays) ? data.planDays : {}).filter(d => isObject(d) && typeof d.date === 'string');
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));
  const log = isObject(data.pushLog) ? data.pushLog : {};
  const reminderTime = isTime(data.reminderTime) ? data.reminderTime : DEFAULT_REMINDER_TIME;
  const dinnerTime = isTime(data.dinnerTime) ? data.dinnerTime : DEFAULT_DINNER_TIME;
  // Receptboken har den senaste versionen (t.ex. om förberedelserna ändrats efter att matsedeln gjordes)
  const latest = async (day) => ({ ...day.recipe, ...((await getRecipe(recipeIdOf(day))) || {}) });

  // 1. Kvällen innan
  const tomorrow = addDaysISO(now.date, 1);
  const tm = byDate[tomorrow];
  const prepKey = `prep:${tomorrow}`;
  if (tm?.recipe && !isLeftover(tm, byDate) && !(isObject(data.prepDone) && data.prepDone[tomorrow]) && !log[prepKey]
      && now.minutes >= toMinutes(reminderTime) && now.minutes < LAST_PREP_REMINDER) {
    const recipe = await latest(tm);
    const prep = suggestPrep(recipe);
    if (prep) out.push({ key: prepKey, type: 'prep', message: { title: `Inför imorgon: ${recipe.name || 'middagen'}`, body: prep, tag: prepKey } });
  }

  // 2. Dags att börja laga
  const td = byDate[now.date];
  const cookKey = `cook:${now.date}`;
  if (td?.recipe && !isLeftover(td, byDate) && !(isObject(data.cookedDays) && data.cookedDays[now.date]) && !log[cookKey]) {
    const recipe = await latest(td);
    const minutes = parseMinutes(recipe.time);
    const dinner = toMinutes(dinnerTime);
    const start = Math.max(0, dinner - (minutes || COOK_FALLBACK_MINUTES));
    if (now.minutes >= start && now.minutes < dinner + 30) {
      const cook = isObject(data.dayCooks) ? data.dayCooks[now.date] : null;
      const cookName = typeof cook === 'string' ? cook : (isObject(cook) ? cook.name : '');
      const body = [`Middag kl ${dinnerTime}`, minutes ? `tar ca ${recipe.time}` : '', cookName ? `${cookName} lagar` : ''].filter(Boolean).join(' · ');
      out.push({ key: cookKey, type: 'cook', message: { title: `Dags att börja laga: ${recipe.name || 'middagen'}`, body, tag: cookKey, startAt: formatClock(start) } });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Huvudprogrammet
// ---------------------------------------------------------------------------
export const run = async ({ env = process.env, fetchImpl = fetch, nowDate = new Date(), log = console.log } = {}) => {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Hemligheten FIREBASE_SERVICE_ACCOUNT saknas i GitHub.');
  if (!env.VAPID_PRIVATE_KEY) throw new Error('Hemligheten VAPID_PRIVATE_KEY saknas i GitHub.');
  let sa;
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT är inte en giltig JSON-fil – klistra in hela filens innehåll.'); }
  const key = vapidKey(env.VAPID_PRIVATE_KEY);
  const token = await googleAccessToken(sa, fetchImpl);
  const fs = makeFirestore({ projectId: sa.project_id, token, base: env.FIRESTORE_BASE || undefined, fetchImpl });
  const now = stockholmNow(nowDate);
  const test = String(env.TEST || '').toLowerCase() === 'true';
  const stats = { households: 0, phones: 0, sent: 0, failed: 0, removed: 0 };

  const households = await fs.householdsWithPush();
  for (const { name, data } of households) {
    stats.households++;
    const subs = Object.entries(isObject(data.pushSubs) ? data.pushSubs : {}).filter(([, s]) => isObject(s) && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && isObject(s.keys));
    stats.phones += subs.length;
    const changes = [];
    if (!subs.length) { await fs.update(name, [[['pushOn'], false]]); continue; }

    const reminders = test
      ? [{ key: null, type: 'test', message: { title: 'KockBot-notiser fungerar!', body: 'Ni får påminnelser kvällen innan om det som ska förberedas och när det är dags att börja laga.', tag: 'test' } }]
      : await remindersFor(data, now, (id) => fs.getRecipe(name, id));

    const gone = new Set();
    for (const reminder of reminders) {
      let delivered = 0;
      for (const [id, sub] of subs) {
        if (gone.has(id)) continue;
        if (reminder.type === 'prep' && sub.prep === false) continue;
        if (reminder.type === 'cook' && sub.cook === false) continue;
        const appUrl = typeof sub.appUrl === 'string' && /^https:\/\//.test(sub.appUrl) ? sub.appUrl : '';
        const subject = appUrl ? new URL(appUrl).origin : 'mailto:kockbot@users.noreply.github.com';
        try {
          const res = await sendPush(sub, { ...reminder.message, url: appUrl || './' }, { key, subject, fetchImpl });
          if (res.ok) { delivered++; stats.sent++; }
          else if (res.gone) { gone.add(id); stats.removed++; }
          else stats.failed++;
        } catch (err) {
          stats.failed++;
        }
      }
      // Antecknas när minst en telefon fått den (annars görs ett nytt försök nästa gång)
      if (reminder.key && delivered > 0) changes.push([['pushLog', reminder.key], true]);
    }
    gone.forEach(id => changes.push([['pushSubs', id], undefined]));
    if (gone.size && gone.size === subs.length) changes.push([['pushOn'], false]);
    // Rensa gamla anteckningar
    const oldest = addDaysISO(now.date, -LOG_DAYS);
    Object.keys(isObject(data.pushLog) ? data.pushLog : {}).forEach(k => { const d = k.split(':')[1] || ''; if (d < oldest) changes.push([['pushLog', k], undefined]); });
    if (changes.length) await fs.update(name, changes);
  }
  log(`Klart ${now.date} ${formatClock(now.minutes)}: ${stats.households} hushåll, ${stats.phones} telefoner, ${stats.sent} notiser skickade, ${stats.failed} misslyckades, ${stats.removed} telefoner borttagna.`);
  return stats;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch(err => { console.error(`Fel: ${err.message}`); process.exit(1); });
}
