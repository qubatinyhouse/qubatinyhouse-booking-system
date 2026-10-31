CREATE OR REPLACE FUNCTION public.confirm_manual_paid_booking(p_reservation_id uuid)
RETURNS TABLE(result_status text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  b public.reservations%ROWTYPE;
  has_conflict boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_reservation_id::text));

  SELECT * INTO b
    FROM public.reservations
   WHERE id = p_reservation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND';
  END IF;

  IF b.status = 'confirmed' THEN
    RETURN QUERY SELECT 'already_confirmed'::text;
    RETURN;
  END IF;

  IF b.status NOT IN ('pending_payment', 'expired') THEN
    RAISE EXCEPTION 'RESERVATION_STATUS_NOT_ELIGIBLE';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(b.unit_id));

  UPDATE public.reservations
     SET status = 'expired'
   WHERE unit_id = b.unit_id
     AND id <> b.id
     AND status = 'pending_payment'
     AND expires_at <= now();

  SELECT EXISTS (
    SELECT 1
      FROM public.reservations r
     WHERE r.unit_id = b.unit_id
       AND r.id <> b.id
       AND r.status IN ('pending_payment', 'confirmed')
       AND r.check_in < b.check_out
       AND r.check_out > b.check_in
       AND (r.status = 'confirmed' OR r.expires_at > now())
  ) INTO has_conflict;

  IF has_conflict THEN
    UPDATE public.reservations
       SET status = 'payment_review',
           payment_status = 'paid_but_schedule_conflict',
           payment_transaction = 'manual_bank_transfer_verified',
           paid_amount = deposit_amount,
           paid_at = now()
     WHERE id = b.id;

    RETURN QUERY SELECT 'payment_review'::text;
  ELSE
    UPDATE public.reservations
       SET status = 'confirmed',
           payment_status = 'paid_manual',
           payment_transaction = 'manual_bank_transfer_verified',
           paid_amount = deposit_amount,
           paid_at = now()
     WHERE id = b.id;

    RETURN QUERY SELECT 'confirmed'::text;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_manual_paid_booking(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_manual_paid_booking(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_manual_paid_booking(uuid) TO service_role;
