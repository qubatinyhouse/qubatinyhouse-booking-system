import { db, json } from '../lib/_lib.mjs';

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

    if (event.httpMethod === 'GET') {
      const { data: reservations, error } = await client
        .from('reservations')
        .select('id,booking_code,unit_id,check_in,check_out,guest_name,phone,guest_count,note,total_amount,deposit_amount,remaining_amount,paid_amount,status,payment_status,created_at')
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) throw error;

      const { data: units, error: unitsError } = await client
        .from('units')
        .select('id,name');

      if (unitsError) throw unitsError;

      const unitNames = new Map((units || []).map((unit) => [unit.id, unit.name]));

      return json(200, {
        reservations: (reservations || []).map((item) => ({
          ...item,
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

      const { data, error } = await client
        .from('reservations')
        .update({ status })
        .eq('id', id)
        .select('id,status')
        .single();

      if (error) throw error;
      return json(200, { reservation: data });
    }

    return json(405, { error: 'Yalnız GET və PATCH sorğuları qəbul edilir.' });
  } catch (error) {
    console.error('admin reservations error', error);
    return json(503, { error: 'Rezervasiyalar yüklənmədi.' });
  }
};
