import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

export function text(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body };
}

export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Sistemin administrator quraşdırması tamamlanmayıb: Supabase açarları Netlify-də əlavə olunmalıdır.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0,10) === s;
}

export function getNights(checkIn, checkOut) {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000);
}

export async function quoteForUnit(client, unit, checkIn, checkOut, guestCount, breakfast, campaignCode = '', marriageConfirmed = false) {
  if (campaignCode) {
    const nights = getNights(checkIn, checkOut);
    const scandiIds = ['scandi-large-1','scandi-large-2','scandi-small-1','scandi-small-2'];
    const aframeIds = ['aframe-1','aframe-2'];
    let packagePrice, packageName, packageRule, breakfastIncluded = true;
    if (['autumn_149','autumn_179','autumn_249'].includes(campaignCode)) {
      if (!scandiIds.includes(unit.id)) throw new Error('Payız kampaniyası yalnız Orange, Blue, White və Green evlərində keçərlidir.');
      if (nights !== 3 || checkOut > '2026-11-05') throw new Error('Payız kampaniyası 5 noyabr 2026-dək bitən 3 gecəlik rezervasiyalar üçündür.');
      if (campaignCode === 'autumn_149' && guestCount === 2) { packagePrice=149; packageName='Payız kampaniyası — 2 nəfər'; }
      else if (campaignCode === 'autumn_179' && guestCount >= 3 && guestCount <= 4) { packagePrice=179; packageName='Payız kampaniyası — 3–4 nəfər'; }
      else if (campaignCode === 'autumn_249' && guestCount >= 6 && guestCount <= 7) { packagePrice=249; packageName='Payız kampaniyası — 6–7 nəfər'; }
      else throw new Error('Qonaq sayı seçilmiş payız paketinə uyğun deyil.');
      packageRule='3 gecə / 4 gün, səhər yeməyi daxildir.';
    } else if (campaignCode === 'romantic_179' || campaignCode === 'honeymoon_349') {
      if (!aframeIds.includes(unit.id)) throw new Error('Romantik və balayı paketləri yalnız A-FRAME evlərində keçərlidir.');
      if (!marriageConfirmed || guestCount !== 2) throw new Error('Bu paketlər yalnız rəsmi nikahda olan 2 nəfərlik cütlüklər üçündür.');
      if (campaignCode === 'romantic_179') {
        if (nights !== 1) throw new Error('Romantik paket 1 gecə / 2 gün üçündür.');
        packagePrice=179; packageName='Romantik paket'; packageRule='1 gecə / 2 gün, 2 nəfərlik premium səhər yeməyi daxildir.';
      } else {
        if (nights !== 3) throw new Error('Balayı paketi 3 gecə / 4 gün üçündür.');
        packagePrice=349; packageName='Balayı paketi'; packageRule='3 gecə / 4 gün, 2 nəfər üçün xüsusi paket.'; breakfastIncluded=false;
      }
    } else throw new Error('Kampaniya paketi tanınmadı və ya aktiv deyil.');
    const breakfastTotal = breakfast && !breakfastIncluded ? Number(unit.breakfast_rate_per_person || 0) * Number(guestCount) * nights : 0;
    const total = Math.round((packagePrice + breakfastTotal) * 100) / 100;
    return { nights, stayTotal:packagePrice, breakfastTotal, total, campaignCode, campaignName:packageName, breakfastIncluded, ruleText:packageRule + (breakfastIncluded ? ' Səhər yeməyi daxildir.' : '') };
  }

  const nights = getNights(checkIn, checkOut);
  if (nights < 1 || nights > 30) throw new Error('Rezervasiya 1–30 gecə arasında olmalıdır.');
  const [holidayRes, seasonalRes] = await Promise.all([
    client.from('special_dates').select('date,label').eq('active', true).gte('date', checkIn).lt('date', checkOut),
    client.from('seasonal_rates').select('start_date,end_date,nightly_rate,weekday_rate,weekend_rate,label').eq('unit_id', unit.id).eq('active', true).lt('start_date', checkOut).gt('end_date', checkIn)
  ]);
  if (holidayRes.error) throw holidayRes.error;
  if (seasonalRes.error) throw seasonalRes.error;
  const holidays = new Map((holidayRes.data || []).map(r => [r.date, r.label || 'Bayram']));
  const seasonal = seasonalRes.data || [];
  let stayTotal = 0, sawHoliday = false, sawSeason = false, sawWeekend = false;
  for (let i = 0; i < nights; i++) {
    const d = new Date(Date.parse(`${checkIn}T00:00:00Z`) + i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    let rate;
    const matchingSeason = seasonal.find(s => s.start_date <= ds && ds < s.end_date);
    const weekend = [5, 6].includes(d.getUTCDay());
    if (holidays.has(ds)) {
      // Holiday pricing follows the weekend tariff, including the seasonal weekend tariff.
      rate = Number(matchingSeason?.weekend_rate ?? matchingSeason?.nightly_rate ?? unit.holiday_rate);
      sawHoliday = true;
    } else if (matchingSeason) {
      const seasonalRate = weekend ? matchingSeason.weekend_rate : matchingSeason.weekday_rate;
      rate = Number(seasonalRate ?? matchingSeason.nightly_rate);
      sawSeason = true;
      if (weekend) sawWeekend = true;
    } else if (weekend) { rate = Number(unit.weekend_rate); sawWeekend = true; }
    else rate = Number(unit.weekday_rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Bu ev üçün qiymət hələ düzgün qurulmayıb.');
    stayTotal += rate;
  }
  const breakfastTotal = breakfast ? Number(unit.breakfast_rate_per_person || 0) * Number(guestCount) * nights : 0;
  const total = Math.round((stayTotal + breakfastTotal) * 100) / 100;
  return {
    nights,
    stayTotal: Math.round(stayTotal * 100) / 100,
    breakfastTotal: Math.round(breakfastTotal * 100) / 100,
    total,
    ruleText: sawHoliday ? 'Bayram tarifi tətbiq olundu.' : sawSeason ? 'Mövsümi tarif tətbiq olundu.' : sawWeekend ? 'Həftəsonu tarifi tətbiq olundu.' : 'Standart tarif tətbiq olundu.'
  };
}

export function signEpoint(data, privateKey) {
  return crypto.createHash('sha1').update(`${privateKey}${data}${privateKey}`, 'utf8').digest('base64');
}

export function safeSignatureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
