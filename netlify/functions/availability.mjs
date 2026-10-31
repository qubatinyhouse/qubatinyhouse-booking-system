import { db, json, validDate, getNights, quoteForUnit } from '../lib/_lib.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Yalnız GET sorğusu qəbul edilir.' });
  try {
    const { checkIn, checkOut, guestCount = '2', unitType = 'small', breakfast = '0' } = event.queryStringParameters || {};
    if (!validDate(checkIn) || !validDate(checkOut) || getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30) {
      return json(400, { error: 'Düzgün giriş/çıxış tarixləri seçin. Rezervasiya 1–30 gecə ola bilər.' });
    }
    const guests = Number(guestCount);
    if (!Number.isInteger(guests) || guests < 1 || guests > 10) return json(400, { error: 'Qonaq sayı 1–10 arasında olmalıdır.' });
    if (!['small', 'large', 'aframe'].includes(unitType)) return json(400, { error: 'Ev növü düzgün seçilməyib.' });
    const client = db();
    const [unitsRes, bookingsRes, blockedRes] = await Promise.all([
  client.from('units').select('id,name,unit_type,capacity,weekday_rate,weekend_rate'),
  client.from('reservations').select('unit_id,check_in,check_out,status,expires_at'),
  client.from('blocked_dates').select('unit_id,check_in,check_out,active')
]);
    if (unitsRes.error) throw unitsRes.error;
    if (bookingsRes.error) throw bookingsRes.error;
    if (blockedRes.error) throw blockedRes.error;
    const now = Date.now();
    const conflicts = (bookingsRes.data || []).filter(b => b.status === 'confirmed' || (b.status === 'pending_payment' && Date.parse(b.expires_at) > now));
    const blockedDates = (blockedRes.data || []).filter(
  b => b.active === true
);
    const units = (await Promise.all((unitsRes.data || []).map(async unit => {
      const busy =
  conflicts.some(
    b => b.unit_id === unit.id &&
         b.check_in < checkOut &&
         b.check_out > checkIn
  ) ||
  blockedDates.some(
    b => b.unit_id === unit.id &&
         b.check_in < checkOut &&
         b.check_out > checkIn
  );
      if (busy) return null;
      let quote = null;
      try { quote = await quoteForUnit(client, unit, checkIn, checkOut, guests, breakfast === '1'); }
      catch (e) { return { id: unit.id, name: unit.name, unitType: unit.unit_type, capacity: unit.capacity, available: !busy, isDemoRate: unit.is_demo_rate, quote: null, pricingError: e.message }; }
      return { id: unit.id, name: unit.name, unitType: unit.unit_type, capacity: unit.capacity, available: !busy, isDemoRate: unit.is_demo_rate, quote };
    }))).filter(Boolean);
    return json(200, { checkIn, checkOut, guestCount: guests, units });
  } catch (e) {
    console.error('availability error', e);
    return json(503, { error: e.message || 'Mövcudluq yoxlanarkən texniki xəta oldu.' });
  }
};
