#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "::error::$1" >&2
  exit 1
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Required GitHub secret is missing: $name"
}

require_env SUPABASE_MAIN_DB_URL
require_env SUPABASE_ADMIN_DB_URL
require_env R2_ACCOUNT_ID
require_env R2_ACCESS_KEY_ID
require_env R2_SECRET_ACCESS_KEY
require_env BACKUP_ENCRYPTION_PASSPHRASE

if (( ${#BACKUP_ENCRYPTION_PASSPHRASE} < 32 )); then
  fail "BACKUP_ENCRYPTION_PASSPHRASE must contain at least 32 characters."
fi

for cmd in supabase psql aws gpg jq sha256sum tar; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Required command is not installed: $cmd"
done

if ! docker info >/dev/null 2>&1; then
  fail "Docker is unavailable; Supabase CLI db dump requires Docker on this runner."
fi

readonly BUCKET="qth-secure-backups"
readonly R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
readonly BOOKING_REF="dwxwgxdzlspqwebewxej"
readonly ADMIN_REF="fynbzmyoleqcnqkhyfzd"
readonly STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/qth-backup.XXXXXX")"
readonly PASS_FILE="$(mktemp "${RUNNER_TEMP:-/tmp}/qth-passphrase.XXXXXX")"
readonly ARCHIVE_NAME="qth-supabase-${STAMP}.tar.gz.gpg"
readonly TAR_FILE="$WORK_DIR/qth-supabase-${STAMP}.tar.gz"
readonly ENCRYPTED_FILE="$WORK_DIR/$ARCHIVE_NAME"
readonly CHECKSUM_FILE="$WORK_DIR/$ARCHIVE_NAME.sha256"
readonly VERIFY_DIR="$WORK_DIR/remote-verify"
readonly VERIFY_FILE="$VERIFY_DIR/$ARCHIVE_NAME"
readonly VERIFY_CHECKSUM="$VERIFY_DIR/$ARCHIVE_NAME.sha256"
readonly VERIFY_TAR="$VERIFY_DIR/verified.tar.gz"

cleanup() {
  rm -f "$PASS_FILE"
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$WORK_DIR/booking" "$WORK_DIR/admin" "$VERIFY_DIR"
printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" > "$PASS_FILE"
chmod 600 "$PASS_FILE"
unset BACKUP_ENCRYPTION_PASSPHRASE

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"
unset R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

dump_project() {
  local label="$1"
  local db_url="$2"
  local out_dir="$3"
  local storage_counts
  local storage_buckets
  local storage_objects
  local auth_users
  local auth_identities

  echo "Backing up $label project (database contents are not printed)."

  # Supabase CLI v3 uses --remote=<postgres-url>. The CLI intentionally
  # excludes Supabase-managed auth/storage schemas from its SQL dump.
  supabase db dump --file "$out_dir/schema.sql" --remote="$db_url"
  supabase db dump --data-only --use-copy --file "$out_dir/data.sql" --remote="$db_url"
  supabase db dump --role-only --file "$out_dir/roles.sql" --remote="$db_url"

  [[ -f "$out_dir/schema.sql" ]] || fail "$label schema dump was not created."
  [[ -f "$out_dir/data.sql" ]] || fail "$label data dump was not created."
  [[ -f "$out_dir/roles.sql" ]] || fail "$label role dump was not created."

  # Keep a recoverable account inventory without exporting password hashes,
  # live sessions, refresh tokens or confirmation/recovery tokens.
  psql "$db_url" -X -v ON_ERROR_STOP=1 --csv -q \
    -c "SELECT id, email, phone, created_at, updated_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data FROM auth.users ORDER BY created_at;" \
    > "$out_dir/auth-users.csv"

  psql "$db_url" -X -v ON_ERROR_STOP=1 --csv -q \
    -c "SELECT id, user_id, provider, provider_id, created_at, updated_at FROM auth.identities ORDER BY created_at;" \
    > "$out_dir/auth-identities.csv"

  auth_users="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM auth.users;")"
  auth_identities="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM auth.identities;")"
  storage_counts="$(psql "$db_url" -X -v ON_ERROR_STOP=1 -Atqc "SELECT (SELECT count(*) FROM storage.buckets)::text || ':' || (SELECT count(*) FROM storage.objects)::text;")"

  IFS=':' read -r storage_buckets storage_objects <<< "$storage_counts"
  [[ "$storage_buckets" =~ ^[0-9]+$ && "$storage_objects" =~ ^[0-9]+$ ]] || fail "$label storage inventory query returned an unexpected result."

  # There are currently no Storage buckets or objects in either project.
  # Fail closed if that changes, rather than claiming those files were backed up.
  if [[ "$storage_buckets" != "0" || "$storage_objects" != "0" ]]; then
    fail "$label now has Supabase Storage data ($storage_buckets buckets, $storage_objects objects). Add object-file backup before treating this run as complete."
  fi

  jq -n \
    --arg label "$label" \
    --arg auth_users "$auth_users" \
    --arg auth_identities "$auth_identities" \
    --arg storage_buckets "$storage_buckets" \
    --arg storage_objects "$storage_objects" \
    '{
      project: $label,
      auth_user_count: ($auth_users | tonumber),
      auth_identity_count: ($auth_identities | tonumber),
      storage_bucket_count: ($storage_buckets | tonumber),
      storage_object_count: ($storage_objects | tonumber),
      auth_export_note: "Account metadata and identity references only; password hashes and live tokens are intentionally excluded."
    }' > "$out_dir/project-inventory.json"

  unset db_url
}

dump_project "booking" "$SUPABASE_MAIN_DB_URL" "$WORK_DIR/booking"
dump_project "admin-finance" "$SUPABASE_ADMIN_DB_URL" "$WORK_DIR/admin"
unset SUPABASE_MAIN_DB_URL SUPABASE_ADMIN_DB_URL

jq -n \
  --arg generated_at_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg cli_version "$(supabase --version)" \
  --arg booking_ref "$BOOKING_REF" \
  --arg admin_ref "$ADMIN_REF" \
  '{
    generated_at_utc: $generated_at_utc,
    supabase_cli_version: $cli_version,
    encryption: "GPG symmetric AES-256",
    projects: {
      booking: { project_ref: $booking_ref, inventory_file: "booking/project-inventory.json" },
      admin_finance: { project_ref: $admin_ref, inventory_file: "admin/project-inventory.json" }
    },
    contents: [
      "Supabase CLI schema, data and role dumps",
      "Auth account metadata and identity references without password hashes or live tokens",
      "SHA-256 checksums for all plaintext files"
    ],
    limitations: [
      "Supabase-managed auth and storage schemas are not included in the CLI SQL dump.",
      "Auth users must be recreated or reset through Supabase Auth after a disaster restore.",
      "Storage object backup is not active; this workflow stops if any Storage bucket or object appears."
    ]
  }' > "$WORK_DIR/manifest.json"

(
  cd "$WORK_DIR"
  find booking admin -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum manifest.json >> SHA256SUMS
)

tar -czf "$TAR_FILE" -C "$WORK_DIR" booking admin manifest.json SHA256SUMS

gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$PASS_FILE" \
  --symmetric --cipher-algo AES256 \
  --output "$ENCRYPTED_FILE" "$TAR_FILE"

[[ -s "$ENCRYPTED_FILE" ]] || fail "Encrypted backup file is empty."
ARCHIVE_SHA="$(sha256sum "$ENCRYPTED_FILE" | awk '{print $1}')"
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE_NAME" > "$CHECKSUM_FILE"

DAILY_KEY="daily/$(date -u +%Y/%m/%d)/$ARCHIVE_NAME"
aws s3 cp "$ENCRYPTED_FILE" "s3://$BUCKET/$DAILY_KEY" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors
aws s3 cp "$CHECKSUM_FILE" "s3://$BUCKET/$DAILY_KEY.sha256" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors

aws s3api head-object --bucket "$BUCKET" --key "$DAILY_KEY" \
  --endpoint-url "$R2_ENDPOINT" >/dev/null

aws s3 cp "s3://$BUCKET/$DAILY_KEY" "$VERIFY_FILE" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors
aws s3 cp "s3://$BUCKET/$DAILY_KEY.sha256" "$VERIFY_CHECKSUM" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors

(
  cd "$VERIFY_DIR"
  sha256sum --check "$VERIFY_CHECKSUM"
)

gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$PASS_FILE" \
  --decrypt --output "$VERIFY_TAR" "$VERIFY_FILE"

tar -xzf "$VERIFY_TAR" -C "$VERIFY_DIR"
(
  cd "$VERIFY_DIR"
  sha256sum --check SHA256SUMS
)

# Keep a monthly copy for 12 months on the first UTC day of each month.
if [[ "$(date -u +%d)" == "01" ]]; then
  MONTHLY_KEY="monthly/$(date -u +%Y/%m)/$ARCHIVE_NAME"
  aws s3 cp "$ENCRYPTED_FILE" "s3://$BUCKET/$MONTHLY_KEY" \
    --endpoint-url "$R2_ENDPOINT" --only-show-errors
  aws s3 cp "$CHECKSUM_FILE" "s3://$BUCKET/$MONTHLY_KEY.sha256" \
    --endpoint-url "$R2_ENDPOINT" --only-show-errors
  aws s3api head-object --bucket "$BUCKET" --key "$MONTHLY_KEY" \
    --endpoint-url "$R2_ENDPOINT" >/dev/null
fi

{
  echo "### Quba Tiny House encrypted Supabase backup"
  echo
  echo "- Generated (UTC): $STAMP"
  echo "- Destination: private R2 bucket `$BUCKET`"
  echo "- Daily object: `$DAILY_KEY`"
  echo "- Encrypted archive SHA-256: `$ARCHIVE_SHA`"
  echo "- Remote download, decryption and internal checksum verification: **passed**"
  if [[ "$(date -u +%d)" == "01" ]]; then
    echo "- Monthly copy: `$MONTHLY_KEY`"
  fi
  echo
  echo "No database schema, data, RLS policy, permission or Netlify setting was changed."
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "QTH backup uploaded and verified successfully."
