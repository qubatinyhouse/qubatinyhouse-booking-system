QUBA TINY HOUSE — ONLAYN REZERVASIYA + EPOINT ÖDƏNIŞİ
====================================================

BU NƏDİR?
- Müştəri sayt üzərindən ev növünü, giriş/çıxış tarixlərini və qonaq sayını seçir.
- Server Supabase rezervasiya bazasında boş/dolu tarixləri yoxlayır.
- Altı fiziki ev ayrıca idarə olunur: 2 kiçik Skandinav, 2 böyük Skandinav, 2 A-Frame isti hovuzlu.
- Bazada eyni ev üçün üst-üstə düşən rezervasiyaların yaranmasına verilənlər bazası səviyyəsində maneə qoyulur.
- Müştəri 30% və ya 40% avans seçir. Epoint checkout səhifəsində kartla ödəyir.
- Ödəniş Epoint-in imzalanmış server callback-i ilə təsdiqlənəndə rezervasiya confirmed olur və tarixlər tutulur.
- Ödəniş üçün 25 dəqiqəlik müvəqqəti tarix saxlanması var. Vaxt bitəndə növbəti rezervasiya zamanı köhnə hold expired edilir.

VACİB: BU PAKET HƏLƏ TƏNZİMLƏNMƏLİDİR. TƏSDİQLƏNMİŞ CANLI ÖDƏNİŞ KİMİ İSTİFADƏ ETMƏYİN.
Epoint merchant açarları və Supabase bazası istifadəçidə olmalıdır. Onlar olmadan real rezervasiya və ödəniş işləmir. Tariflər də başlanğıcda nümunədir; SQL-də is_demo_rate=true qoyulub ki, səhv qiymətlə ödəniş götürülməsin.

1) SUPABASE VERİLƏNLƏR BAZASINI YARAT
-------------------------------------
1. https://supabase.com aç, hesab yarat və New project ilə layihə yarat.
2. Supabase layihəsində SQL Editor aç.
3. Bu paketdəki supabase/schema.sql faylının hamısını kopyalayıb SQL Editor-a yapışdır və Run bas.
4. Table Editor-da units cədvəlində 6 ev yaradıldığını yoxla.

2) REAL QİYMƏTLƏRİ DAXİL ET
---------------------------
SQL-də units cədvəlində hər ev üçün bunları həqiqi tariflərlə dəyiş:
- weekday_rate: adi həftəiçi gecə qiyməti (AZN)
- weekend_rate: həftəsonu gecə qiyməti (AZN)
- holiday_rate: bayram gecəsi qiyməti (AZN)
- breakfast_rate_per_person: səhər yeməyinin bir nəfər / gecə qiyməti (AZN)
- is_demo_rate: real tarifləri daxil edəndən sonra false et.

NÜMUNƏDİR — canlı qiymət kimi götürməyin:
UPDATE public.units
SET weekday_rate = 150, weekend_rate = 180, holiday_rate = 250,
    breakfast_rate_per_person = 15, is_demo_rate = false
WHERE id IN ('scandi-small-1','scandi-small-2');

Yuxarıdakı rəqəmləri yalnız öz real tariflərinizlə əvəz etdikdən sonra işlədin. Bütün 6 evi ayrı-ayrılıqda düzgün sazlayın.

Xüsusi bayram tarixləri:
INSERT INTO public.special_dates(date,label,active)
VALUES ('2026-12-31','Yeni il',true), ('2027-01-01','Yeni il',true)
ON CONFLICT(date) DO UPDATE SET label=excluded.label, active=true;
Tarixləri öz bayram qiyməti siyasətinizə uyğun yeniləyin. Xüsusi tarixdə unit-in holiday_rate-i tətbiq olunur.

Mövsümi qiymət dövrü misalı:
INSERT INTO public.seasonal_rates(unit_id,start_date,end_date,nightly_rate,label,active)
VALUES ('scandi-small-1','2027-06-01','2027-09-01',220,'Yay mövsümü',true);
End_date daxil edilmir; məsələn yuxarıdakı dövr 31 avqust gecəsinə qədərdir. Digər evlər üçün ayrıca qeyd əlavə edin.

3) EPOINT MERCHANT HESABI AÇ
----------------------------
1. https://epoint.az/ saytında merchant kimi müraciət edin.
2. Epoint-ə sayt URL-i və uğurlu/uğursuz nəticə URL-lərini təqdim edin:
   Website: https://qubatinyhouse.com
   Success URL: https://qubatinyhouse.com/payment-success.html
   Error URL: https://qubatinyhouse.com/payment-error.html
   Result/callback URL: https://qubatinyhouse.com/.netlify/functions/epoint-callback
3. Epoint sizə public_key və private_key verdikdən sonra aşağıdakı Netlify mühit dəyişənlərinə daxil edin.
Ödəniş səhifəsi Epoint-də açılır; kart məlumatları bizim saytda saxlanmır.

4) NETLIFY MÜHİT DƏYİŞƏNLƏRİ
----------------------------
Netlify > qubatinyhouse layihəsi > Project configuration > Environment variables (və ya Build & deploy/Environment) hissəsində bu adları yaradın. Dəyərləri yalnız Netlify-a daxil edin; heç kimə, o cümlədən bu çata göndərməyin.

SUPABASE_URL = Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY = Supabase server/service_role secret key (yalnız server tərəfində)
EPOINT_PUBLIC_KEY = Epoint merchant public_key
EPOINT_PRIVATE_KEY = Epoint merchant private_key (məxfi)
SITE_URL = https://qubatinyhouse.com
EPOINT_REQUEST_URL = https://epoint.az/api/1/request  (istəyə bağlı; bu, standart dəyərdir)

Dəyişənlər Functions runtime üçün əlçatan olmalıdır. Dəyişəndən sonra redeploy edin.
Heç vaxt SUPABASE_SERVICE_ROLE_KEY və EPOINT_PRIVATE_KEY-i HTML-ə, GitHub-a və ya public fayla yazmayın.

5) NETLIFY FUNCTIONS NECƏ YAYIMLANIR
------------------------------------
Bu layihədə server functions var. Təkcə HTML/ZIP-i Netlify Drop-a sürükləmək backend funksiyalarını etibarlı şəkildə build/deploy etmir. Functions build prosesi zamanı netlify/functions qovluğundan hazırlanır.

Tövsiyə olunan yol:
1. ZIP-i öz kompüterinizdə açın.
2. Netlify layihəsində Project configuration > Developer settings > Continuous deployment > Repository bölməsinə girin.
3. Əgər görünürsə “Push to new repository” seçib GitHub-a qoşun; yoxdursa GitHub-da boş repository yaradıb bu qovluğun fayllarını ora yükləyin.
4. Netlify-ni həmin GitHub repository-yə bağlayın.
5. Build command: npm install && npm run build
   Publish directory: public
   Functions directory: netlify/functions
6. Deploy tamamlandıqdan sonra Netlify > Functions bölməsində availability, create-booking, epoint-callback və booking-status funksiyalarının göründüyünü yoxlayın.

6) ÖDƏNİŞDƏN ƏVVƏL TEST
-----------------------
1. Saytda əvvəl giriş/çıxış, qonaq sayı və ev növü seçin.
2. “Boş tarixləri və evləri yoxla” düyməsini basın.
3. Boş evlər listdə görünməlidir; rezervasiya yarandıqdan sonra ödəniş üçün Epoint-ə keçəcək.
4. Ödəniş başa çatanda Epoint result callback statusu imza ilə yoxlayır, sonra rezervasiyanı confirmed edir.
5. Supabase > Table Editor > reservations cədvəlində statusları yoxlayın.
6. Ödənişli canlı istifadədən əvvəl Epoint ilə test/merchant hesabının yoxlamasını tamamlayın, hər 6 evin real qiymətlərini və bayram/mövsüm tarixlərini yoxlayın.

STATUSLAR
- pending_payment: avans ödənilməsini gözləyir, 25 dəqiqəlik müvəqqəti hold.
- confirmed: Epoint callback-i təsdiq edib; tarixlər bağlıdır.
- expired: ödəniş hold-u vaxtı bitib.
- payment_failed: checkout uğursuz olub.
- payment_review: ödəniş alınıb, amma məbləğ/tarix münaqişəsi yoxlanmalıdır.
- cancelled: admin tərəfindən ləğv üçün status.

Admin əməliyyatı üçün Supabase Dashboard > Table Editor > reservations istifadə edin. Ödənişi geri qaytarmaq üçün Epoint kabinetində refund prosesini ayrıca icra edin; bu paket avtomatik refund etmir.
