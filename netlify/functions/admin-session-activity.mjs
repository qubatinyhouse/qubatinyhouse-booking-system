import { db, json, requireQthAdmin } from '../lib/_lib.mjs';

const IDLE_TIMEOUT_MS = 25 * 60 * 1000;

export const handler = async (event) => {
  // This endpoint must still be callable after the idle window expires so it can
  // report the timeout and let the browser revoke every Supabase Auth session.
  const admin = await requireQthAdmin(event, { skipIdleCheck: true });
  if (!admin) return json(401, { active: false, error: 'Admin sessiyası etibarlı deyil.' });

  try {
    const client = db();
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const { data: current, error: readError } = await client
      .from('qth_admin_activity')
      .select('last_activity')
      .eq('user_id', admin.id)
      .maybeSingle();
    if (readError) throw readError;

    const lastActivity = current ? Date.parse(current.last_activity) : null;
    const expired = current && (!Number.isFinite(lastActivity) || now - lastActivity >= IDLE_TIMEOUT_MS);

    if (event.httpMethod === 'GET') {
      if (!current || expired) {
        return json(200, { active: false, expired: Boolean(current), timeoutMinutes: 25 });
      }
      return json(200, {
        active: true,
        expired: false,
        lastActivity: current.last_activity,
        timeoutMinutes: 25
      });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { active: false, error: 'Method not allowed.' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { active: false, error: 'Yanlış JSON formatı.' }); }

    const action = body.action;
    if (!['start', 'activity'].includes(action)) {
      return json(400, { active: false, error: 'Naməlum sessiya əməliyyatı.' });
    }

    if (action === 'start') {
      // Only a fresh authentication (auth_time newer than the previous activity)
      // can start a new global window after the previous one has expired.
      if (expired && (!admin.authTime || admin.authTime * 1000 <= lastActivity)) {
        return json(200, { active: false, expired: true, timeoutMinutes: 25 });
      }
      const { error } = await client.from('qth_admin_activity').upsert({
        user_id: admin.id,
        last_activity: stamp,
        updated_at: stamp
      });
      if (error) throw error;
      return json(200, { active: true, expired: false, lastActivity: stamp, timeoutMinutes: 25 });
    }

    // Activity heartbeats can extend the shared window only while it is still
    // alive. An old tab cannot resurrect an expired session by sending a ping.
    if (!current || expired) {
      return json(200, { active: false, expired: true, timeoutMinutes: 25 });
    }
    const { error } = await client.from('qth_admin_activity')
      .update({ last_activity: stamp, updated_at: stamp })
      .eq('user_id', admin.id);
    if (error) throw error;

    return json(200, { active: true, expired: false, lastActivity: stamp, timeoutMinutes: 25 });
  } catch (error) {
    console.error('QTH admin shared idle-session error', error?.message || error);
    return json(500, { active: false, error: 'Sessiya təhlükəsizlik yoxlaması hazırda mümkün deyil.' });
  }
};
