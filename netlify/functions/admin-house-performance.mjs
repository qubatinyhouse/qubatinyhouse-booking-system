import { db, json, requireQthAdmin } from '../lib/_lib.mjs';

const INCLUDED_STATUSES = new Set(['confirmed', 'pending_payment', 'payment_review']);
const EXCLUDED_STATUSES = new Set(['cancelled', 'expired', 'payment_failed']);

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
function overlapNights(checkIn, checkOut, rangeStart, rangeEnd) {
  const start = Math.max(Date.parse(checkIn + 'T00:00:00Z'), Date.parse(rangeStart + 'T00:00:00Z'));
  const end = Math.min(Date.parse(checkOut + 'T00:00:00Z'), Date.parse(rangeEnd + 'T00:00:00Z'));
  return Math.max(0, Math.round((end - start) / 86400000));
}

export const handler = async (event) => {
  const admin = await requireQthAdmin(event);
  if (!admin) return json(401, { error: 'Admin sessiyası etibarlı deyil. Yenidən daxil olun.' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Yalnız GET sorğusu qəbul edilir.' });

  try {
    const now = new Date();
    const month = event.queryStringParameters?.month || now.toISOString().slice(0, 7);
    if (!validMonth(month)) return json(400, { error: 'Ay YYYY-MM formatında olmalıdır.' });

    const rangeStart = month + '-01';
    const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const rangeEnd = nextMonth.toISOString().slice(0, 10);
    const daysInMonth = Math.round((Date.parse(rangeEnd + 'T00:00:00Z') - Date.parse(rangeStart + 'T00:00:00Z')) / 86400000);

    const client = db();
    const [unitsResult, reservationsResult] = await Promise.all([
      client.from('units').select('id,name,capacity,active,sort_order').eq('active', true).order('sort_order', { ascending: true }),
      client.from('reservations')
        .select('id,booking_code,unit_id,check_in,check_out,guest_name,guest_count,total_amount,paid_amount,status')
        .lt('check_in', rangeEnd)
        .gt('check_out', rangeStart)
        .order('check_in', { ascending: true })
        .limit(5000)
    ]);
    if (unitsResult.error) throw unitsResult.error;
    if (reservationsResult.error) throw reservationsResult.error;

    const units = unitsResult.data || [];
    const reservations = reservationsResult.data || [];
    const stats = new Map(units.map((unit) => [unit.id, {
      unitId: unit.id,
      name: unit.name,
      capacity: Number(unit.capacity || 0),
      reservationCount: 0,
      guestCount: 0,
      paidRevenue: 0,
      bookingValue: 0,
      occupiedNights: 0,
      occupancyRate: 0
    }]));

    const monthlyReservations = [];
    for (const booking of reservations) {
      const status = String(booking.status || '').toLowerCase();
      if (!INCLUDED_STATUSES.has(status) || EXCLUDED_STATUSES.has(status)) continue;
      const stat = stats.get(booking.unit_id);
      if (!stat) continue;

      const nights = overlapNights(booking.check_in, booking.check_out, rangeStart, rangeEnd);
      if (nights > 0) stat.occupiedNights += nights;

      // Revenue and guest totals are attributed to the month the stay starts,
      // while occupied nights include stays that overlap the selected month.
      const startsInMonth = booking.check_in >= rangeStart && booking.check_in < rangeEnd;
      if (startsInMonth) {
        stat.reservationCount += 1;
        stat.guestCount += Math.max(0, Number(booking.guest_count || 0));
        stat.paidRevenue += Math.max(0, Number(booking.paid_amount || 0));
        stat.bookingValue += Math.max(0, Number(booking.total_amount || 0));
        monthlyReservations.push(booking);
      }
    }

    const result = [...stats.values()].map((item) => ({
      ...item,
      paidRevenue: Math.round(item.paidRevenue * 100) / 100,
      bookingValue: Math.round(item.bookingValue * 100) / 100,
      occupancyRate: daysInMonth ? Math.round((item.occupiedNights / daysInMonth) * 1000) / 10 : 0
    }));

    const byRevenue = [...result].sort((a, b) => b.paidRevenue - a.paidRevenue || b.reservationCount - a.reservationCount);
    const byGuests = [...result].sort((a, b) => b.guestCount - a.guestCount || b.reservationCount - a.reservationCount);
    const byWeakness = [...result].sort((a, b) =>
      a.paidRevenue - b.paidRevenue ||
      a.reservationCount - b.reservationCount ||
      a.guestCount - b.guestCount
    );

    return json(200, {
      month,
      rangeStart,
      rangeEnd,
      daysInMonth,
      totalPaidRevenue: Math.round(result.reduce((sum, item) => sum + item.paidRevenue, 0) * 100) / 100,
      totalGuests: result.reduce((sum, item) => sum + item.guestCount, 0),
      totalReservations: result.reduce((sum, item) => sum + item.reservationCount, 0),
      topRevenue: byRevenue[0] || null,
      topGuests: byGuests[0] || null,
      weakest: byWeakness[0] || null,
      units: result.sort((a, b) => a.name.localeCompare(b.name)),
      method: 'paid_amount per reservation check-in month; guests = guest_count; occupancy = overlapping active stay nights / calendar days',
      truncated: reservations.length >= 5000
    });
  } catch (error) {
    console.error('admin house performance error', { message: error?.message, code: error?.code });
    return json(503, { error: 'Ev analitikası hazırda əlçatan deyil.' });
  }
};
