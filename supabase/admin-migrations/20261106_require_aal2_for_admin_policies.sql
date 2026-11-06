-- Require multi-factor authentication (AAL2) for every browser-facing admin data policy.
-- Admin login guides the owner through TOTP setup before revealing the admin panel.
DO $$
DECLARE
  p record;
  aal2_check text := '((auth.jwt() ->> ''aal'') = ''aal2'')';
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    IF p.qual IS NOT NULL AND p.with_check IS NOT NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING ((%s) AND %s) WITH CHECK ((%s) AND %s)',
        p.policyname, p.schemaname, p.tablename, p.qual, aal2_check, p.with_check, aal2_check
      );
    ELSIF p.qual IS NOT NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING ((%s) AND %s)',
        p.policyname, p.schemaname, p.tablename, p.qual, aal2_check
      );
    ELSIF p.with_check IS NOT NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK ((%s) AND %s)',
        p.policyname, p.schemaname, p.tablename, p.with_check, aal2_check
      );
    END IF;
  END LOOP;
END $$;