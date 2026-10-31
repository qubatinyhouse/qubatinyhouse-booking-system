CREATE OR REPLACE FUNCTION public.create_booking_atomic(
  p_unit_id text,p_check_in date,p_check_out date,p_guest_name text,p_phone text,
  p_guest_count integer,p_breakfast boolean,p_note text,p_stay_amount numeric,
  p_breakfast_amount numeric,p_total_amount numeric,p_deposit_percent integer,
  p_deposit_amount numeric,p_remaining_amount numeric
)
RETURNS TABLE(id uuid, booking_code text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  u public.units%ROWTYPE;
  new_id uuid;
  new_code text;
  new_expiry timestamptz;
  v_campaign_code text;
  v_married boolean := false;
  v_campaign_name text;
  v_note text;
  v_expected_price numeric;
  v_expected_deposit numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_unit_id));
  UPDATE public.reservations SET status='expired'
   WHERE unit_id=p_unit_id AND status='pending_payment' AND expires_at<=now();
  SELECT * INTO u FROM public.units WHERE id=p_unit_id AND active=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNIT_NOT_FOUND'; END IF;
  IF u.is_demo_rate THEN RAISE EXCEPTION 'RATES_NOT_CONFIGURED'; END IF;
  IF p_guest_count>u.capacity THEN RAISE EXCEPTION 'GUEST_CAPACITY_EXCEEDED'; END IF;
  IF p_check_out<=p_check_in THEN RAISE EXCEPTION 'INVALID_DATES'; END IF;

  v_campaign_code := substring(coalesce(p_note,'') from '\[\[QTH_CAMPAIGN=([a-z0-9_]+);MARRIED=(0|1)\]\]');
  v_married := coalesce(substring(coalesce(p_note,'') from 'MARRIED=([01])')='1',false);
  v_campaign_name := CASE v_campaign_code
    WHEN 'autumn_149' THEN 'Payız kampaniyası — 2 nəfər'
    WHEN 'autumn_179' THEN 'Payız kampaniyası — 3–4 nəfər'
    WHEN 'autumn_249' THEN 'Payız kampaniyası — 6–7 nəfər'
    WHEN 'romantic_179' THEN 'Romantik paket'
    WHEN 'honeymoon_349' THEN 'Balayı paketi'
    ELSE NULL END;
  v_note := regexp_replace(coalesce(p_note,''), '^\[\[QTH_CAMPAIGN=[a-z0-9_]+;MARRIED=[01]\]\]\s*', '');

  IF v_campaign_code IS NOT NULL AND v_campaign_name IS NULL THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_CODE'; END IF;
  IF v_campaign_code LIKE 'autumn_%' THEN
    IF p_unit_id NOT IN ('scandi-large-1','scandi-large-2','scandi-small-1','scandi-small-2')
       OR p_check_out-p_check_in<>3 OR p_check_out>DATE '2026-11-05' THEN RAISE EXCEPTION 'AUTUMN_CAMPAIGN_RULES_NOT_MET'; END IF;
    v_expected_price := CASE
      WHEN v_campaign_code='autumn_149' AND p_guest_count=2 THEN 149
      WHEN v_campaign_code='autumn_179' AND p_guest_count BETWEEN 3 AND 4 THEN 179
      WHEN v_campaign_code='autumn_249' AND p_guest_count BETWEEN 6 AND 7 THEN 249
      ELSE NULL END;
    IF v_expected_price IS NULL OR p_stay_amount<>v_expected_price OR p_breakfast_amount<>0
       OR p_total_amount<>v_expected_price OR NOT coalesce(p_breakfast,false) THEN RAISE EXCEPTION 'AUTUMN_CAMPAIGN_PRICE_INVALID'; END IF;
  ELSIF v_campaign_code='romantic_179' THEN
    IF p_unit_id NOT IN ('aframe-1','aframe-2') OR NOT v_married OR p_guest_count<>2 OR p_check_out-p_check_in<>1
       OR p_stay_amount<>179 OR p_breakfast_amount<>0 OR p_total_amount<>179 OR NOT coalesce(p_breakfast,false) THEN RAISE EXCEPTION 'ROMANTIC_PACKAGE_RULES_NOT_MET'; END IF;
  ELSIF v_campaign_code='honeymoon_349' THEN
    IF p_unit_id NOT IN ('aframe-1','aframe-2') OR NOT v_married OR p_guest_count<>2 OR p_check_out-p_check_in<>3
       OR p_stay_amount<>349 OR p_total_amount<>349+coalesce(p_breakfast_amount,0) THEN RAISE EXCEPTION 'HONEYMOON_PACKAGE_RULES_NOT_MET'; END IF;
  END IF;

  IF p_total_amount < 50 THEN RAISE EXCEPTION 'MINIMUM_BOOKING_AMOUNT_50_AZN'; END IF;
  v_expected_deposit := greatest(50::numeric, round(p_total_amount*0.5,2));
  IF p_deposit_percent<>50 OR p_deposit_amount<>v_expected_deposit
     OR p_remaining_amount<>round(p_total_amount-v_expected_deposit,2) THEN
    RAISE EXCEPTION 'BOOKING_PAYMENT_SPLIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.reservations r WHERE r.unit_id=p_unit_id
      AND r.status IN ('pending_payment','confirmed') AND r.check_in<p_check_out AND r.check_out>p_check_in
      AND (r.status='confirmed' OR r.expires_at>now())
  ) THEN RAISE EXCEPTION 'DATES_ALREADY_BOOKED'; END IF;

  INSERT INTO public.reservations (
    unit_id,check_in,check_out,guest_name,phone,guest_count,breakfast,note,
    stay_amount,breakfast_amount,total_amount,deposit_percent,deposit_amount,
    remaining_amount,status,payment_status,expires_at,campaign_code,campaign_name,marriage_confirmed
  ) VALUES (
    p_unit_id,p_check_in,p_check_out,left(trim(p_guest_name),120),left(trim(p_phone),30),
    p_guest_count,coalesce(p_breakfast,false),left(v_note,1500),p_stay_amount,p_breakfast_amount,
    p_total_amount,p_deposit_percent,v_expected_deposit,round(p_total_amount-v_expected_deposit,2),
    'pending_payment','created',now()+interval '25 minutes',v_campaign_code,v_campaign_name,v_married
  )
  RETURNING reservations.id,reservations.booking_code,reservations.expires_at INTO new_id,new_code,new_expiry;
  RETURN QUERY SELECT new_id,new_code,new_expiry;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_atomic(text,date,date,text,text,integer,boolean,text,numeric,numeric,numeric,integer,numeric,numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic(text,date,date,text,text,integer,boolean,text,numeric,numeric,numeric,integer,numeric,numeric) TO service_role;