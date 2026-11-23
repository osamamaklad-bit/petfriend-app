/* Pet Friend: English / Arabic.
 *
 * Loaded by the main page and by every tool. English is the default; the choice is saved on the
 * phone (localStorage "pf_lang") and shared by all tabs. In Arabic the page is right-to-left.
 *
 * How it works: the screens are written in English. This file watches the page and swaps every
 * English text it knows (whole text, or one of the PATTERNS) for the Arabic, and swaps it back when
 * you return to English. Product names, customers and order numbers are left as they are.
 * To translate a new message, add it to EXACT (fixed text) or PATTERNS (text with numbers/names).
 */
(function () {
  'use strict';
  var KEY = 'pf_lang';

  var EXACT = {
    // ---- main page
    'POS': 'نقطة البيع',
    'Orders': 'الطلبات',
    'Shipments': 'الشحنات',
    'Point of sale': 'نقطة البيع',
    'Fulfill and returns': 'التجهيز والمرتجعات',
    'Shipment photos': 'صور الشحنات',
    'Pick list': 'قائمة التجميع',
    'Pet Friend Today': 'بتفريند اليوم',
    "Today's work in one place.": 'شغل اليوم في مكان واحد.',
    'POS sales': 'مبيعات الكاشير',
    'Orders fulfilled': 'طلبات تم تجهيزها',
    'Received': 'تم استلامه',
    'Pick lists': 'قوائم التجميع',
    'Errors today': 'أخطاء اليوم',
    'No errors today.': 'لا توجد أخطاء اليوم.',
    'all good': 'كله تمام',
    'see the list below': 'انظر القائمة بالأسفل',
    'waiting to be fulfilled': 'في انتظار التجهيز',
    'Could not read POS sales': 'تعذر قراءة مبيعات الكاشير',
    'Loading...': 'جارٍ التحميل...',
    'Check': 'كشف',
    'Pet Friend Check': 'كشف منتج - بتفريند',
    'Check a product': 'كشف منتج',
    'Check a product: scan its barcode, or type a SKU or name.': 'كشف منتج: امسح الباركود، أو اكتب الـ SKU أو الاسم.',
    'Barcode, SKU or name': 'باركود أو SKU أو اسم',
    'In stock:': 'المخزون:',
    'not tracked': 'غير متتبَّع',
    'Bin:': 'الرف:',
    'Print label': 'طباعة ملصق',
    'Draft': 'مسودة',
    'Archived': 'مؤرشف',
    "Can't reach the server. Check the internet, or try another network (for example mobile data).": 'مش قادر يوصل للسيرفر. اتأكد من النت، أو جرب شبكة تانية (مثلاً بيانات الموبايل).',
    'The server sent an unexpected reply. Try again in a minute.': 'السيرفر رد برد غير متوقع. جرب تاني بعد دقيقة.',
    'Expiry dates': 'تواريخ الصلاحية',
    'Pet Friend': 'بتفريند',
    'Every item needs a barcode in Shopify before labels can be printed. Without a barcode:': 'لازم كل منتج يكون له باركود في شوبيفاي قبل طباعة الملصقات. المنتجات اللي ملهاش باركود:',
    'Label 50 × 25 mm · name, SKU, expiry date, barcode and bins': 'ملصق 50 × 25 مم · الاسم، الـ SKU، الصلاحية، الباركود والرفوف',
    'Labels = the quantity of each product in the purchase order.': 'عدد الملصقات = كمية كل منتج في أمر الشراء.',
    'Every item needs a barcode, a variant bin and a product bin in Shopify before labels can be printed:': 'لازم كل منتج يكون له باركود وموقع للمتغيّر وموقع للمنتج في شوبيفاي قبل طباعة الملصقات:',
    'barcode': 'باركود', 'variant bin': 'موقع المتغيّر', 'product bin': 'موقع المنتج', 'missing': 'ناقص',
    'Print here': 'اطبع من هنا',
    'Save PDF to Drive': 'حفظ PDF في جوجل درايف',
    'Saving...': 'جارٍ الحفظ...',
    'Open in Drive': 'فتح في درايف',
    "Can't load the PDF maker. Check the internet and try again.": 'تعذر تحميل أداة الـ PDF. اتأكد من النت وجرب تاني.',
    'Edit bin / expiry': 'تعديل الرف / الصلاحية',
    'Variant bin': 'موقع المتغيّر',
    'Expiry date of previous batch': 'تاريخ صلاحية الدفعة السابقة',
    'Previous batch expiry:': 'صلاحية الدفعة السابقة:',
    'Previous batch:': 'الدفعة السابقة:',
    'Edit expiry dates': 'تعديل تواريخ الصلاحية',
    'Product bin': 'موقع المنتج',
    'Several bins: separate them with commas.': 'أكثر من رف: افصل بينهم بفاصلة.',
    'Long-press a purchase order to remove it from the list.': 'اضغط مطولاً على أمر الشراء لحذفه من القائمة.',
    'Home': 'الرئيسية',
    'POS pass': 'باسورد الكاشير',
    'Orders pass': 'باسورد الطلبات',
    'Shipments pass': 'باسورد الشحنات',
    'The same pass opens Orders, Check, Purchase orders, Pick list and Today.': 'نفس الباسورد بيفتح الطلبات، والكشف، وأوامر الشراء، وقائمة التجميع، واليوم.',
    'The same pass opens Shipments and Return shipments.': 'نفس الباسورد بيفتح الشحنات والشحنات المرتجعة.',
    'Open Settings and enter the POS pass.': 'افتح الإعدادات واكتب باسورد الكاشير.',
    'Open Settings and enter the Orders pass.': 'افتح الإعدادات واكتب باسورد الطلبات.',
    'Open Settings and enter the Shipments pass.': 'افتح الإعدادات واكتب باسورد الشحنات.',
    'Open Settings and enter the API URL and Orders pass.': 'افتح الإعدادات واكتب رابط السيرفر وباسورد الطلبات.',
    'Enter the Orders pass in Settings': 'اكتب باسورد الطلبات في الإعدادات',
    'Set the API URL and Orders pass in Settings': 'اكتب رابط السيرفر وباسورد الطلبات في الإعدادات',
    'Wrong POS pass': 'باسورد الكاشير غلط',
    'Wrong Orders pass': 'باسورد الطلبات غلط',
    'Wrong Shipments pass. Open Settings and enter it again.': 'باسورد الشحنات غلط. افتح الإعدادات واكتبه تاني.',
    'Remove': 'حذف',
    'Show again': 'إظهار',
    'Hide removed purchase orders': 'إخفاء أوامر الشراء المحذوفة',
    'Pet Friend Purchase Orders': 'أوامر الشراء - بتفريند',
    'Pet Friend Return Shipments': 'شحنات مرتجعة - بتفريند',
    'Return shipments': 'شحنات مرتجعة',
    'Return Shipments': 'الشحنات المرتجعة',
    'Save return': 'حفظ مرتجع',
    'Save tracking': 'حفظ رقم التتبع',
    'Already fulfilled': 'تم تجهيزه بالفعل',
    'Already fulfilled. Scan the Bosta waybill, then tap Save tracking.': 'الطلب متجهز بالفعل. امسح بوليصة بوسطة، وبعدين دوس حفظ رقم التتبع.',
    'Tracking already on this order:': 'رقم تتبع موجود على الطلب:',
    'Scan the Bosta waybill to save its tracking number (optional).': 'امسح بوليصة بوسطة لحفظ رقم التتبع (اختياري).',
    'Bosta tracking:': 'تتبع بوسطة:',
    'Remove tracking': 'إزالة التتبع',
    'Tracking removed.': 'تمت إزالة رقم التتبع.',
    'Discount cannot be negative': 'الخصم لا يمكن أن يكون بالسالب',
    'Camera scanning is not available here. Type the code or use a scanner.': 'المسح بالكاميرا غير متاح هنا. اكتب الكود أو استخدم الماسح.',
    'Create return': 'إنشاء المرتجع',
    'Discard': 'تجاهل المسح',
    'Create': 'إنشاء',
    'OK': 'تمام',
    'Return shipment: scan the label of the package that came back, then photograph it.': 'شحنة مرتجعة: امسح بوليصة الشحنة اللي رجعت، وبعدين صوّرها.',
    'Returned': 'مرتجعة',
    'Return photo': 'صورة مرتجع',
    '✓ Finished': '✓ انتهت',
    'Finished': 'منتهية',
    'Open again': 'فتحها من جديد',
    'Mark this pick list as finished? It will be hidden from the list.': 'تأكيد إن القائمة دي خلصت؟ هتختفي من القوايم.',
    'Pick list finished and hidden.': 'القائمة خلصت واتخفت.',
    'Pick list opened again.': 'القائمة اتفتحت من جديد.',
    'Every pick list is finished.': 'كل القوايم خلصت.',
    'Hide finished pick lists': 'إخفاء القوايم المنتهية',
    'Bulky shipments today': 'شحنات بالكي اليوم',
    'Hourly Bosta check is off': 'فحص بوسطة كل ساعة متوقف',
    'Bosta check never ran': 'فحص بوسطة لم يعمل بعد',
    'Expired': 'منتهي',
    '30 days': '30 يوم', '60 days': '60 يوم', '90 days': '90 يوم',
    'In stock only': 'الموجود بالمخزون فقط',
    'Print labels': 'طباعة ملصقات',
    '↻ Check again': '↻ فحص من جديد',
    'Could not read expiry dates': 'تعذر قراءة تواريخ الصلاحية',
    'Checking expiry dates...': 'جارٍ فحص تواريخ الصلاحية...',
    'Nothing expired.': 'لا يوجد منتج منتهي الصلاحية.',
    'Nothing expires in this period.': 'لا توجد منتجات تنتهي صلاحيتها في هذه الفترة.',
    'Expiring in 30 days': 'تنتهي خلال 30 يوم',
    'none expired in stock': 'لا يوجد منتهي بالمخزون',
    'Expires today': 'تنتهي اليوم',
    'Label size': 'مقاس الملصق',
    'Copies': 'عدد النسخ',
    'No SKU or barcode: add one in Shopify': 'لا يوجد SKU أو باركود: أضفه في شوبيفاي',
    'Label 50 × 25 mm': 'ملصق 50 × 25 مم',
    'Label 40 × 30 mm': 'ملصق 40 × 30 مم',
    'Label 58 × 40 mm': 'ملصق 58 × 40 مم',
    'A4 sheet (3 × 7)': 'ورقة A4 (3 × 7)',
    'Pet Friend Pick List': 'قائمة تجميع بتفريند',
    'Print': 'طباعة',
    'Hide picked': 'إخفاء ما تم تجميعه',
    '＋ Create pick list now': '＋ إنشاء قائمة الآن',
    '‹ Back': '‹ رجوع',
    'Manual': 'يدوي',
    'Automatic': 'تلقائي',
    'picked': 'تم تجميعه',
    'Pick lists are made automatically from 10:00 to 14:00 when new orders qualify (paid, or tagged "confirmed").': 'تُنشأ قوائم التجميع تلقائيًا من 10:00 إلى 14:00 عند وجود طلبات جديدة مستوفية للشروط (مدفوعة، أو عليها تاج "confirmed").',
    'Tap a pick list to open it.': 'اضغط على القائمة لفتحها.',
    'No pick lists in the last 7 days.': 'لا توجد قوائم تجميع في آخر 7 أيام.',
    'Create a pick list now with the new orders that qualify?': 'إنشاء قائمة تجميع الآن بالطلبات الجديدة المستوفية للشروط؟',
    'Creating pick list...': 'جارٍ إنشاء قائمة التجميع...',
    'No new orders to pick: every qualifying order is already on a pick list.': 'لا توجد طلبات جديدة للتجميع: كل الطلبات المستوفية للشروط موجودة في قوائم سابقة.',
    'Pick list not found': 'قائمة التجميع غير موجودة',
    'More than 1000 orders are waiting: create another pick list for the rest.': 'يوجد أكثر من 1000 طلب في الانتظار: أنشئ قائمة أخرى للباقي.',
    'Loading pick list...': 'جارٍ تحميل قائمة التجميع...',
    'Sorted by bin location. Tap a line when it is picked.': 'مرتبة حسب موقع التخزين. اضغط على السطر عند تجميعه.',
    'No orders to pick right now.': 'لا توجد طلبات للتجميع الآن.',
    'pcs': 'قطعة',
    'Tools': 'الأدوات',
    'Language': 'اللغة',
    'Cancel': 'إلغاء',
    'Show': 'إظهار',
    'Hide': 'إخفاء',
    'Open Settings and enter the PIN.': 'افتح الإعدادات وأدخل الرقم السري.',
    'Wrong PIN. Open Settings and enter it again.': 'رقم سري خاطئ. افتح الإعدادات وأدخله مرة أخرى.',
    'Pet Friend POS': 'نقطة بيع بتفريند',

    // ---- Orders (fulfill + returns)
    'Pet Friend Orders': 'طلبات بتفريند',
    'Fulfill': 'تجهيز',
    'Returns': 'المرتجعات',
    'Settings': 'الإعدادات',
    'Order number': 'رقم الطلب',
    'Load': 'فتح',
    'Camera': 'الكاميرا',
    'Stop': 'إيقاف',
    'Pick an order, scan its barcode, or type the number.': 'اختر طلبًا، أو امسح الباركود الخاص به، أو اكتب رقمه.',
    'Open orders': 'الطلبات المفتوحة',
    'All': 'الكل',
    'Unfulfilled': 'غير مُجهز',
    'Partial': 'جزئي',
    '↻ Refresh': '↻ تحديث',
    'Refresh': 'تحديث',
    'items': 'منتجات',
    'loading...': 'جارٍ التحميل...',
    'No orders to show.': 'لا توجد طلبات.',
    'fulfilled': 'تم التجهيز',
    'on hold': 'معلّق',
    'scheduled': 'مجدول',
    'in progress': 'قيد التنفيذ',
    'open': 'مفتوح',
    'Return reason': 'سبب الإرجاع',
    'Reason: not given': 'السبب: غير محدد',
    'Customer changed their mind': 'العميل غيّر رأيه',
    'Damaged or defective': 'تالف أو به عيب',
    'Wrong item sent': 'تم إرسال منتج خاطئ',
    'Not as described': 'غير مطابق للوصف',
    'Size too small': 'المقاس صغير',
    'Size too large': 'المقاس كبير',
    'Style': 'التصميم',
    'Color': 'اللون',
    'Other': 'أخرى',
    'Restock': 'إرجاع للمخزون',
    'Clear': 'مسح',
    'Email customer': 'إبلاغ العميل بالبريد',
    'Return': 'إرجاع',
    'Receive': 'استلام',
    'Purchase orders': 'أوامر الشراء',
    'PO number': 'رقم أمر الشراء',
    'Item barcode or SKU': 'باركود المنتج أو SKU',
    'Item barcode': 'باركود المنتج',
    'Rejected': 'مرفوض',
    'Cancelled': 'ملغي',
    'Less rejected': 'تقليل المرفوض', 'More rejected': 'زيادة المرفوض',
    'Less cancelled': 'تقليل الملغي', 'More cancelled': 'زيادة الملغي',
    'Point the camera at an item barcode': 'وجّه الكاميرا نحو باركود المنتج',
    'No barcode or SKU: add one in Shopify to scan this item': 'بدون باركود أو SKU: أضف واحدًا في Shopify لمسح هذا المنتج',
    'Scan the barcode to unlock + / −': 'امسح كود المنتج لتفعيل + / −',
    'Scan the barcode of every item first': 'امسح باركود كل منتج أولاً',
    'Add': 'إضافة',
    'Variant bin:': 'موقع المتغيّر:',
    'Product bin:': 'موقع المنتج:',
    'Expiry:': 'تاريخ الانتهاء:',
    '(expired)': '(منتهي الصلاحية)',
    'Edit': 'تعديل',
    'Edit expiry': 'تعديل تاريخ الانتهاء',
    'Variant bin location': 'موقع تخزين المتغيّر',
    'Product bin location': 'موقع تخزين المنتج',
    'Expiry date': 'تاريخ الانتهاء',
    'No changes': 'لا توجد تغييرات',
    'Expiry date must be a date (YYYY-MM-DD)': 'يجب أن يكون تاريخ الانتهاء تاريخًا (YYYY-MM-DD)',
    'Item not found in Shopify': 'المنتج غير موجود في Shopify',
    'Ordered': 'تم الطلب',
    'No purchase orders waiting for stock.': 'لا توجد أوامر شراء في انتظار البضاعة.',
    'Receive: pick a purchase order, or scan or type its number.': 'الاستلام: اختر أمر شراء، أو امسح رقمه أو اكتبه.',
    'Enter a purchase order number': 'أدخل رقم أمر الشراء',
    'Nothing to receive': 'لا يوجد ما يتم استلامه',
    'Remove one': 'إزالة واحد',
    'Add one': 'إضافة واحد',
    'All items scanned. Ready to fulfill.': 'تم مسح كل المنتجات. جاهز للتجهيز.',
    'Camera blocked. Allow camera access and use an https page.': 'الكاميرا محجوبة. اسمح بالوصول إلى الكاميرا واستخدم صفحة https.',
    'Scan or type an order number to start a return.': 'امسح أو اكتب رقم الطلب لبدء الإرجاع.',
    'Returns: scan the order barcode on the packing slip, or type the number.': 'المرتجعات: امسح باركود الطلب من بوليصة الشحن، أو اكتب الرقم.',
    'Set the API URL and key in Settings': 'أدخل رابط الخادم والمفتاح في الإعدادات',
    'Request failed': 'فشل الطلب',
    'Open Settings and enter the API URL and app key.': 'افتح الإعدادات وأدخل رابط الخادم ومفتاح التطبيق.',
    'Open Settings and enter the app key.': 'افتح الإعدادات وأدخل مفتاح التطبيق.',
    'Enter the app key in Settings': 'أدخل مفتاح التطبيق في الإعدادات',
    'Apps Script web app URL': 'رابط تطبيق Apps Script',
    'App key': 'مفتاح التطبيق',
    'The items will be put back into stock.': 'سيتم إرجاع المنتجات إلى المخزون.',
    'The items will NOT be restocked.': 'لن يتم إرجاع المنتجات إلى المخزون.',

    // ---- Shipments
    'Pet Friend Shipments': 'شحنات بتفريند',
    'Lock': 'قفل',
    'PIN': 'الرقم السري',
    'Open': 'دخول',
    'Save': 'حفظ',
    'Search': 'بحث',
    'Scan': 'مسح',
    'Other carrier / no tracking': 'شركة شحن أخرى / بدون تتبع',
    'Back to Bosta': 'العودة إلى بوسطة',
    'Carrier (Aramex, J&T, courier...)': 'شركة الشحن (أرامكس، J&T، مندوب...)',
    'Reference (empty = auto code)': 'المرجع (فارغ = كود تلقائي)',
    'Last 10 digits of barcode': 'آخر 10 أرقام من الباركود',
    'Take photo': 'التقاط صورة',
    'Note (optional)': 'ملاحظة (اختياري)',
    'Add photo anyway': 'أضف الصورة على أي حال',
    'Tracking number or code': 'رقم التتبع أو الكود',
    'Private courier': 'مندوب خاص',
    'Wrong PIN, try again': 'رقم سري خاطئ، حاول مرة أخرى',
    'Wrong PIN': 'رقم سري خاطئ',
    'Scan or type the tracking number, then take the photo': 'امسح أو اكتب رقم التتبع، ثم التقط الصورة',
    'Point the camera at the barcode...': 'وجّه الكاميرا نحو الباركود...',
    'Camera blocked here. Type the number or take a photo of the label instead.': 'الكاميرا محجوبة هنا. اكتب الرقم أو صوّر الملصق بدلاً من ذلك.',
    'Choose the carrier first': 'اختر شركة الشحن أولاً',
    'Saving...': 'جارٍ الحفظ...',
    'Searching...': 'جارٍ البحث...',
    'Not synced with Bosta yet': 'لم تتم المزامنة مع بوسطة بعد',
    'Need at least 10 digits of the barcode': 'مطلوب 10 أرقام على الأقل من الباركود',
    'Add at least one photo': 'أضف صورة واحدة على الأقل',
    'Bad request': 'طلب غير صالح',

    // ---- POS
    'Today': 'اليوم',
    'Scan or type barcode / name': 'امسح أو اكتب الباركود / الاسم',
    'Discount': 'الخصم',
    'EGP': 'ج.م',
    'Cash received': 'المبلغ المستلم',
    'Complete cash sale': 'إتمام البيع نقدًا',
    'Searching…': 'جارٍ البحث…',
    'Price': 'السعر',
    'Cart is empty': 'السلة فارغة',
    'Discount cannot exceed 100%': 'لا يمكن أن يتجاوز الخصم 100%',
    'Discount is more than the cart total': 'الخصم أكبر من إجمالي السلة',
    'Cash received is less than the total': 'المبلغ المستلم أقل من الإجمالي',
    'Saving sale…': 'جارٍ حفظ عملية البيع…',
    'PetFriend Stores': 'متاجر بتفريند',
    'Thank you!': 'شكرًا لك!',
    'Camera scanning is not supported in this browser. Use Chrome on Android or a scanner.': 'المسح بالكاميرا غير مدعوم في هذا المتصفح. استخدم Chrome على أندرويد أو قارئ باركود.'
  };

  // Text with names / numbers in it. First match wins, so specific ones come before general ones.
  var PATTERNS = [
    // Orders
    [/^Loading order (.+)\.\.\.$/, 'جارٍ تحميل الطلب $1...'],
    [/^Order (.+) has nothing to return \(not shipped yet, or already returned\)\.$/, 'الطلب $1 لا يحتوي على منتجات قابلة للإرجاع (لم يُشحن بعد، أو تم إرجاعه بالفعل).'],
    [/^Order (.+): scan each item being returned\.$/, 'الطلب $1: امسح كل منتج يتم إرجاعه.'],
    [/^Order (.+) loaded\. Scan the items\.$/, 'تم فتح الطلب $1. امسح المنتجات.'],
    [/^Order (.+) fulfilled\. Scan the next order\.$/, 'تم تجهيز الطلب $1. امسح الطلب التالي.'],
    [/^(\d+) orders?$/, '$1 طلب'],
    [/^Not returnable on this order: (.+)$/, 'غير قابل للإرجاع في هذا الطلب: $1'],
    [/^Not in this order: (.+)$/, 'ليس ضمن هذا الطلب: $1'],
    [/^Too many: only (\d+) (.+) can be returned$/, 'عدد زائد: يمكن إرجاع $1 فقط من $2'],
    [/^Too many: (.+) \(need (\d+)\)$/, 'عدد زائد: $1 (المطلوب $2)'],
    [/^(.+): returning (\d+) of (\d+)\. Every returnable item scanned\.$/, '$1: إرجاع $2 من $3. تم مسح كل المنتجات القابلة للإرجاع.'],
    [/^(.+): returning (\d+) of (\d+)$/, '$1: إرجاع $2 من $3'],
    [/^(\d+) to return · (\d+) returnable$/, '$1 للإرجاع · $2 قابل للإرجاع'],
    [/^(\d+) of (\d+) items$/, '$1 من $2 منتج'],
    [/^Return (\d+) items?$/, 'إرجاع $1 منتج'],
    [/^Create a return for (\d+) items? on (.+)\?$/, 'إنشاء مرتجع لعدد $1 منتج من الطلب $2؟'],
    [/^Creating return for (.+)\.\.\.$/, 'جارٍ إنشاء المرتجع للطلب $1...'],
    [/^Return (.*) created for (.+), items restocked\. Issue the refund in Shopify admin\.$/, 'تم إنشاء المرتجع $1 للطلب $2 وإرجاع المنتجات إلى المخزون. نفّذ استرداد المبلغ من لوحة Shopify.'],
    [/^Return (.*) created for (.+)\. Issue the refund in Shopify admin\.$/, 'تم إنشاء المرتجع $1 للطلب $2. نفّذ استرداد المبلغ من لوحة Shopify.'],
    [/^Fulfilling (.+)\.\.\.$/, 'جارٍ تجهيز الطلب $1...'],
    [/^Discard the scans for (.+)\?$/, 'تجاهل المسح الخاص بالطلب $1؟'],
    [/^(.*)no barcode$/, '$1بدون باركود'],

    // camera strip: "✓ message" / "✗ message"
    [/^([✓✗]) ([\s\S]+)$/, function (m, mark, rest) { return mark + ' ' + toArabic(rest); }],
    [/^Error: (.+)$/, 'خطأ: $1'],
    [/^Shopify barcode \/ SKU: (.+)$/, 'باركود / SKU في Shopify: $1'],
    // Pick list
    [/^(\d+) orders? · (\d+) products? · (\d+) units$/, '$1 طلب · $2 منتج · $3 قطعة'],
    [/^Picked (\d+) of (\d+)$/, 'تم تجميع $1 من $2'],
    [/^Orders fulfilled: (\d+) of (\d+) · tap an order to fulfill it$/, 'طلبات تم تجهيزها: $1 من $2 · اضغط على الطلب لتجهيزه'],
    [/^(\d+) units$/, '$1 قطعة'],
    [/^(\d+) sales?$/, '$1 عملية بيع'],
    [/^(\d+) shipments?$/, '$1 شحنة'],
    [/^(\d+) orders?$/, '$1 طلب'],
    [/^Updated (.+)$/, 'آخر تحديث $1'],
    [/^Labels saved to Google Drive: ([\s\S]+)$/, 'الملصقات اتحفظت في جوجل درايف: $1'],
    [/^Saved for ([\s\S]+)$/, 'تم الحفظ لـ $1'],
    [/^Show removed purchase orders \((\d+)\)$/, 'عرض أوامر الشراء المحذوفة ($1)'],
    [/^Remove (\S+) from the app\? It stays in Shopify, and you can show it again\.$/, 'حذف $1 من التطبيق؟ سيبقى كما هو في شوبيفاي، وتقدر تظهره تاني.'],
    [/^(\S+) removed from the list\.$/, 'تم حذف $1 من القائمة.'],
    [/^(\S+) is back in the list\.$/, 'رجع $1 للقائمة.'],
    [/^Remove (\S+)$/, 'حذف $1'],
    [/^Show again (\S+)$/, 'إظهار $1'],
    [/^Order (\S+) is already fulfilled\. Scan its Bosta waybill to add the tracking number\.$/, 'الطلب $1 متجهز بالفعل. امسح بوليصة بوسطة الخاصة به لإضافة رقم التتبع.'],
    [/^Bosta waybill (\S+) scanned\. Tap Save tracking\.$/, 'تم مسح بوليصة بوسطة $1. دوس حفظ رقم التتبع.'],
    [/^Saving tracking (\S+) on (\S+)\.\.\.$/, 'جارٍ حفظ رقم التتبع $1 على $2...'],
    [/^Bosta tracking (\S+) added to order (\S+)\.$/, 'تمت إضافة رقم تتبع بوسطة $1 للطلب $2.'],
    [/^Tracking (\S+) was already on order (\S+)\.$/, 'رقم التتبع $1 موجود بالفعل على الطلب $2.'],
    [/^Checking waybill (.+) with Bosta\.\.\.$/, 'جارٍ التحقق من البوليصة $1 مع بوسطة...'],
    [/^Not in this order, and not a Bosta waybill: (.+)$/, 'ليس ضمن هذا الطلب، وليس بوليصة بوسطة: $1'],
    [/^Waybill (\S+) is for order (\S+) in Bosta, not (\S+)$/, 'البوليصة $1 خاصة بالطلب $2 في بوسطة، وليس $3'],
    [/^Bosta waybill (\S+) added\. It will be saved with the fulfillment\.$/, 'تمت إضافة بوليصة بوسطة $1، وسيتم حفظها مع التجهيز.'],
    [/^Order (\S+) fulfilled with Bosta tracking (\S+)\. Scan the next order\.$/, 'تم تجهيز الطلب $1 برقم تتبع بوسطة $2. امسح الطلب التالي.'],
    [/^Return saved: (\d+)(\. Scan the next one\.\.\.)?$/, function (m, n, nx) { return 'تم حفظ المرتجع: ' + n + (nx ? '. امسح اللي بعده...' : ''); }],
    [/^Return (\d+) is already saved \((.+)\)\. Not duplicated\.$/, 'المرتجع $1 محفوظ قبل كده ($2). لم يتكرر.'],
    [/^(\d+) return photos?$/, '$1 صورة مرتجع'],
    [/^Show finished pick lists \((\d+)\)$/, 'عرض القوايم المنتهية ($1)'],
    [/^Last Bosta check (.+)$/, 'آخر فحص لبوسطة $1'],
    [/^(\d+) shipments? checked$/, 'تم فحص $1 شحنة'],
    [/^(\d+) failed$/, '$1 فشل'],
    [/^(\d+) shipments followed$/, '$1 شحنة تحت المتابعة'],
    [/^Checking ([\s\S]+)\.\.\.$/, 'جارٍ كشف $1...'],
    [/^Not found in Shopify: ([\s\S]+)$/, 'غير موجود في شوبيفاي: $1'],
    [/^(\d+) products found for ([\s\S]+)$/, 'تم العثور على $1 منتج لـ $2'],
    [/^Checked (\d+) products, (\d+) with an expiry date( \(list cut short\))? · (.+)$/, function (m, a, b, c, t) { return 'تم فحص ' + a + ' منتج، ' + b + ' منها بتاريخ صلاحية' + (c ? ' (القائمة مختصرة)' : '') + ' · ' + t; }],
    [/^Expired (\d+) days? ago$/, 'انتهت منذ $1 يوم'],
    [/^(\d+) days? left$/, 'باقي $1 يوم'],
    [/^ ?(\d+) in stock$/, ' $1 بالمخزون'],
    [/^(\d+) expired in stock$/, '$1 منتهي بالمخزون'],
    [/^(\d+) labels?$/, '$1 ملصق'],
    [/^(\d+) orders? · (\d+) products?$/, '$1 طلب · $2 منتج'],
    [/^New pick list: (\d+) orders?, (\d+) products?\.$/, 'قائمة تجميع جديدة: $1 طلب، $2 منتج.'],
    [/^Pick list created: (\d+) orders?, (\d+) products?\.$/, 'تم إنشاء قائمة التجميع: $1 طلب، $2 منتج.'],
    // Receiving from suppliers
    [/^Loading purchase order (.+)\.\.\.$/, 'جارٍ تحميل أمر الشراء $1...'],
    [/^Saved expiry date for (.+)$/, 'تم حفظ تاريخ الانتهاء لـ $1'],
    [/^Scan the barcode of (.+) first$/, 'امسح باركود $1 أولاً'],
    [/^(.+) from (.+): scan each item that arrived\.$/, '$1 من $2: امسح كل منتج وصل.'],
    [/^(.+): scan each item that arrived\.$/, '$1: امسح كل منتج وصل.'],
    [/^(\d+) purchase orders?$/, '$1 أمر شراء'],
    [/^Not on this purchase order: (.+)$/, 'ليس ضمن أمر الشراء هذا: $1'],
    [/^Too many: only (\d+) (.+) expected$/, 'عدد زائد: المتوقع $1 فقط من $2'],
    [/^(.+): received (\d+) of (\d+)\. Everything on this purchase order scanned\.$/, '$1: تم استلام $2 من $3. تم مسح كل منتجات أمر الشراء.'],
    [/^(.+): received (\d+) of (\d+)$/, '$1: تم استلام $2 من $3'],
    [/^(\d+) received( · (\d+) rejected)?( · (\d+) cancelled)? · (\d+) expected$/, function (m, a, r1, r, c1, c, e) {
      return a + ' مستلم' + (r1 ? ' · ' + r + ' مرفوض' : '') + (c1 ? ' · ' + c + ' ملغي' : '') + ' · ' + e + ' متوقع'; }],
    [/^(.+): received (\d+) of (\d+) \((\d+) extra\)$/, '$1: تم استلام $2 من $3 ($4 زيادة)'],
    [/^\+(\d+) extra$/, '+$1 زيادة'],
    [/^(\d+) extra$/, '$1 زيادة'],
    [/^(\d+) of them are extra \(more than ordered\)\.$/, 'منها $1 زيادة (أكثر من المطلوب).'],
    [/^(\d+) rejected\.$/, '$1 مرفوض.'],
    [/^(\d+) cancelled\.$/, '$1 ملغي.'],
    [/^(\d+) rejected$/, '$1 مرفوض'],
    [/^(\d+) cancelled$/, '$1 ملغي'],
    [/^Rejected \+ cancelled cannot be more than expected \((\d+)\)$/, 'المرفوض + الملغي لا يمكن أن يزيد عن المتوقع ($1)'],
    [/^Too many rejected \/ cancelled for one item \(more than expected\)$/, 'المرفوض / الملغي أكثر من المتوقع لمنتج واحد'],
    [/^Receive (\d+) items?$/, 'استلام $1 منتج'],
    [/^Receive (\d+) items? from (.+) into stock\?$/, 'استلام $1 منتج من $2 إلى المخزون؟'],
    [/^(\d+) not scanned will stay open on the purchase order\.$/, '$1 غير ممسوح سيبقى مفتوحًا في أمر الشراء.'],
    [/^Receiving (.+)\.\.\.$/, 'جارٍ استلام $1...'],
    [/^Received (\d+) items? from (.+) into stock\.$/, 'تم استلام $1 منتج من $2 إلى المخزون.'],
    [/^Purchase order (.+) not found \(or not marked as ordered\)$/, 'أمر الشراء $1 غير موجود (أو لم يتم تعليمه كمطلوب)'],
    [/^Purchase order (.+) has nothing left to receive$/, 'أمر الشراء $1 لا يحتوي على منتجات متبقية للاستلام'],
    [/^(\d+) items were received, then it stopped: (.+)$/, 'تم استلام $1 منتج، ثم توقف: $2'],

    // Shipments
    [/^(.+) just handled\. Move to the next label\.$/, 'تم التعامل مع $1 للتو. انتقل إلى الملصق التالي.'],
    [/^Got (.+)\. Now take the photo\.$/, 'تمت قراءة $1. الآن التقط الصورة.'],
    [/^Saved (\d+) photo\(s\) · (.+)$/, 'تم حفظ $1 صورة · $2'],
    [/^(.+) is already saved \((.*)\)\. Not duplicated\.$/, '$1 محفوظ بالفعل ($2). لم يتم التكرار.'],
    [/^Saved (.+)\. Scan the next one\.\.\.$/, 'تم حفظ $1. امسح التالي...'],
    [/^Saved (.+)$/, 'تم حفظ $1'],
    [/^Saving (.+)\.\.\.$/, 'جارٍ حفظ $1...'],
    [/^Nothing saved for (.+)$/, 'لا يوجد شيء محفوظ لـ $1'],
    [/^(.+) not found in Bosta\. Misread, scan again\.$/, '$1 غير موجود في بوسطة. قراءة خاطئة، امسح مرة أخرى.'],
    [/^(.*) · size (.+)$/, '$1 · المقاس $2'],
    [/^(.+) EGP$/, '$1 ج.م'],

    // POS
    [/^No product found for "(.*)"$/, 'لا يوجد منتج باسم "$1"'],
    [/^(.*)stock (-?\d+)$/, '$1المخزون $2'],
    [/^Price must be between 0 and (.+)$/, 'يجب أن يكون السعر بين 0 و $1'],
    [/^Change: (.+)$/, 'الباقي: $1'],
    [/^Short by (.+)$/, 'ناقص $1'],
    [/^Sale (.+) saved$/, 'تم حفظ عملية البيع $1'],
    [/^Total: (.+)$/, 'الإجمالي: $1'],
    [/^Cash: (.+)$/, 'نقدًا: $1'],
    [/^Today: (\d+) sales?$/, 'اليوم: $1 عملية بيع'],
    [/^Camera blocked: (.+)$/, 'الكاميرا محجوبة: $1'],
    [/^Order (#?\S+)$/, 'طلب $1'],

    // general "X: 2 of 3" (scan progress) last
    [/^(.+): (\d+) of (\d+)$/, '$1: $2 من $3']
  ];

  function lang() {
    try { return localStorage.getItem(KEY) === 'ar' ? 'ar' : 'en'; } catch (e) { return 'en'; }
  }
  var current = lang();

  // English -> Arabic for one string (keeps leading/trailing spaces; handles several lines)
  function toArabic(s) {
    if (s == null || s === '') return s;
    if (s.indexOf('\n') !== -1) return s.split('\n').map(toArabic).join('\n');
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), core = m[2];
    if (!core) return s;
    var out = Object.prototype.hasOwnProperty.call(EXACT, core) ? EXACT[core] : null;
    if (out === null) {
      for (var i = 0; i < PATTERNS.length; i++) {
        if (PATTERNS[i][0].test(core)) { out = core.replace(PATTERNS[i][0], PATTERNS[i][1]); break; }
      }
    }
    return out === null ? s : m[1] + out + m[3];
  }
  // For code: confirm(), prompt() and the like
  function T(s) { return current === 'ar' ? toArabic(s) : s; }

  // ---------- translate the page in place ----------
  var TEXT = new WeakMap();   // text node -> {en, ar}
  var ATTR = new WeakMap();   // element -> {attrName: {en, ar}}
  var ATTRS = ['placeholder', 'aria-label', 'title'];

  function skip(el) {
    for (; el && el.nodeType === 1; el = el.parentNode) {
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || el.hasAttribute('data-no-i18n')) return true;
    }
    return false;
  }

  function doText(n) {
    var v = n.nodeValue, rec = TEXT.get(n);
    if (rec && (v === rec.ar || v === rec.en)) {
      var want = current === 'ar' ? rec.ar : rec.en;
      if (v !== want) n.nodeValue = want;
      return;
    }
    if (!v || !/[A-Za-z]/.test(v) || skip(n.parentNode)) return;  // nothing English to translate
    var ar = toArabic(v);
    if (ar === v) return;
    TEXT.set(n, { en: v, ar: ar });
    if (current === 'ar') n.nodeValue = ar;
  }

  function doAttrs(el) {
    if (skip(el)) return;
    var map = ATTR.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var v = el.getAttribute(a), rec = map && map[a];
      if (!(rec && (v === rec.ar || v === rec.en))) {
        var ar = toArabic(v);
        if (ar === v) continue;
        rec = { en: v, ar: ar };
        if (!map) { map = {}; ATTR.set(el, map); }
        map[a] = rec;
      }
      var want = current === 'ar' ? rec.ar : rec.en;
      if (v !== want) el.setAttribute(a, want);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) { if (skip(root)) return; doAttrs(root); }
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) doText(n); else doAttrs(n);
    }
  }

  function applyDir() {
    var h = document.documentElement;
    h.lang = current;
    h.dir = current === 'ar' ? 'rtl' : 'ltr';
  }

  function setLang(l) {
    l = l === 'ar' ? 'ar' : 'en';
    if (l === current) return;
    current = l;
    try { localStorage.setItem(KEY, l); } catch (e) {}
    applyDir();
    walk(document.documentElement);
    try { document.dispatchEvent(new CustomEvent('pf-lang', { detail: l })); } catch (e) {}
  }

  applyDir();
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
      else if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS
  });
  if (document.readyState !== 'loading') walk(document.documentElement);
  else document.addEventListener('DOMContentLoaded', function () { walk(document.documentElement); });

  // Changing the language in one tab changes it in all of them
  window.addEventListener('storage', function (e) { if (e.key === KEY) setLang(e.newValue); });
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data && e.data.type === 'pf-lang') setLang(e.data.lang);
  });

  window.pfT = T;
  window.pfLang = { get: function () { return current; }, set: setLang };
})();
