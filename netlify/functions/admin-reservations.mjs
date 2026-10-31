import { db, json, validDate, getNights, quoteForUnit } from '../lib/_lib.mjs';

const allowedStatuses = new Set([
  'pending_payment',
  'confirmed',
  'expired',
  'cancelled',
  'payment_failed',
  'payment_review'
]);

export const handler = async (event) => {
  const expectedToken = process.env.ADMIN_API_TOKEN;
  const suppliedToken = event.headers?.['x-admin-token'] || event.headers?.['X-Admin-Token'];

  if (!expectedToken || !suppliedToken || suppliedToken !== expectedToken) {
    return json(401, { error: 'Admin icazəsi tələb olunur.' });
  }

  try {
    const client = db();


    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Yanlış JSON formatı.' }); }

      const { unitId, checkIn, checkOut, guestName, phone, guestCount, note = '', campaignCode = '', marriageConfirmed = false } = body;
      const guests = Number(guestCount);
      const allowedUnits = ['scandi-large-1','scandi-large-2','scandi-small-1','scandi-small-2','aframe-1','aframe-2'];
      if (!allowedUnits.includes(unitId) || !validDate(checkIn) || !validDate(checkOut) ||
          getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30 ||
          typeof guestName !== 'string' || guestName.trim().length < 2 || guestName.length > 120 ||
          typeof phone !== 'string' || phone.replace(/\D/g, '').length < 7 || phone.length > 30 ||
          !Number.isInteger(guests) || guests < 1 || guests > 10) {
        return json(400, { error: 'Müştəri, ev, qonaq sayı və tarixləri düzgün daxil edin. Qalma müddəti 1–30 gecə olmalıdır.' });
      }

      const { data: unit, error: unitError } = await client.from('units')
        .select('*').eq('id', unitId).eq('active', true).maybeSingle();
      if (unitError) throw unitError;
      if (!unit) return json(404, { error: 'Seçilmiş ev tapılmadı və ya aktiv deyil.' });
      if (guests > Number(unit.capacity)) return json(400, { error: 'Bu ev maksimum ' + unit.capacity + ' nəfər üçündür.' });
      if (typeof campaignCode !== 'string' || campaignCode.length > 40) return json(400, { error: 'Kampaniya seçimi düzgün deyil.' });
      if (['romantic_179','honeymoon_349'].includes(campaignCode) && marriageConfirmed !== true) return json(400, { error: 'Bu paketlər yalnız rəsmi nikahda olan cütlüklər üçündür.' });
      if (unit.is_demo_rate) return json(409, { error: 'Bu evin real tarifi aktiv deyil.' });

      const { data: blocks, error: blockError } = await client.from('blocked_dates')
        .select('id').eq('unit_id', unitId).eq('active', true)
        .lt('check_in', checkOut).gt('check_out', checkIn).limit(1);
      if (blockError) throw blockError;
      if (blocks && blocks.length) return json(409, { error: 'Seçilmiş tarixlər admin təqvimində bağlıdır. Əvvəl təqvimi yoxlayın.' });

      const quote = await quoteForUnit(client, unit, checkIn, checkOut, guests, false, campaignCode, marriageConfirmed === true);
      if (quote.total < 50) return json(400, { error: 'Rezervasiyanın ümumi məbləği minimum 50 AZN olmalıdır.' });
      const deposit = Math.max(50, Math.round(quote.total * 0.50 * 100) / 100);
      const remaining = Math.round((quote.total - deposit) * 100) / 100;

      const rpc = await client.rpc('create_booking_atomic', {
        p_unit_id: unit.id,
        p_check_in: checkIn,
        p_check_out: checkOut,
        p_guest_name: guestName.trim(),
        p_phone: phone.trim(),
        p_guest_count: guests,
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
        const message = rpc.error.message || '';
        if (/DATES_ALREADY_BOOKED|already booked|conflict|overlap/i.test(message))
          return json(409, { error: 'Bu ev seçilmiş tarixlərdə artıq rezervasiya olunub.' });
        if (/RATES_NOT_CONFIGURED/i.test(message))
          return json(409, { error: 'Bu evin qiymətləri aktiv deyil.' });
        throw rpc.error;
      }
      const created = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
      if (!created || !created.id) throw new Error('Rezervasiya yaradıldı, lakin ID qaytarılmadı.');

      // Manual admin bookings are confirmed by the operator; keep expires_at non-null
      // because the database schema requires it. "manual" does not imply a card payment.
      const { data: confirmed, error: confirmError } = await client.from('reservations')
        .update({ status: 'confirmed', payment_status: 'manual' })
        .eq('id', created.id)
        .select('id,booking_code,status,payment_status,total_amount,deposit_amount,remaining_amount,campaign_code,campaign_name,marriage_confirmed')
        .single();
      if (confirmError) throw confirmError;

      return json(201, {
        success: true,
        reservation: confirmed,
        quote: { nights: quote.nights, total: quote.total, deposit, remaining, campaignCode: quote.campaignCode || null, campaignName: quote.campaignName || null, ruleText: quote.ruleText }
      });
    }

    if (event.httpMethod === 'GET') {
      const { data: reservations, error, count } = await client
        .from('reservations')
        .select('id,booking_code,unit_id,check_in,check_out,guest_name,phone,guest_count,note,total_amount,deposit_amount,remaining_amount,paid_amount,status,payment_status,campaign_code,campaign_name,marriage_confirmed,created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) throw error;
      const reservationIds = (reservations || []).map((item) => item.id);
      const { data: coupons, error: couponsError } = reservationIds.length
        ? await client.from('promo_coupons').select('reservation_id,coupon_code,status').in('reservation_id', reservationIds)
        : { data: [], error: null };
      if (couponsError) throw couponsError;
      const couponByReservation = new Map((coupons || []).map((item) => [item.reservation_id, item]));

      const { data: units, error: unitsError } = await client
        .from('units')
        .select('id,name');

      if (unitsError) throw unitsError;

      const unitNames = new Map((units || []).map((unit) => [unit.id, unit.name]));

      return json(200, {
        totalCount: count ?? (reservations || []).length,
        reservations: (reservations || []).map((item) => ({
          ...item,
          coupon_code: couponByReservation.get(item.id)?.coupon_code || null,
          coupon_status: couponByReservation.get(item.id)?.status || null,
          unit_name: unitNames.get(item.unit_id) || item.unit_id
        }))
      });
    }

    if (event.httpMethod === 'PATCH') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Yanlış JSON formatı.' }); }

      const { id, status } = body;
      if (!id || !allowedStatuses.has(status)) {
        return json(400, { error: 'Rezervasiya ID-si və düzgün status tələb olunur.' });
      }

      if (status === 'confirmed') {
        const amount = Number(body.amount);
        const paymentMethod = String(body.paymentMethod || '');
        if (!Number.isFinite(amount) || amount <= 0 || !['cash','bank','card','transfer'].includes(paymentMethod)) {
          return json(400, { error: 'Faktiki ödəniş məbləği və ödəniş üsulu düzgün daxil edilməlidir.' });
        }
        const { data, error } = await client.rpc('confirm_manual_paid_booking', {
          p_reservation_id: id,
          p_paid_amount: amount,
          p_payment_method: paymentMethod
        });
        if (error) throw error;
        const { data: paidReservation, error: reservationError } = await client
          .from('reservations')
          .select('id,booking_code,guest_name,phone,unit_id,check_in,check_out,total_amount,deposit_amount,remaining_amount,status,payment_status,paid_amount,paid_at')
          .eq('id', id)
          .single();
        if (reservationError) throw reservationError;
        return json(200, { reservation: { ...paidReservation, payment_method: paymentMethod } });
      }

      const { data, error } = await client
        .from('reservations')
        .update({ status })
        .eq('id', id)
        .select('id,status,payment_status,paid_amount,paid_at')
        .single();

      if (error) throw error;
      return json(200, { reservation: data });
    }

    return json(405, { error: 'Yalnız GET, POST və PATCH sorğuları qəbul edilir.' });
  } catch (error) {
    console.error('admin reservations error', { message: error?.message, code: error?.code, details: error?.details, hint: error?.hint });
    const safeMessage = typeof error?.message === 'string' ? error.message.slice(0, 240) : 'Naməlum server xətası.';
    return json(503, { error: 'Server xətası: ' + safeMessage, code: error?.code || null });
  }
};
