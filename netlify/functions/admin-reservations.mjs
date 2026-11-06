import { db, json, validDate, getNights, requireQthAdmin } from '../lib/_lib.mjs';

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
        totalAmount, paidAmount = 0, paymentMethod = 'bank', paymentDate = null,
        paymentRequestId = null
      } = body;
      const guests = Number(guestCount);
      const total = Number(totalAmount);
      const paid = Number(paidAmount || 0);
      const allowedUnits = ['scandi-large-1','scandi-large-2','scandi-small-1','scandi-small-2','aframe-1','aframe-2'];
      if (!allowedUnits.includes(unitId) || !validDate(checkIn) || !validDate(checkOut) ||
          getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30 ||
          typeof guestName !== 'string' || guestName.trim().length < 2 || guestName.length > 120 ||
          typeof phone !== 'string' || phone.replace(/\D/g, '').length < 7 || phone.length > 30 ||
          !Number.isInteger(guests) || guests < 1 || guests > 10 ||
          !Number.isFinite(total) || total <= 0 || !Number.isFinite(paid) || paid < 0 || paid > total) {
        return json(400, { error: 'Müştəri, ev, qonaq sayı, ödəniş və tarixləri düzgün daxil edin. Qalma müddəti 1–30 gecə olmalıdır.' });
      }

      const { data: unit, error: unitError } = await client.from('units')
        .select('*').eq('id', unitId).eq('active', true).maybeSingle();
      if (unitError) throw unitError;
      if (!unit) return json(404, { error: 'Seçilmiş ev tapılmadı və ya aktiv deyil.' });
      if (guests > Number(unit.capacity)) return json(400, { error: 'Bu ev maksimum ' + unit.capacity + ' nəfər üçündür.' });
      // Admin-created reservations use the manager-entered amount, not the public tariff table.

      const { data: blocks, error: blockError } = await client.from('blocked_dates')
        .select('id').eq('unit_id', unitId).eq('active', true)
        .lt('check_in', checkOut).gt('check_out', checkIn).limit(1);
      if (blockError) throw blockError;
      if (blocks?.length) return json(409, { error: 'Seçilmiş tarixlər admin təqvimində bağlıdır. Əvvəl təqvimi yoxlayın.' });

      const deposit = paid;
      const remaining = Math.round((total - paid) * 100) / 100;

      const rpc = await client.rpc('create_admin_booking_atomic', {
        p_unit_id: unit.id,
        p_check_in: checkIn,
        p_check_out: checkOut,
        p_guest_name: guestName.trim(),
        p_phone: phone.trim(),
        p_guest_count: guests,
        p_note: typeof note === 'string' ? note.slice(0, 1300) : '',
        p_total_amount: total,
        p_paid_amount: paid
      });
      if (rpc.error) {
        const message = rpc.error.message || '';
        if (/DATES_ALREADY_BOOKED|already booked|conflict|overlap/i.test(message))
          return json(409, { error: 'Bu ev seçilmiş tarixlərdə artıq rezervasiya olunub.' });
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
        quote: { nights: getNights(checkIn, checkOut), total, deposit, remaining, ruleText: 'Admin tərəfindən daxil edilmiş məbləğ' }
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


      if (action === 'reservation_update') {
        const { data: current, error: currentError } = await client.from('reservations')
          .select('id,unit_id,check_in,check_out,guest_count,total_amount,paid_amount,status')
          .eq('id', id).single();
        if (currentError) throw currentError;
        const unitId = String(body.unitId || '');
        const checkIn = String(body.checkIn || '');
        const checkOut = String(body.checkOut || '');
        const guestCount = Number(body.guestCount);
        const totalAmount = Number(body.totalAmount);
        const changeMode = String(body.changeMode || 'modify');
        const allowedUnits = ['scandi-large-1','scandi-large-2','scandi-small-1','scandi-small-2','aframe-1','aframe-2'];
        if (!allowedUnits.includes(unitId) || !validDate(checkIn) || !validDate(checkOut) ||
            getNights(checkIn, checkOut) < 1 || getNights(checkIn, checkOut) > 30 ||
            !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 10 ||
            !Number.isFinite(totalAmount) || totalAmount < Number(current.paid_amount || 0) ||
            !['modify','early_checkout'].includes(changeMode)) {
          return json(400, { error: 'Ev, tarix, qonaq sayı və yeni ümumi məbləği düzgün daxil edin. Məbləğ ödənilmiş məbləğdən az ola bilməz.' });
        }
        if (['cancelled','expired'].includes(current.status)) {
          return json(409, { error: 'Ləğv edilmiş və ya vaxtı bitmiş rezervasiya dəyişdirilə bilməz.' });
        }
        if (changeMode === 'early_checkout' && checkOut >= current.check_out) {
          return json(400, { error: 'Vaxtından əvvəl çıxış tarixi əvvəlki çıxış tarixindən tez olmalıdır.' });
        }
        const { data: updatedRows, error: updateError } = await client.rpc('qth_admin_update_reservation', {
          p_reservation_id: id,
          p_admin_id: admin.id,
          p_unit_id: unitId,
          p_check_in: checkIn,
          p_check_out: checkOut,
          p_guest_count: guestCount,
          p_total_amount: totalAmount,
          p_change_mode: changeMode,
          p_reason: typeof body.reason === 'string' ? body.reason.slice(0,500) : ''
        });
        if (updateError) {
          const message = updateError.message || '';
          if (/DATES_ALREADY_BOOKED|overlap|conflict|BLOCKED_DATES/i.test(message))
            return json(409, { error: 'Seçilmiş ev və tarixlərdə başqa rezervasiya və ya bağlı gün mövcuddur.' });
          if (/UNIT_CAPACITY/i.test(message))
            return json(400, { error: 'Qonaq sayı seçilmiş evin tutumundan çoxdur.' });
          if (/PAID_AMOUNT_EXCEEDS_TOTAL/i.test(message))
            return json(400, { error: 'Yeni ümumi məbləğ artıq ödənilmiş məbləğdən az ola bilməz.' });
          throw updateError;
        }
        const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
        return json(200, { success: true, reservation: updated });
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
