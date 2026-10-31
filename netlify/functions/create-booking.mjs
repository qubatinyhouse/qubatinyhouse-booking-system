import { db, json, validDate, getNights, quoteForUnit } from '../lib/_lib.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Yalnız POST sorğusu qəbul edilir.' });
  let input;
  try { input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); } catch { return json(400, { error: 'Sorğu formatı düzgün deyil.' }); }
  const { unitId, checkIn, checkOut, guestName, phone, guestCount, note, depositPercent, campaignCode = '', marriageConfirmed = false } = input;
  if (!unitId || !validDate(checkIn) || !validDate(checkOut) || getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30) return json(400, { error: 'Ev və düzgün giriş/çıxış tarixlərini seçin.' });
  if (typeof guestName !== 'string' || guestName.trim().length < 2 || guestName.length > 120) return json(400, { error: 'Ad və soyadı düzgün daxil edin.' });
  if (typeof phone !== 'string' || phone.replace(/\D/g, '').length < 7 || phone.length > 30) return json(400, { error: 'Telefon nömrəsini düzgün daxil edin.' });
  if (!Number.isInteger(Number(guestCount)) || Number(guestCount) < 1 || Number(guestCount) > 10) return json(400, { error: 'Qonaq sayı düzgün deyil.' });
  if (Number(depositPercent) !== 50) return json(400, { error: 'Standart beh faizi 50% olmalıdır.' });
  try {
    const client = db();
    const { data: unit, error: unitError } = await client.from('units').select('*').eq('id', unitId).eq('active', true).maybeSingle();
    if (unitError) throw unitError;
    if (!unit) return json(404, { error: 'Seçilmiş ev tapılmadı. Mövcudluğu yenidən yoxlayın.' });
    if (Number(guestCount) > unit.capacity) return json(400, { error: `Bu ev maksimum ${unit.capacity} nəfər üçündür.` });
    if (unit.is_demo_rate) return json(409, { error: 'Saytın tarifləri hələ nümunə qiymətlərdədir. Real tarifləri təsdiqlədikdən sonra admin onları aktivləşdirməlidir.' });
    if (typeof campaignCode !== 'string' || campaignCode.length > 40) return json(400, { error: 'Kampaniya seçimi düzgün deyil.' });
    if (['romantic_179','honeymoon_349'].includes(campaignCode) && marriageConfirmed !== true) return json(400, { error: 'Bu paketlər yalnız rəsmi nikahda olan cütlüklər üçündür.' });
    const quote = await quoteForUnit(client, unit, checkIn, checkOut, Number(guestCount), false, campaignCode, marriageConfirmed === true);
    if (quote.total < 50) return json(400, { error: 'Rezervasiyanın ümumi məbləği minimum 50 AZN olmalıdır.' });
    const deposit = Math.max(50, Math.round(quote.total * 0.50 * 100) / 100);
    const remaining = Math.round((quote.total - deposit) * 100) / 100;
    const rpc = await client.rpc('create_booking_atomic', {
      p_unit_id: unit.id,
      p_check_in: checkIn,
      p_check_out: checkOut,
      p_guest_name: guestName.trim(),
      p_phone: phone.trim(),
      p_guest_count: Number(guestCount),
      p_breakfast: false,
      p_note: (campaignCode ? `[[QTH_CAMPAIGN=${campaignCode};MARRIED=${marriageConfirmed ? 1 : 0}]]\n` : '') + (typeof note === 'string' ? note.slice(0, 1300) : ''),
      p_stay_amount: quote.stayTotal,
      p_breakfast_amount: 0,
      p_total_amount: quote.total,
      p_deposit_percent: 50,
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
    return json(201, {
      success: true,
      bookingCode: row.booking_code,
      message: 'Rezervasiya sorğunuz qeydə alındı. WhatsApp-da menecerdən minimum 50 AZN beh üçün kart məlumatlarını istəyin.',
      totalAmount: quote.total,
      depositAmount: deposit,
      remainingAmount: remaining,
      currency: 'AZN',
      campaignCode: quote.campaignCode || null,
      campaignName: quote.campaignName || null
    });
  } catch (e) {
    console.error('create-booking error', e);
    return json(500, { error: e.message || 'Rezervasiyanı yaratmaq mümkün olmadı.' });
  }
};
