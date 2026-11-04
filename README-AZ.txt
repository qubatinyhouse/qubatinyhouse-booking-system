QUBA TINY HOUSE — SAYT + REZERVASIYA + ADMIN + MALİYYƏ
==========================================================

ARXİTEKTURA
-----------
- Müştəri saytı: public/index.html
- Admin panel: public/admin.html
- Maliyyə modulu: public/finance.html (ayrıca Supabase layihəsi)
- Rezervasiya bazası: Supabase layihəsi dwxwgxdzlspqwebewxej
- Maliyyə/Admin bazası: Supabase layihəsi fynbzmyoleqcnqkhyfzd
- Server: Netlify Functions; rezervasiya bazasının service_role açarı yalnız server mühitində saxlanılır.
- Altı evin ID-ləri sabit saxlanılmalıdır: scandi-large-1, scandi-large-2, scandi-small-1, scandi-small-2, aframe-1, aframe-2.

VACİB İŞ AXINI
--------------
1. Müştəri ev, tarix və qonaq sayını seçir.
2. Server boşluğu və tarifi yoxlayır.
3. Rezervasiya sorğusu yaradılır. Avans minimum 50 AZN, standart olaraq ümumi məbləğin 50%-dir.
4. Müştəri WhatsApp vasitəsilə menecerdən köçürmə məlumatını alır və ödəniş qəbzini göndərir.
5. Menecer bank hesabında real daxilolmanı yoxlayır və Admin paneldə ödənişi qeyd edir.
6. Avans tələbi ödənəndə rezervasiya təsdiqlənir. Ödəniş ayrıca reservation_payments jurnalına yazılır.
7. Hər ödəniş ayrıca Maliyyə layihəsinin finance_transactions jurnalına ötürülür; eyni payment ID ikinci dəfə gəlir yaratmır.
8. Qalan məbləğ check-in zamanı Admin paneldən ayrıca “Qalıq ödəniş” kimi yazılır.

MÜŞTƏRİ SAYTI
-------------
- Ev və tarix seçimi, mövcudluq yoxlaması, qiymət hesablaması.
- AZ / RU / EN interfeysi.
- WhatsApp əlaqəsi.
- Standart tariflə birbaşa rezervasiya; yeni booking formda kampaniya/paket seçimi yoxdur.
- Ödəniş bank köçürməsi + menecerin əl ilə təsdiqidir. Avtomatik bank təsdiqi və ya hazırkı müştəri axınında onlayn checkout olduğunu iddia etməyin.
- Kart PIN, CVV/CVC və SMS/OTP heç vaxt müştəridən istənilmir.

ADMIN GİRİŞİ
------------
- Admin panel e-poçt/şifrə ilə Supabase Auth istifadə edir.
- Rezervasiya və təqvim API-ləri eyni Auth access tokenini yoxlayır.
- Server yalnız app_metadata.role = 'admin' olan hesabı qəbul edir.
- Ayrı ADMIN_API_TOKEN və ikinci API parolu tələb olunmur.
- Supabase service_role açarı HTML-ə və ya GitHub-a yazılmamalıdır.

NETLIFY ENVIRONMENT VARIABLES
-----------------------------
Tələb olunur:
SUPABASE_URL = rezervasiya Supabase layihəsinin Project URL-i
SUPABASE_SERVICE_ROLE_KEY = həmin layihənin server/service_role secret açarı

İstəyə bağlı:
SITE_URL = https://qubatinyhouse.com
EPOINT_PRIVATE_KEY = yalnız Epoint checkout/callback real istifadəyə verilərsə

PAYMENT_BANK_NAME, PAYMENT_CARD_HOLDER, PAYMENT_CARD_NUMBER və ADMIN_API_TOKEN cari müştəri/admin axını üçün tələb olunmur.
Dəyərləri yalnız Netlify Environment Variables bölməsində saxlayın. Heç bir secret-i GitHub-a və ya ictimai HTML-ə əlavə etməyin. Dəyişiklikdən sonra Netlify-də yeni deploy yaradılmalıdır.

NETLIFY BUILD
-------------
Build command: npm install && npm run build
Publish directory: public
Functions directory: netlify/functions
Node bundler: esbuild

Deploy-dan sonra Netlify > Functions bölməsində bunların görünməsini yoxlayın:
- availability
- create-booking
- booking-status
- admin-reservations
- admin-blocked-dates
- admin-tariffs
- epoint-callback (yalnız Epoint istifadə edilirsə)

REZERVASİYA BAZASI — MÖVCUD CANLI LAYİHƏ
--------------------------------------
Mövcud canlı bazada supabase/schema.sql faylını yenidən işlətməyin. Bu, yalnız boş/yeni layihə üçün başlanğıc sxemidir.
Mövcud canlı məlumatlar üçün migration-ları layihədəki versiya sırası ilə tətbiq edin. Payment ledger migration mövcud reservation məlumatlarını silmir; köhnə paid_amount qeydlərini “tarixçədən bərpa edildi” qeydi ilə ayrıca ödəniş kimi backfill edir.
blocked_dates.id UUID-dir. Yeni kod və cədvəl sxemi UUID istifadə etməlidir.
pending_payment rezervasiyası 25 dəqiqəlik müvəqqəti hold-dur; müddət bitdikdə vaxtı keçmiş sorğu boşluğu saxlamamalıdır.

TARİFLƏR
--------
Canlı rezervasiya bazasında 6 evin real əsas tarifləri aktivdir:
- Orange House / White House: həftəiçi 120 AZN, həftəsonu/bayram 170 AZN.
- Blue House / Green House: həftəiçi 100 AZN, həftəsonu/bayram 150 AZN.
- A-FRAME-1 / A-FRAME-2: həftəiçi 150 AZN, həftəsonu/bayram 170 AZN.
Yay üçün mövsümi qiymət qeydləri 2026–2035 aralığında saxlanılır. Bayram tarifinin hesablanması üçün special_dates cədvəlinə faktiki bayram tarixləri daxil edilməlidir; bu cədvəl ilkin olaraq boş ola bilər.
Tarifləri müştəri saytına tətbiq edən əsas mənbə units, seasonal_rates, special_dates cədvəlləridir. Maliyyə layihəsindəki köhnə houses cədvəli müştəri saytının tarif mənbəyi deyil.

ÖDƏNİŞ TESTİ — CANLI MÜŞTƏRİ KİMİ DEYİL, ƏVVƏL TEST MÜHİTİNDƏ
----------------------------------------------------------------
1. Tarix, ev və qonaq sayını seçib boşluğu yoxlayın.
2. Test rezervasiyası yaradın və bron kodunu saxlayın.
3. Menecer/Admin ödənişi qeyd etməyənə qədər status “Avans gözlənilir” qalmalıdır.
4. Avans ödənişi əlavə edin: tarix, faktiki məbləğ, üsul və qeyd.
5. Avans minimum hesablanan behə çatanda status “Təsdiqlənib” olmalıdır.
6. Ödəniş tarixçəsində ayrıca payment row görünməlidir.
7. Maliyyə modulunda eyni məbləğ “Rezervasiya behi” kimi bir dəfə görünməlidir.
8. Qalıq ödənişi “Qalıq ödəniş” növü ilə daxil edin; Maliyyədə ayrıca sətir yaranmalıdır.
9. Eyni request-i təkrar göndərəndə eyni payment row və eyni finance transaction saxlanılmalıdır.
10. Təqvimdə tarix bağlayıb yenidən açın; UUID ID ilə işləməlidir.

MƏLUMATIN QORUNMASI
-------------------
- Rezervasiya ləğv ediləndə məlumatı fiziki silməyin; status və audit tarixçəsi saxlanılır.
- Köhnə kampaniya məlumatları yalnız tarixçə kimi saxlanılır. Yeni rezervasiya üçün kampaniya/paket seçimi yoxdur.
- Service role key, admin JWT, parol və bank təhlükəsizlik kodları heç vaxt repoya commit edilməməlidir.
