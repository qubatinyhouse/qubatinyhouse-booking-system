import { db, json, requireQthAdmin } from '../lib/_lib.mjs';

const IDLE_TIMEOUT_MS = 25 * 60 * 1000;

export const handler = async (event) => {
  const admin = await requireQthAdmin(event, { skipIdleCheck: true });
  if (!admin) return json(401, { active: false, reason: 'auth_invalid', error: 'Admin sessiyası etibarlı deyil.' });

  try {
    const client = db();
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const { data: current, error: readError } = await client
      .from('qth_admin_activity')
      .select('last_activity,session_ids')
      .eq('user_id', admin.id)
      .maybeSingle();
    if (readError) throw readError;

    const lastActivity = current ? Date.parse(current.last_activity) : null;
    const expired = Boolean(current) &&
      (!Number.isFinite(lastActivity) || now - lastActivity >= IDLE_TIMEOUT_MS);
    const sessionIds = Array.isArray(current?.session_ids) ? current.session_ids : [];
    const registered = sessionIds.includes(admin.sessionId);

    if (event.httpMethod === 'GET') {
      if (!current || expired) {
        return json(200, { active: false, expired: true, reason: 'idle_timeout', timeoutMinutes: 25 });
      }
      if (!registered) {
        return json(200, { active: false, expired: false, reason: 'session_invalidated', timeoutMinutes: 25 });
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
      if (!current) {
        const { error } = await client.from('qth_admin_activity').upsert({
          user_id: admin.id,
          last_activity: stamp,
          updated_at: stamp,
          session_ids: [admin.sessionId]
        });
        if (error) throw error;
        return json(200, { active: true, expired: false, lastActivity: stamp, timeoutMinutes: 25 });
      }

      if (expired) {
        // A fresh sign-in starts a new generation and invalidates all older device sessions.
        if (!Number.isFinite(lastActivity) || !admin.authTime || admin.authTime * 1000 <= lastActivity) {
          return json(200, { active: false, expired: true, reason: 'idle_timeout', timeoutMinutes: 25 });
        }
        const { error } = await client.from('qth_admin_activity').upsert({
          user_id: admin.id,
          last_activity: stamp,
          updated_at: stamp,
          session_ids: [admin.sessionId]
        });
        if (error) throw error;
        return json(200, { active: true, expired: false, lastActivity: stamp, timeoutMinutes: 25 });
      }

      if (!registered) {
        // Only a recently authenticated device may join an already-active window.
        if (!admin.authTime || admin.authTime * 1000 < lastActivity - 1000) {
          return json(200, { active: false, expired: false, reason: 'session_invalidated', timeoutMinutes: 25 });
        }
      }
      const nextSessionIds = registered ? sessionIds : [...sessionIds, admin.sessionId];
      const { error } = await client.from('qth_admin_activity').upsert({
        user_id: admin.id,
        last_activity: stamp,
        updated_at: stamp,
        session_ids: nextSessionIds
      });
      if (error) throw error;
      return json(200, { active: true, expired: false, lastActivity: stamp, timeoutMinutes: 25 });
    }

    if (!current || expired) {
      return json(200, { active: false, expired: true, reason: 'idle_timeout', timeoutMinutes: 25 });
    }
    if (!registered) {
      return json(200, { active: false, expired: false, reason: 'session_invalidated', timeoutMinutes: 25 });
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
