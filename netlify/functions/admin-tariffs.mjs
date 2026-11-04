import { db, json, validDate, requireQthAdmin } from '../lib/_lib.mjs';

const allowedUnits = new Set([
  'scandi-large-1','scandi-large-2','scandi-small-1',
  'scandi-small-2','aframe-1','aframe-2'
]);

const positiveOrZero = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export const handler = async (event) => {
  const admin = await requireQthAdmin(event);
  if (!admin) return json(401, { error: 'Admin sessiyası etibarlı deyil. Yenidən daxil olun.' });

  try {
    const client = db();

    if (event.httpMethod === 'GET') {
      const [unitsResult, seasonalResult, datesResult] = await Promise.all([
        client.from('units')
          .select('id,name,unit_type,capacity,weekday_rate,weekend_rate,holiday_rate,is_demo_rate,active,sort_order')
          .order('sort_order', { ascending: true }),
        client.from('seasonal_rates')
          .select('id,unit_id,start_date,end_date,nightly_rate,weekday_rate,weekend_rate,label,active')
          .order('start_date', { ascending: false })
          .limit(300),
        client.from('special_dates')
          .select('date,label,active')
          .order('date', { ascending: true })
          .limit(300)
      ]);
      if (unitsResult.error) throw unitsResult.error;
      if (seasonalResult.error) throw seasonalResult.error;
      if (datesResult.error) throw datesResult.error;
      return json(200, {
        units: unitsResult.data || [],
        seasonalRates: seasonalResult.data || [],
        specialDates: datesResult.data || []
      });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Sorğu formatı düzgün deyil.' }); }

    if (event.httpMethod === 'PATCH' && body.action === 'unit') {
      const { unitId } = body;
      const weekdayRate = Number(body.weekdayRate);
      const weekendRate = Number(body.weekendRate);
      const holidayRate = Number(body.holidayRate);
      if (!allowedUnits.has(unitId) || !positive(weekdayRate) || !positive(weekendRate) || !positive(holidayRate)) {
        return json(400, { error: 'Ev ID-si və tariflər düzgün daxil edilməlidir. Qiymətlər 0-dan böyük olmalıdır.' });
      }
      const { data, error } = await client.from('units')
        .update({
          weekday_rate: weekdayRate,
          weekend_rate: weekendRate,
          holiday_rate: holidayRate,
          is_demo_rate: false
        })
        .eq('id', unitId)
        .select('id,name,weekday_rate,weekend_rate,holiday_rate,is_demo_rate')
        .single();
      if (error) throw error;
      return json(200, { unit: data });
    }

    if (event.httpMethod === 'POST' && body.action === 'seasonal') {
      const { unitId, startDate, endDate, label } = body;
      const weekdayRate = Number(body.weekdayRate);
      const weekendRate = Number(body.weekendRate);
      if (!allowedUnits.has(unitId) || !validDate(startDate) || !validDate(endDate) ||
          endDate <= startDate || !positive(weekdayRate) || !positive(weekendRate) ||
          typeof label !== 'string' || !label.trim() || label.length > 100) {
        return json(400, { error: 'Mövsüm, tarix aralığı və qiymətləri düzgün daxil edin.' });
      }
      const { data: overlap, error: overlapError } = await client.from('seasonal_rates')
        .select('id')
        .eq('unit_id', unitId)
        .eq('active', true)
        .lt('start_date', endDate)
        .gt('end_date', startDate)
        .limit(1);
      if (overlapError) throw overlapError;
      if (overlap?.length) return json(409, { error: 'Bu ev üçün həmin tarix aralığında aktiv mövsüm tarifi artıq var.' });

      const { data, error } = await client.from('seasonal_rates')
        .insert({
          unit_id: unitId,
          start_date: startDate,
          end_date: endDate,
          nightly_rate: weekdayRate,
          weekday_rate: weekdayRate,
          weekend_rate: weekendRate,
          label: label.trim(),
          active: true
        })
        .select('id,unit_id,start_date,end_date,weekday_rate,weekend_rate,label,active')
        .single();
      if (error) throw error;
      return json(201, { seasonalRate: data });
    }

    if (event.httpMethod === 'POST' && body.action === 'specialDate') {
      const { date, label } = body;
      if (!validDate(date) || typeof label !== 'string' || !label.trim() || label.length > 100) {
        return json(400, { error: 'Bayram tarixi və adı düzgün daxil edilməlidir.' });
      }
      const { data, error } = await client.from('special_dates')
        .upsert({ date, label: label.trim(), active: true }, { onConflict: 'date' })
        .select('date,label,active')
        .single();
      if (error) throw error;
      return json(200, { specialDate: data });
    }

    if (event.httpMethod === 'DELETE' && body.action === 'seasonal') {
      const id = Number(body.id);
      if (!Number.isSafeInteger(id) || id <= 0) return json(400, { error: 'Mövsüm ID-si düzgün deyil.' });
      const { data, error } = await client.from('seasonal_rates')
        .update({ active: false })
        .eq('id', id)
        .eq('active', true)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return json(404, { error: 'Aktiv mövsüm tarifi tapılmadı.' });
      return json(200, { ok: true, id });
    }

    if (event.httpMethod === 'DELETE' && body.action === 'specialDate') {
      if (!validDate(body.date)) return json(400, { error: 'Bayram tarixi düzgün deyil.' });
      const { data, error } = await client.from('special_dates')
        .update({ active: false })
        .eq('date', body.date)
        .eq('active', true)
        .select('date')
        .maybeSingle();
      if (error) throw error;
      if (!data) return json(404, { error: 'Aktiv bayram tarixi tapılmadı.' });
      return json(200, { ok: true, date: body.date });
    }

    return json(405, { error: 'Dəstəklənməyən əməliyyat.' });
  } catch (error) {
    console.error('admin tariffs error', {
      message: error?.message, code: error?.code, details: error?.details, hint: error?.hint
    });
    return json(503, { error: 'Tarif əməliyyatı yerinə yetirilmədi. Zəhmət olmasa yenidən cəhd edin.' });
  }
};
