import { db, text, signEpoint, safeSignatureEqual } from '../lib/_lib.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return text(405, 'METHOD_NOT_ALLOWED');
  try {
    if (!process.env.EPOINT_PRIVATE_KEY) return text(503, 'CONFIG_ERROR');
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const form = new URLSearchParams(rawBody);
    const data = form.get('data');
    const signature = form.get('signature');
    if (!data || !signature || !safeSignatureEqual(signEpoint(data, process.env.EPOINT_PRIVATE_KEY), signature)) return text(400, 'INVALID_SIGNATURE');
    let payload;
    try { payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch { return text(400, 'INVALID_DATA'); }
    const bookingCode = String(payload.order_id || '');
    if (!bookingCode) return text(400, 'MISSING_ORDER');
    const client = db();
    const { data: booking, error } = await client.from('reservations').select('id,booking_code,unit_id,check_in,check_out,status,deposit_amount,total_amount').eq('booking_code', bookingCode).maybeSingle();
    if (error) throw error;
    if (!booking) return text(404, 'ORDER_NOT_FOUND');
    const paymentStatus = String(payload.status || '').toLowerCase();
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || Math.abs(amount - Number(booking.deposit_amount)) > 0.01) {
      await client.from('reservations').update({ status: 'payment_review', payment_status: 'amount_mismatch', payment_transaction: payload.transaction || null }).eq('id', booking.id);
      return text(400, 'AMOUNT_MISMATCH');
    }
    if (paymentStatus === 'success') {
      const { data: confirmation, error: confirmationError } = await client.rpc('confirm_paid_booking_atomic', {
        p_booking_code: bookingCode,
        p_transaction: payload.transaction || '',
        p_paid_amount: amount
      });
      if (confirmationError) throw confirmationError;
      const item = Array.isArray(confirmation) ? confirmation[0] : confirmation;
      return text(200, item?.result_status === 'payment_review' ? 'OK_REVIEW' : 'OK');
    }
    await client.from('reservations').update({ status: 'payment_failed', payment_status: paymentStatus || 'error', payment_transaction: payload.transaction || null }).eq('id', booking.id);
    return text(200, 'OK');
  } catch (e) {
    console.error('epoint callback error', e);
    return text(500, 'ERROR');
  }
};
