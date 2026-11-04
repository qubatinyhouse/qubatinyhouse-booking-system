import { db, json, validDate, getNights, quoteForUnit, requireQthAdmin } from '../lib/_lib.mjs';

const allowedStatuses = new Set([
  'pending_payment','confirmed','expired','cancelled','payment_failed','payment_review'
]);
const allowedPaymentMethods = new Set(['cash','bank','card','transfer']);
const allowedPaymentTypes = new Set(['deposit','remaining','other']);

export const handler = async (event) => {
  const admin = await requireQthAdmin(event);
  if (!admin) return json(401, { error: 'Admin sessiyası etibarlı deyil. Yenidən daxil olun.' });

  try {
    const client = db();

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Yanlış JSON formatı.' }); }

      const {
        unitId, checkIn, checkOut, guestName, phone, guestCount, note = '',
        paidAmount = 0, paymentMethod = 'bank', paymentDate = null,
        paymentRequestId = null
      } = body;
      const guests = Number(guestCount);
      const paid = Number(paidAmount || 0);
      const allowedUnits = ['scandi-large-1','scandi-large-2','scandi-small-1','scandi-small-2','aframe-1','aframe-2'];
      if (!allowedUnits.includes(unitId) || !validDate(checkIn) || !validDate(checkOut) ||
          getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30 ||
          typeof guestName !== 'string' || guestName.trim().length < 2 || guestName.length > 120 ||
          typeof phone !== 'string' || phone.replace(/\D/g, '').length < 7 || phone.length > 30 ||
          !Number.isInteger(guests) || guests < 1 || guests > 10 ||
          !Number.isFinite(paid) || paid < 0) {
        return json(400, { error: 'Müştəri, ev, qonaq sayı, ödəniş və tarixləri düzgün daxil edin. Qalma müddəti 1–30 gecə olmalıdır.' });
      }

      const { data: unit, error: unitError } = await client.from('units')
        .select('*').eq('id', unitId).eq('active', true).maybeSingle();
      if (unitError) throw unitError;
      if (!unit) return json(404, { error: 'Seçilmiş ev tapılmadı və ya aktiv deyil.' });
      if (guests > Number(unit.capacity)) return json(400, { error: 'Bu ev maksimum ' + unit.capacity + ' nəfər üçündür.' });
      if (unit.is_demo_rate) return json(409, { error: 'Bu evin real tarifi aktiv deyil.' });

      const { data: blocks, error: blockError } = await client.from('blocked_dates')
        .select('id').eq('unit_id', unitId).eq('active', true)
        .lt('check_in', checkOut).gt('check_out', checkIn).limit(1);
      if (blockError) throw blockError;
      if (blocks?.length) return json(409, { error: 'Seçilmiş tarixlər admin təqvimində bağlıdır. Əvvəl təqvimi yoxlayın.' });

      const quote = await quoteForUnit(client, unit, checkIn, checkOut, guests, false, '', false);
      if (quote.total < 50) return json(400, { error: 'Rezervasiyanın ümumi məbləği minimum 50 AZN olmalıdır.' });
      const deposit = Math.max(50, Math.round(quote.total * 0.50 * 100) / 100);
      const remaining = Math.round((quote.total - deposit) * 100) / 100;
      if (paid > quote.total) return json(400, { error: 'Daxil edilən ödəniş ümumi məbləğdən çox ola bilməz.' });
      if (paid > 0 && !allowedPaymentMethods.has(String(paymentMethod))) {
        return json(400, { error: 'Ödəniş üsulunu düzgün seçin.' });
      }

      const rpc = await client.rpc('create_booking_atomic', {
        p_unit_id: unit.id,
        p_check_in: checkIn,
        p_check_out: checkOut,
        p_guest_name: guestName.trim(),
        p_phone: phone.trim(),
        p_guest_count: guests,
        p_breakfast: false,
        p_note: typeof note === 'string' ? note.slice(0, 1300) : '',
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
      if (!created?.id) throw new Error('Rezervasiya yaradıldı, lakin ID qaytarılmadı.');

      let payment = null;
      let paymentResult = null;
      if (paid > 0) {
        const { data: paymentRows, error: paymentError } = await client.rpc('record_reservation_payment', {
          p_reservation_id: created.id,
          p_amount: paid,
          p_payment_type: 'deposit',
          p_payment_method: paymentMethod,
          p_payment_date: validDate(paymentDate) ? paymentDate : new Date().toISOString().slice(0,10),
          p_notes: 'Admin paneldən yaradılan rezervasiya üzrə ilkin ödəniş',
          p_request_key: paymentRequestId || null,
          p_transaction_reference: null
        });
        if (paymentError) throw paymentError;
        paymentResult = Array.isArray(paymentRows) ? paymentRows[0] : paymentRows;
        if (paymentResult?.payment_id) {
          const { data: p, error: pError } = await client.from('reservation_payments')
            .select('id,reservation_id,amount,payment_type,payment_method,payment_date,notes,created_at')
            .eq('id', paymentResult.payment_id).single();
          if (pError) throw pError;
          payment = p;
        }
      }

      const { data: reservation, error: reservationError } = await client.from('reservations')
        .select('id,booking_code,unit_id,check_in,check_out,guest_name,phone,guest_count,note,total_amount,deposit_amount,remaining_amount,paid_amount,paid_at,status,payment_status,campaign_code,campaign_name,marriage_confirmed,created_at')
        .eq('id', created.id).single();
      if (reservationError) throw reservationError;

      return json(201, {
        success: true,
        reservation,
        payment,
        paymentResult,
        quote: { nights: quote.nights, total: quote.total, deposit, remaining, ruleText: quote.ruleText }
      });
    }

    if (event.httpMethod === 'GET') {
      const { data: reservations, error, count } = await client
        .from('reservations')
        .select('id,booking_code,unit_id,check_in,check_out,guest_name,phone,guest_count,note,total_amount,deposit_amount,remaining_amount,paid_amount,paid_at,status,payment_status,campaign_code,campaign_name,marriage_confirmed,created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      const reservationIds = (reservations || []).map((item) => item.id);
      const [paymentsResult, couponsResult, unitsResult] = await Promise.all([
        reservationIds.length
          ? client.from('reservation_payments')
              .select('id,reservation_id,amount,payment_type,payment_method,payment_date,notes,created_at')
              .in('reservation_id', reservationIds)
              .order('payment_date', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        reservationIds.length
          ? client.from('promo_coupons').select('reservation_id,coupon_code,status').in('reservation_id', reservationIds)
          : Promise.resolve({ data: [], error: null }),
        client.from('units').select('id,name')
      ]);
      if (paymentsResult.error) throw paymentsResult.error;
      if (couponsResult.error) throw couponsResult.error;
      if (unitsResult.error) throw unitsResult.error;

      const paymentsByReservation = new Map();
      for (const payment of paymentsResult.data || []) {
        const list = paymentsByReservation.get(payment.reservation_id) || [];
        list.push(payment);
        paymentsByReservation.set(payment.reservation_id, list);
      }
      const couponByReservation = new Map((couponsResult.data || []).map((item) => [item.reservation_id, item]));
      const unitNames = new Map((unitsResult.data || []).map((unit) => [unit.id, unit.name]));

      return json(200, {
        totalCount: count ?? (reservations || []).length,
        reservations: (reservations || []).map((item) => ({
          ...item,
          payments: paymentsByReservation.get(item.id) || [],
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

      const { id, status, action } = body;
      if (!id) return json(400, { error: 'Rezervasiya ID-si tələb olunur.' });

      if (action === 'payment') {
        const amount = Number(body.amount);
        const paymentType = String(body.paymentType || 'deposit');
        const paymentMethod = String(body.paymentMethod || '');
        const paymentDate = validDate(body.paymentDate) ? body.paymentDate : new Date().toISOString().slice(0,10);
        if (!Number.isFinite(amount) || amount <= 0 || !allowedPaymentTypes.has(paymentType) || !allowedPaymentMethods.has(paymentMethod)) {
          return json(400, { error: 'Ödəniş məbləği, növü və üsulu düzgün daxil edilməlidir.' });
        }
        const { data: rows, error } = await client.rpc('record_reservation_payment', {
          p_reservation_id: id,
          p_amount: amount,
          p_payment_type: paymentType,
          p_payment_method: paymentMethod,
          p_payment_date: paymentDate,
          p_notes: typeof body.notes === 'string' ? body.notes.slice(0,500) : '',
          p_request_key: body.requestKey || null,
          p_transaction_reference: body.transactionReference || null
        });
        if (error) throw error;
        const result = Array.isArray(rows) ? rows[0] : rows;
        const { data: reservation, error: reservationError } = await client.from('reservations')
          .select('id,booking_code,unit_id,check_in,check_out,guest_name,phone,guest_count,total_amount,deposit_amount,remaining_amount,paid_amount,paid_at,status,payment_status')
          .eq('id', id).single();
        if (reservationError) throw reservationError;
        const { data: payment, error: paymentError } = result?.payment_id
          ? await client.from('reservation_payments')
              .select('id,reservation_id,amount,payment_type,payment_method,payment_date,notes,created_at')
              .eq('id', result.payment_id).single()
          : { data: null, error: null };
        if (paymentError) throw paymentError;
        return json(200, { reservation, payment, paymentResult: result });
      }

      if (!allowedStatuses.has(status) || status === 'confirmed') {
        return json(400, { error: 'Təsdiq yalnız faktiki ödəniş qeydə alındıqda mümkündür. Ödəniş əlavə edin.' });
      }

      const { data, error } = await client.from('reservations')
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
