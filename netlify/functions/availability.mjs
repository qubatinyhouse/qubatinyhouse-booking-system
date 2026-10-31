import { db, json, validDate, getNights, quoteForUnit } from '../lib/_lib.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Yalnız GET sorğusu qəbul edilir.' });
  }

  try {
    const {
      checkIn,
      checkOut,
      guestCount = '2',
      unitType = 'small',
      breakfast = '0'
    } = event.queryStringParameters || {};

    if (
      !validDate(checkIn) ||
      !validDate(checkOut) ||
      getNights(checkIn, checkOut) < 1 ||
      getNights(checkIn, checkOut) > 30
    ) {
      return json(400, {
        error: 'Düzgün giriş/çıxış tarixləri seçin. Rezervasiya 1–30 gecə ola bilər.'
      });
    }

    const guests = Number(guestCount);

    if (!Number.isInteger(guests) || guests < 1 || guests > 10) {
      return json(400, {
        error: 'Qonaq sayı 1–10 arasında olmalıdır.'
      });
    }

    if (!['scandi', 'small', 'large', 'aframe'].includes(unitType)) {
      return json(400, {
        error: 'Ev növü düzgün seçilməyib.'
      });
    }

    const client = db();

    const [unitsRes, bookingsRes, blockedRes, allUnitsRes] = await Promise.all([
      client
        .from('units')
        .select('id,name,unit_type,capacity,weekday_rate,weekend_rate,holiday_rate,breakfast_rate_per_person,is_demo_rate,active,sort_order')
        .eq('active', true)
        .in('unit_type', unitType === 'scandi' ? ['small', 'large'] : [unitType])
        .gte('capacity', guests)
        .order('sort_order', { ascending: true }),

      client
        .from('reservations')
        .select('unit_id,check_in,check_out,status,expires_at'),

      client
        .from('blocked_dates')
        .select('unit_id,check_in,check_out,active'),

      // Diagnostic read: compare all active units with the requested type/capacity filter.
      client
        .from('units')
        .select('id,unit_type,capacity,active')
        .order('sort_order', { ascending: true })
    ]);

    if (unitsRes.error) throw unitsRes.error;
    if (bookingsRes.error) throw bookingsRes.error;
    if (blockedRes.error) throw blockedRes.error;
    if (allUnitsRes.error) throw allUnitsRes.error;

    const now = Date.now();

    const conflicts = (bookingsRes.data || []).filter((booking) =>
      booking.status === 'confirmed' ||
      (
        booking.status === 'pending_payment' &&
        booking.expires_at &&
        Date.parse(booking.expires_at) > now
      )
    );

    const blockedDates = (blockedRes.data || []).filter(
      (blocked) => blocked.active === true
    );

    const units = (
      await Promise.all(
        (unitsRes.data || []).map(async (unit) => {
          const busy =
            conflicts.some((booking) =>
              booking.unit_id === unit.id &&
              booking.check_in < checkOut &&
              booking.check_out > checkIn
            ) ||
            blockedDates.some((blocked) =>
              blocked.unit_id === unit.id &&
              blocked.check_in < checkOut &&
              blocked.check_out > checkIn
            );

          if (busy) return null;

          try {
            const quote = await quoteForUnit(
              client,
              unit,
              checkIn,
              checkOut,
              guests,
              breakfast === '1'
            );

            return {
              id: unit.id,
              name: unit.name,
              unitType: unit.unit_type,
              capacity: unit.capacity,
              available: true,
              isDemoRate: unit.is_demo_rate,
              quote
            };
          } catch (error) {
            return {
              id: unit.id,
              name: unit.name,
              unitType: unit.unit_type,
              capacity: unit.capacity,
              available: true,
              isDemoRate: unit.is_demo_rate,
              quote: null,
              pricingError: error.message ||
                'Bu ev üçün qiymət hesablana bilmədi.'
            };
          }
        })
      )
    ).filter(Boolean);

    const response = {
      checkIn,
      checkOut,
      guestCount: guests,
      unitType,
      units
    };

    // Opt-in, non-secret diagnostics for troubleshooting production availability.
    if (event.queryStringParameters?.diagnostics === '1') {
      const allUnits = allUnitsRes.data || [];
      response.diagnostics = {
        totalUnitsVisibleToServer: allUnits.length,
        activeUnitsVisibleToServer: allUnits.filter((u) => u.active === true).length,
        requestedTypeUnits: allUnits.filter((u) => unitType === 'scandi' ? ['small','large'].includes(u.unit_type) : u.unit_type === unitType).length,
        requestedTypeAndCapacityUnits: allUnits.filter((u) =>
          u.active === true && (unitType === 'scandi' ? ['small','large'].includes(u.unit_type) : u.unit_type === unitType) && Number(u.capacity) >= guests
        ).length,
        filteredQueryUnits: (unitsRes.data || []).length,
        reservationsRowsRead: (bookingsRes.data || []).length,
        blockedDateRowsRead: (blockedRes.data || []).length
      };
    }

    return json(200, response);

  } catch (error) {
    console.error('availability error', error);

    return json(503, {
      error: error.message ||
        'Mövcudluq yoxlanarkən texniki xəta oldu.'
    });
  }
};
