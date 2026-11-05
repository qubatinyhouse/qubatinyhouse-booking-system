# Quba Tiny House — təhlükəsiz backup qurulması

Bu sənəd yalnız backup infrastrukturunun qurulması üçündür. Mövcud rezervasiya və admin sisteminin SQL sxeminə, RLS qaydalarına, Netlify dəyişənlərinə və canlı rezervasiyalara toxunmur.

## Hazırkı vəziyyət

- Rezervasiya bazası: `dwxwgxdzlspqwebewxej` — PostgreSQL 17.11, ACTIVE_HEALTHY.
- Admin/maliyyə bazası: `fynbzmyoleqcnqkhyfzd` — PostgreSQL 17.11, ACTIVE_HEALTHY.
- Hər iki bazada hazırda 1 Auth istifadəçisi var.
- Hər iki bazada Storage bucket və object sayı hazırda 0-dır.
- Supabase CLI-nin `db dump` əmri Supabase tərəfindən idarə olunan `auth` və `storage` sxemlərini SQL dump-a daxil etmir. Buna görə workflow Auth istifadəçilərinin bərpa üçün lazım olan əsas metadata və identity istinadlarını ayrıca CSV kimi ixrac edir. Parol hash-ləri, sessiyalar və tokenlər qəsdən ixrac edilmir. Bərpadan sonra Auth istifadəçiləri yenidən yaradılmalı və ya parol sıfırlamalıdır.
- Storage-da gələcəkdə fayl yaranarsa, workflow səssizcə natamam backup yaratmır: bucket/object sayı sıfırdan fərqli olduqda işi uğursuz dayandırır. Obyekt fayllarının ayrıca backup mərhələsi bundan sonra əlavə edilməlidir.

## 1. Cloudflare R2

1. Cloudflare Dashboard → R2 Object Storage → Create bucket.
2. Bucket adı dəqiq belə olsun: `qth-secure-backups`.
3. Public access / r2.dev public URL bağlı qalsın. Bucket private olmalıdır.
4. R2 → Manage R2 API Tokens bölməsində yalnız bu bucket üçün S3 API token yarat:
   - Bucket scope: yalnız `qth-secure-backups`
   - Permission: Object Read & Write
   - Account-wide admin icazəsi vermə.
5. Access Key ID və Secret Access Key dəyərlərini yalnız növbəti GitHub Secrets addımında istifadə et. Çata, e-poçta və repoya yazma.
6. Account ID-ni R2 Overview-dən götür.

S3 endpoint forması:

`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

### Lifecycle / saxlama qaydaları

Bucket → Settings → Object Lifecycle Rules bölməsində iki qayda yarat:

| Prefix | Action | Müddət |
|---|---|---:|
| `daily/` | Delete objects | 30 days |
| `monthly/` | Delete objects | 365 days |

Beləliklə gündəlik nüsxələr 30 gün, ayın ilk günü yaradılan aylıq nüsxələr 12 ay saxlanılır. R2 lifecycle silinməni adətən expiration vaxtından sonra 24 saat ərzində tamamlayır.

## 2. Supabase connection string-ləri

Hər layihədə Dashboard → Connect → Session pooler bölməsindən PostgreSQL connection string götür:

- Booking project: `dwxwgxdzlspqwebewxej`
- Admin/Finance project: `fynbzmyoleqcnqkhyfzd`

Session pooler connection string-i istifadə et. Parolda xüsusi simvol varsa, URI formatına uyğun percent-encode edilməlidir. Connection string-in özü məxfi məlumatdır.

## 3. GitHub Actions Secrets

GitHub repository → Settings → Secrets and variables → Actions → New repository secret.

Bu adlarla əlavə et:

| Secret name | Dəyər |
|---|---|
| `SUPABASE_MAIN_DB_URL` | Booking layihəsinin Session pooler connection string-i |
| `SUPABASE_ADMIN_DB_URL` | Admin/Finance layihəsinin Session pooler connection string-i |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | R2 S3 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 Secret Access Key |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Password manager-də saxlanan təsadüfi, ən azı 32 simvolluq güclü passphrase |

İstəyə bağlı:

- `BACKUP_ALERT_WEBHOOK`: Slack və ya Discord incoming webhook. Qoyulmasa GitHub Actions failure notifications istifadə ediləcək; GitHub notification settings-də e-poçt bildirişlərini aktiv saxla.

**Heç bir secret-i GitHub repository file, commit, issue və ya ChatGPT çatına yerləşdirmə.** Encryption passphrase itərsə, şifrələnmiş backup-ı açmaq mümkün olmayacaq; onu backup fayllarından ayrı, password manager-də saxla.

## 4. Workflow-un işi

`.github/workflows/qth-supabase-backup.yml`:

- Hər gün Bakı vaxtı 06:17-də işləyir.
- Hər iki Supabase layihəsindən schema, data və role dump yaradır.
- Auth istifadəçilərinin məhdud metadata/identity CSV nüsxəsini yaradır.
- Bütün faylları SHA-256 ilə yoxlayır.
- Arxivi GPG AES-256 ilə şifrələyir.
- Private R2 bucket-ə `daily/YYYY/MM/DD/` prefix-i ilə yükləyir.
- Yüklənmiş faylı yenidən endirir, SHA-256, decryption və daxili checksum yoxlaması aparır.
- Ayın ilk UTC günündə əlavə `monthly/YYYY/MM/` nüsxəsi yaradır.
- Uğursuzluqda GitHub Actions job-u failed olur; optional webhook varsa xəbərdarlıq göndərir.

Workflow yalnız `schedule` və `workflow_dispatch` hadisələrinə cavab verir. Pull request-lərdən secret istifadə etmir.

## 5. Bərpa sınağı

Backup workflow uğurla işlədikdən sonra ayrıca test Supabase layihəsi yaradılmalıdır. Əvvəl həmin test layihəsinə schema/data restore edilir, cədvəl sayları və əsas booking/finance qeydləri müqayisə olunur. Auth istifadəçisi yeni parolla yenidən yaradılır. Bu sınaq tamamlanmadan backup sistemi tam bərpa olunmuş hesab edilmir.

**Qadağa:** canlı booking və admin layihələrində `db reset`, `db push`, `DROP`, RLS/grant dəyişiklikləri və ya restore əməliyyatı icra etmə.

## 6. İstifadə olunan rəsmi sənədlər

- Supabase CLI v3 migration: https://supabase.com/docs/guides/local-development/cli/migrating-to-v3
- Supabase database backups: https://supabase.com/docs/guides/platform/backups
- Supabase backup/restore: https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- Cloudflare R2 lifecycle: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
