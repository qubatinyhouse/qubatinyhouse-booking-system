import { db, json } from '../lib/_lib.mjs';
export const handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Yalnız GET sorğusu qəbul edilir.' });
  const code = String(event.queryStringParameters?.code || '').slice(0, 80);
  if (!/^QTH-[A-F0-9]{10}$/i.test(code)) return json(400, { error: 'Rezervasiya kodu düzgün deyil.' });
  try {
    const { data, error } = await db().from('reservations').select('booking_code,status,deposit_amount,total_amount,remaining_amount,unit_id,check_in,check_out').eq('booking_code', code).maybeSingle();
    if (error) throw error;
    if (!data) return json(404, { error: 'Rezervasiya tapılmadı.' });
    const { data: unit } = await db().from('units').select('name').eq('id', data.unit_id).maybeSingle();
    return json(200, { bookingCode: data.booking_code, status: data.status, unitName: unit?.name || '', checkIn: data.check_in, checkOut: data.check_out, depositAmount: data.deposit_amount, totalAmount: data.total_amount, remainingAmount: data.remaining_amount });
  } catch (e) {
    console.error('booking status error', e);
    return json(503, { error: 'Rezervasiya statusunu yoxlamaq mümkün olmadı.' });
  }
};
