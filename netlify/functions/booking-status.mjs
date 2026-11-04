import { db, json } from '../lib/_lib.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Yalnız GET sorğusu qəbul edilir.' });
  const code = String(event.queryStringParameters?.code || '').trim().slice(0, 80).toUpperCase();
  if (!/^QTH-[A-F0-9]{10}$/.test(code)) return json(400, { error: 'Bron kodunu QTH-XXXXXXXXXX formatında daxil edin.' });

  try {
    const client = db();
    const { data, error } = await client.from('reservations')
      .select('booking_code,status,payment_status,deposit_amount,total_amount,paid_amount,remaining_amount,unit_id,check_in,check_out')
      .eq('booking_code', code)
      .maybeSingle();
    if (error) throw error;
    if (!data) return json(404, { error: 'Bu bron kodu ilə rezervasiya tapılmadı.' });

    const { data: unit, error: unitError } = await client.from('units')
      .select('name').eq('id', data.unit_id).maybeSingle();
    if (unitError) throw unitError;

    const statusLabels = {
      pending_payment: 'Avans gözlənilir',
      confirmed: 'Təsdiqlənib',
      expired: 'Ödəniş vaxtı bitib',
      cancelled: 'Ləğv edilib',
      payment_failed: 'Ödəniş tamamlanmayıb',
      payment_review: 'Ödəniş yoxlanılır'
    };
    return json(200, {
      bookingCode: data.booking_code,
      status: data.status,
      statusLabel: statusLabels[data.status] || data.status,
      paymentStatus: data.payment_status,
      unitName: unit?.name || '',
      checkIn: data.check_in,
      checkOut: data.check_out,
      depositAmount: Number(data.deposit_amount || 0),
      totalAmount: Number(data.total_amount || 0),
      paidAmount: Number(data.paid_amount || 0),
      remainingAmount: Number(data.remaining_amount || 0)
    });
  } catch (error) {
    console.error('booking status error', { message: error?.message, code: error?.code });
    return json(503, { error: 'Rezervasiya statusunu yoxlamaq mümkün olmadı.' });
  }
};
