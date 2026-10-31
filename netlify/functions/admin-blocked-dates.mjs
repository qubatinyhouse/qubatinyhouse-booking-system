import { db, json, validDate } from '../lib/_lib.mjs';

const allowedUnits = new Set([
  'scandi-large-1','scandi-large-2','scandi-small-1',
  'scandi-small-2','aframe-1','aframe-2'
]);
const allowedReasons = new Set(['owner','maintenance','other']);

export const handler = async (event) => {
  const expectedToken = process.env.ADMIN_API_TOKEN;
  const suppliedToken = event.headers?.['x-admin-token'] || event.headers?.['X-Admin-Token'];
  if (!expectedToken || !suppliedToken || suppliedToken !== expectedToken) {
    return json(401, { error: 'Admin icazəsi tələb olunur.' });
  }

  try {
    const client = db();

    if (event.httpMethod === 'GET') {
      const { data, error } = await client
        .from('blocked_dates')
        .select('id,unit_id,check_in,check_out,reason,note,active,created_at')
        .eq('active', true)
        .order('check_in', { ascending: true });
      if (error) throw error;
      const { data: units, error: unitsError } = await client.from('units').select('id,name');
      if (unitsError) throw unitsError;
      const names = new Map((units || []).map(u => [u.id, u.name]));
      return json(200, { blocks: (data || []).map(b => ({ ...b, unit_name: names.get(b.unit_id) || b.unit_id })) });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Yanlış JSON formatı.' }); }

    if (event.httpMethod === 'POST') {
      const { unit_id, check_in, check_out, reason = 'other', note = '' } = body;
      if (!allowedUnits.has(unit_id) || !validDate(check_in) || !validDate(check_out) ||
          check_out <= check_in || !allowedReasons.has(reason)) {
        return json(400, { error: 'Ev, tarix aralığı və səbəb düzgün seçilməyib.' });
      }

      const { data: bookings, error: bookingError } = await client
        .from('reservations')
        .select('id,status,expires_at')
        .eq('unit_id', unit_id)
        .in('status', ['confirmed','pending_payment'])
        .lt('check_in', check_out)
        .gt('check_out', check_in);
      if (bookingError) throw bookingError;
      const now = Date.now();
      const conflict = (bookings || []).some(b =>
        b.status === 'confirmed' || (b.expires_at && Date.parse(b.expires_at) > now)
      );
      if (conflict) return json(409, { error: 'Bu tarixlərdə aktiv rezervasiya var. Əvvəl rezervasiyanı yoxlayın.' });

      const { data: existing, error: existingError } = await client
        .from('blocked_dates')
        .select('id')
        .eq('unit_id', unit_id)
        .eq('active', true)
        .lt('check_in', check_out)
        .gt('check_out', check_in)
        .limit(1);
      if (existingError) throw existingError;
      if (existing?.length) return json(409, { error: 'Bu evin seçilmiş tarixlərində artıq bağlanmış gün var.' });

      const { data, error } = await client.from('blocked_dates')
        .insert({ unit_id, check_in, check_out, reason, note: String(note).slice(0,500), active: true })
        .select('id,unit_id,check_in,check_out,reason,note,active')
        .single();
      if (error) throw error;
      return json(201, { block: data });
    }

    if (event.httpMethod === 'DELETE') {
      const id = Number(body.id);
      if (!Number.isSafeInteger(id) || id < 1) return json(400, { error: 'Bağlama ID-si düzgün deyil.' });
      const { data, error } = await client.from('blocked_dates')
        .update({ active: false })
        .eq('id', id)
        .eq('active', true)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return json(404, { error: 'Aktiv bağlama tapılmadı.' });
      return json(200, { ok: true, id });
    }

    return json(405, { error: 'Yalnız GET, POST və DELETE sorğuları qəbul edilir.' });
  } catch (error) {
    console.error('admin blocked dates error', error);
    return json(503, { error: 'Təqvim əməliyyatı yerinə yetirilmədi.' });
  }
};
