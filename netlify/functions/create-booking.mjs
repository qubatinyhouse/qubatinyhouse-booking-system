import { db, json, validDate, getNights, quoteForUnit, signEpoint } from '../lib/_lib.mjs';

const SITE_URL = () => (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Yalnız POST sorğusu qəbul edilir.' });
  let input;
  try { input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); } catch { return json(400, { error: 'Sorğu formatı düzgün deyil.' }); }
  const { unitId, checkIn, checkOut, guestName, phone, guestCount, breakfast, note, depositPercent } = input;
  if (!unitId || !validDate(checkIn) || !validDate(checkOut) || getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30) return json(400, { error: 'Ev və düzgün giriş/çıxış tarixlərini seçin.' });
  if (typeof guestName !== 'string' || guestName.trim().length < 2 || guestName.length > 120) return json(400, { error: 'Ad və soyadı düzgün daxil edin.' });
  if (typeof phone !== 'string' || phone.replace(/\D/g, '').length < 7 || phone.length > 30) return json(400, { error: 'Telefon nömrəsini düzgün daxil edin.' });
  if (!Number.isInteger(Number(guestCount)) || Number(guestCount) < 1 || Number(guestCount) > 10) return json(400, { error: 'Qonaq sayı düzgün deyil.' });
  if (![30, 40].includes(Number(depositPercent))) return json(400, { error: 'Avans faizi 30% və ya 40% olmalıdır.' });
  if (!process.env.EPOINT_PUBLIC_KEY || !process.env.EPOINT_PRIVATE_KEY) return json(503, { error: 'Onlayn ödəniş hələ aktiv deyil. Epoint merchant hesabı və açarları Netlify Environment Variables bölməsinə əlavə olunmalıdır.' });
  if (!SITE_URL()) return json(503, { error: 'SITE_URL Netlify-də təyin edilməyib.' });
  try {
    const client = db();
    const { data: unit, error: unitError } = await client.from('units').select('*').eq('id', unitId).eq('active', true).maybeSingle();
    if (unitError) throw unitError;
    if (!unit) return json(404, { error: 'Seçilmiş ev tapılmadı. Mövcudluğu yenidən yoxlayın.' });
    if (Number(guestCount) > unit.capacity) return json(400, { error: `Bu ev maksimum ${unit.capacity} nəfər üçündür.` });
    if (unit.is_demo_rate) return json(409, { error: 'Saytın tarifləri hələ nümunə qiymətlərdədir. Real tarifləri təsdiqlədikdən sonra admin onları aktivləşdirməlidir.' });
    const quote = await quoteForUnit(client, unit, checkIn, checkOut, Number(guestCount), Boolean(breakfast));
    const deposit = Math.round(quote.total * Number(depositPercent)) / 100;
    const remaining = Math.round((quote.total - deposit) * 100) / 100;
    const rpc = await client.rpc('create_booking_atomic', {
      p_unit_id: unit.id,
      p_check_in: checkIn,
      p_check_out: checkOut,
      p_guest_name: guestName.trim(),
      p_phone: phone.trim(),
      p_guest_count: Number(guestCount),
      p_breakfast: Boolean(breakfast),
      p_note: typeof note === 'string' ? note.slice(0, 1500) : '',
      p_stay_amount: quote.stayTotal,
      p_breakfast_amount: quote.breakfastTotal,
      p_total_amount: quote.total,
      p_deposit_percent: Number(depositPercent),
      p_deposit_amount: deposit,
      p_remaining_amount: remaining
    });
    if (rpc.error) {
      const msg = rpc.error.message || '';
      if (/already booked|conflict|overlap|not available/i.test(msg)) return json(409, { error: 'Bu tarixlər yenicə tutulub. Başqa tarix seçib yenidən yoxlayın.' });
      if (/RATES_NOT_CONFIGURED/i.test(msg)) return json(409, { error: 'Bu evin qiymətləri hələ aktivləşdirilməyib.' });
      throw rpc.error;
    }
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    if (!row?.booking_code) throw new Error('Rezervasiya kodu yaradılmadı.');
    const payload = {
      public_key: process.env.EPOINT_PUBLIC_KEY,
      amount: deposit.toFixed(2),
      currency: 'AZN',
      language: 'az',
      order_id: row.booking_code,
      description: `Quba Tiny House rezervasiya avansı (${depositPercent}%)`,
      success_redirect_url: `${SITE_URL()}/payment-success.html?code=${encodeURIComponent(row.booking_code)}`,
      error_redirect_url: `${SITE_URL()}/payment-error.html?code=${encodeURIComponent(row.booking_code)}`,
      result_url: `${SITE_URL()}/.netlify/functions/epoint-callback`
    };
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const signature = signEpoint(data, process.env.EPOINT_PRIVATE_KEY);
    const form = new URLSearchParams({ data, signature });
    const paymentResponse = await fetch(process.env.EPOINT_REQUEST_URL || 'https://epoint.az/api/1/request', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString()
    });
    const paymentText = await paymentResponse.text();
    let payment;
    try { payment = JSON.parse(paymentText); } catch { throw new Error('Epoint-dən düzgün cavab alınmadı. Ödəniş provayderinin hesabını yoxlayın.'); }
    if (!paymentResponse.ok || payment.status !== 'success' || !payment.redirect_url) {
      await client.from('reservations').update({ status: 'payment_failed', payment_error: String(payment.message || 'Epoint request failed').slice(0, 500) }).eq('booking_code', row.booking_code);
      return json(502, { error: payment.message || 'Ödəniş linki yaradıla bilmədi. Bir az sonra yenidən cəhd edin.' });
    }
    const upd = await client.from('reservations').update({ payment_transaction: payment.transaction || null }).eq('booking_code', row.booking_code);
    if (upd.error) console.error('payment transaction update failed', upd.error);
    return json(200, { checkoutUrl: payment.redirect_url, bookingCode: row.booking_code, depositAmount: deposit, currency: 'AZN' });
  } catch (e) {
    console.error('create-booking error', e);
    return json(500, { error: e.message || 'Rezervasiyanı yaratmaq mümkün olmadı.' });
  }
};
