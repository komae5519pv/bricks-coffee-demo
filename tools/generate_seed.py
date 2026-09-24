#!/usr/bin/env python3
"""Generate production-shaped seed data for the DAIWT coffee shop app.

A global coffee chain presented as a Japanese brand: 12 stores across
JP/US/UK/SG/AU/FR/DE, all menu data in Japanese, all prices in JPY
(legacy local prices converted x100). 924 SKUs, 7,284 historical order lines.
Output: server/seed/{stores,menu_items,historical_orders}.json
"""
import json, random, pathlib

random.seed(20260924)
OUTDIR = pathlib.Path(__file__).resolve().parent.parent / 'server' / 'seed'

STORES = [
    {'store_id': 'TYO001', 'store_name': '東京駅前店',          'country': 'JP', 'currency': 'JPY', 'locale': 'ja', 'timezone': 'Asia/Tokyo'},
    {'store_id': 'TYO002', 'store_name': '渋谷スクランブル店',   'country': 'JP', 'currency': 'JPY', 'locale': 'ja', 'timezone': 'Asia/Tokyo'},
    {'store_id': 'OSA001', 'store_name': '梅田店',              'country': 'JP', 'currency': 'JPY', 'locale': 'ja', 'timezone': 'Asia/Tokyo'},
    {'store_id': 'NGO001', 'store_name': '名古屋栄店',           'country': 'JP', 'currency': 'JPY', 'locale': 'ja', 'timezone': 'Asia/Tokyo'},
    {'store_id': 'NYC001', 'store_name': 'Midtown Manhattan',   'country': 'US', 'currency': 'USD', 'locale': 'en', 'timezone': 'America/New_York'},
    {'store_id': 'NYC002', 'store_name': 'Brooklyn Heights',    'country': 'US', 'currency': 'USD', 'locale': 'en', 'timezone': 'America/New_York'},
    {'store_id': 'SFO001', 'store_name': 'SoMa',                'country': 'US', 'currency': 'USD', 'locale': 'en', 'timezone': 'America/Los_Angeles'},
    {'store_id': 'LON001', 'store_name': 'Soho',                'country': 'UK', 'currency': 'GBP', 'locale': 'en', 'timezone': 'Europe/London'},
    {'store_id': 'SIN001', 'store_name': 'Orchard Road',        'country': 'SG', 'currency': 'SGD', 'locale': 'en', 'timezone': 'Asia/Singapore'},
    {'store_id': 'SYD001', 'store_name': 'Circular Quay',       'country': 'AU', 'currency': 'AUD', 'locale': 'en', 'timezone': 'Australia/Sydney'},
    {'store_id': 'PAR001', 'store_name': 'Le Marais',           'country': 'FR', 'currency': 'EUR', 'locale': 'en', 'timezone': 'Europe/Paris'},
    {'store_id': 'BER001', 'store_name': 'Mitte',               'country': 'DE', 'currency': 'EUR', 'locale': 'en', 'timezone': 'Europe/Berlin'},
]

# key, category, en, ja, en_desc, ja_desc, sizes, base USD, regions (None = global)
B = 'Brewed Coffee'; E = 'Espresso'; C = 'Cold Brew & Iced'; T = 'Tea & Matcha'; S = 'Seasonal'; F = 'Frappé & Blended'; P = 'Pastry'; D = 'Sandwich & Food'

# ---------------------------------------------------------------------------
# Nutrition / allergen / tag master data (item_key level, values for size M).
# (kcal, protein_g, fat_g, contains_milk, contains_egg, contains_wheat,
#  contains_nuts, alt_milk_options, scenes, is_classic, is_new, is_seasonal,
#  target_tags)
# Values are realistic for a coffee chain (エスプレッソ ~10kcal、ラテM ~150kcal、
# フラペL ~400kcal 台想定)。全店共通。
# ---------------------------------------------------------------------------
MILK = 'oat,almond,soy'
BF, LU, SN = 'breakfast', 'lunch', 'snack'
NUTRITION = {
    'DRIP':  (5,   0.5, 0,   0,0,0,0, '',    f'{BF},{LU}', 1,0,0, 'business,health'),
    'POUR':  (5,   0.5, 0,   0,0,0,0, '',    f'{BF},{LU}', 1,0,0, 'business,health'),
    'CAFE':  (90,  4.0, 3.5, 1,0,0,0, MILK,  BF,          1,0,0, 'women'),
    'AMER':  (10,  0.6, 0,   0,0,0,0, '',    f'{BF},{LU}', 1,0,0, 'business,health'),
    'ESPR':  (10,  0.8, 0,   0,0,0,0, '',    f'{BF},{LU}', 1,0,0, 'business'),
    'DOPP':  (25,  1.2, 1.0, 1,0,0,0, MILK,  BF,          0,0,0, 'business'),
    'CAPU':  (120, 6.0, 4.5, 1,0,0,0, MILK,  BF,          1,0,0, 'women,business'),
    'LATT':  (150, 7.0, 5.5, 1,0,0,0, MILK,  BF,          1,0,0, 'women'),
    'FLAT':  (130, 6.0, 5.0, 1,0,0,0, MILK,  BF,          0,0,0, 'business'),
    'MOCH':  (260, 8.0, 9.0, 1,0,0,0, MILK,  SN,          1,0,0, 'women,sweet'),
    'CARM':  (240, 6.0, 8.0, 1,0,0,0, MILK,  SN,          1,0,0, 'women,sweet'),
    'OATL':  (130, 3.0, 5.0, 0,0,0,1, '',    BF,          0,0,0, 'health,women'),
    'HONL':  (210, 6.0, 5.0, 1,0,0,0, MILK,  BF,          0,0,0, 'women,sweet'),
    'ICOF':  (60,  2.0, 2.0, 1,0,0,0, MILK,  f'{BF},{LU}',1,0,0, 'business,health'),
    'COLD':  (5,   0.5, 0,   0,0,0,0, '',    f'{BF},{LU}',0,0,0, 'health,business'),
    'CLDB':  (80,  0.5, 0,   0,0,0,0, '',    LU,          0,0,0, 'health'),
    'ILAT':  (130, 6.0, 5.0, 1,0,0,0, MILK,  f'{BF},{LU}',1,0,0, 'women'),
    'IMOC':  (250, 7.0, 9.0, 1,0,0,0, MILK,  SN,          0,0,0, 'women,sweet'),
    'NITR':  (15,  1.0, 0,   0,0,0,0, '',    LU,          0,1,0, 'business,health'),
    'GTEN':  (2,   0.3, 0,   0,0,0,0, '',    f'{BF},{SN}',1,0,0, 'health'),
    'MTCH':  (200, 7.0, 6.0, 1,0,0,0, MILK,  SN,          1,0,0, 'women'),
    'IMTC':  (190, 6.0, 5.0, 1,0,0,0, MILK,  SN,          0,0,0, 'women'),
    'HOJI':  (120, 5.0, 4.5, 1,0,0,0, MILK,  SN,          0,0,0, 'women,health'),
    'EARL':  (2,   0.3, 0,   0,0,0,0, '',    f'{BF},{SN}',1,0,0, 'health'),
    'CHAI':  (180, 5.0, 6.0, 1,0,0,0, MILK,  SN,          0,0,0, 'women,sweet'),
    'YUZU':  (60,  0.5, 0,   0,0,0,0, '',    SN,          0,1,0, 'health,women'),
    'SAKU':  (250, 6.0, 8.0, 1,0,0,0, MILK,  SN,          0,0,1, 'women,sweet'),
    'PUMP':  (290, 7.0, 9.0, 1,0,0,0, MILK,  SN,          0,0,1, 'women,sweet'),
    'GING':  (300, 7.0, 10.0,1,0,0,0, MILK,  SN,          0,0,1, 'women,sweet'),
    'MANG':  (180, 2.0, 0.5, 0,0,0,0, '',    f'{LU},{SN}',0,1,0, 'health,women'),
    'FRAC':  (380, 7.0, 14.0,1,0,0,0, MILK,  SN,          1,0,0, 'students,sweet'),
    'FRAM':  (360, 6.0, 13.0,1,0,0,0, MILK,  SN,          0,0,0, 'women,sweet'),
    'FRAC2': (420, 7.0, 16.0,1,0,0,0, MILK,  SN,          0,0,0, 'students,sweet'),
    'FRAS':  (340, 5.0, 12.0,1,0,0,0, MILK,  SN,          0,0,0, 'students,sweet'),
    'CROI':  (280, 5.0, 16.0,1,1,1,0, '',    BF,          1,0,0, 'business,women'),
    'PAIN':  (320, 6.0, 18.0,1,1,1,0, '',    BF,          1,0,0, 'business,women'),
    'SCON':  (360, 6.0, 14.0,1,1,1,0, '',    BF,          0,0,0, 'women'),
    'MUFF':  (380, 7.0, 15.0,1,1,1,1, '',    f'{BF},{SN}',0,0,0, 'students'),
    'CANN':  (220, 5.0, 10.0,1,1,1,0, '',    SN,          0,0,0, 'women'),
    'CHEE':  (390, 7.0, 26.0,1,1,0,0, '',    SN,          0,1,0, 'women,sweet'),
    'SALM':  (420, 18.0,18.0,1,0,1,0, '',    f'{BF},{LU}',0,0,0, 'business,protein'),
    'HAMC':  (450, 20.0,20.0,1,0,1,0, '',    LU,          1,0,0, 'business,protein'),
    'EGGS':  (380, 12.0,16.0,0,1,1,0, '',    f'{BF},{LU}',0,0,0, 'protein'),
    'TUNA':  (480, 24.0,22.0,1,0,1,0, '',    LU,          0,0,0, 'business,protein'),
    'TERI':  (460, 28.0,14.0,0,1,1,0, '',    LU,          0,0,0, 'protein,students'),
    'VEGE':  (390, 10.0,14.0,0,0,1,0, '',    LU,          0,0,0, 'health'),
    'SALAD': (350, 26.0,18.0,1,1,1,0, '',    LU,          0,0,0, 'health,protein'),
    'ACAI':  (320, 5.0, 8.0, 0,0,0,1, '',    BF,          0,1,0, 'health,women'),
}

# key, category, en, ja, en_desc, ja_desc, sizes, base USD, regions (None = global)
ITEMS = [
    ('DRIP',   B, 'Drip Coffee', 'ドリップコーヒー', 'Our signature medium roast, brewed fresh every 30 minutes. Notes of chocolate and toasted nuts.', '30分ごとに淹れ替える看板のミディアムロースト。チョコレートとナッツの香り。', ['S','M','L'], 3.80, None),
    ('POUR',   B, 'Pour Over', 'ハンドドリップ', 'Single-origin beans hand-brewed to order. Rotating selection from Ethiopia, Colombia and Kenya.', 'シングルオリジンを一杯ずつハンドドリップ。エチオピア・コロンビア・ケニアの週替わり。', ['M','L'], 5.50, None),
    ('CAFE',   B, 'Café au Lait', 'カフェオレ', 'Half drip coffee, half steamed milk. Smooth and comforting.', 'ドリップコーヒーとスチームミルクを半々で。まろやかでやさしい味わい。', ['S','M','L'], 4.20, None),
    ('AMER',   E, 'Americano', 'アメリカーノ', 'Double espresso lengthened with hot water. Bold but clean.', 'ダブルエスプレッソをお湯で割った、力強くもクリーンな一杯。', ['S','M','L'], 4.00, None),
    ('ESPR',   E, 'Espresso', 'エスプレッソ', 'Double shot of our house blend. Dense crema, long finish.', 'ハウスブレンドのダブルショット。厚いクレマと長い余韻。', ['N/A'], 3.50, None),
    ('DOPP',   E, 'Doppio Macchiato', 'ドッピオマキアート', 'Double espresso "stained" with a dollop of milk foam.', 'ダブルエスプレッソにミルクフォームをひとさじ。', ['N/A'], 3.90, None),
    ('CAPU',   E, 'Cappuccino', 'カプチーノ', 'Classic 1:1:1 ratio of espresso, steamed milk and velvety foam.', 'エスプレッソ・ミルク・フォームが1:1:1の王道カプチーノ。', ['S','M','L'], 4.50, None),
    ('LATT',   E, 'Caffè Latte', 'カフェラテ', 'Espresso with silky steamed milk and a thin cap of foam.', 'エスプレッソにシルキーなスチームミルク。フォームは薄め。', ['S','M','L'], 4.80, None),
    ('FLAT',   E, 'Flat White', 'フラットホワイト', 'Ristretto shots under micro-foamed milk. Stronger than a latte.', 'リストレットに微細なフォームミルク。ラテより濃厚。', ['S','M'], 5.00, None),
    ('MOCH',   E, 'Caffè Mocha', 'カフェモカ', 'Espresso, dark chocolate sauce and steamed milk, topped with whipped cream.', 'エスプレッソとダークチョコレートソース、スチームミルクにホイップ。', ['S','M','L'], 5.20, None),
    ('CARM',   E, 'Caramel Macchiato', 'キャラメルマキアート', 'Vanilla milk marked with espresso and caramel drizzle.', 'バニラミルクにエスプレッソを注ぎ、キャラメルソースを格子状に。', ['S','M','L'], 5.20, None),
    ('OATL',   E, 'Oat Milk Latte', 'オーツミルクラテ', 'Espresso with creamy oat milk. Dairy-free, naturally sweet.', 'エスプレッソにクリーミーなオーツミルク。乳製品不使用で自然な甘さ。', ['S','M','L'], 5.30, None),
    ('HONL',   E, 'Honey Latte', 'はちみつラテ', 'Caffè latte sweetened with acacia honey.', 'アカシアはちみつで甘さを添えたカフェラテ。', ['S','M','L'], 5.10, None),
    ('ICOF',   C, 'Iced Coffee', 'アイスコーヒー', 'Flash-chilled drip over ice. Crisp and refreshing.', '急速冷却したドリップを氷に注ぐ。キレのある爽やかさ。', ['S','M','L'], 3.80, None),
    ('COLD',   C, 'Cold Brew', 'コールドブリュー', 'Steeped 20 hours in cold water. Low acidity, naturally sweet.', '20時間水出し。酸味を抑えた自然な甘み。', ['S','M','L'], 4.60, None),
    ('CLDB',   C, 'Cold Brew Tonic', 'コールドブリュートニック', 'Cold brew over tonic water with an orange peel twist.', 'コールドブリューをトニックで割り、オレンジピールを添えて。', ['M','L'], 5.40, None),
    ('ILAT',   C, 'Iced Caffè Latte', 'アイスカフェラテ', 'Double espresso poured over cold milk and ice.', 'ダブルエスプレッソを冷たいミルクと氷に注ぐ。', ['S','M','L'], 4.80, None),
    ('IMOC',   C, 'Iced Mocha', 'アイスモカ', 'Iced espresso, chocolate sauce, cold milk and whipped cream.', 'アイスエスプレッソにチョコレートソースと冷ミルク、ホイップ添え。', ['S','M','L'], 5.20, None),
    ('NITR',   C, 'Nitro Cold Brew', 'ナイトロコールドブリュー', 'Cold brew infused with nitrogen for a cascading, creamy head.', '窒素を加えたコールドブリュー。クリーミーな泡立ち。', ['M','L'], 5.60, ['US','UK','AU','SG']),
    ('GTEN',   T, 'Hot Green Tea', '緑茶', 'First-flush sencha from Shizuoka, brewed at 80°C.', '静岡産一番摘み煎茶を80度で抽出。', ['S','M','L'], 3.50, None),
    ('MTCH',   T, 'Matcha Latte', '抹茶ラテ', 'Stone-ground Uji matcha whisked with steamed milk.', '石臼挽き宇治抹茶をスチームミルクで。', ['S','M','L'], 5.50, None),
    ('IMTC',   T, 'Iced Matcha Latte', 'アイス抹茶ラテ', 'Uji matcha shaken with cold milk over ice.', '宇治抹茶を冷ミルクと氷でシェイク。', ['S','M','L'], 5.50, None),
    ('HOJI',   T, 'Hōjicha Latte', 'ほうじ茶ラテ', 'Roasted green tea latte. Toasty, low caffeine.', '焙じ茶のラテ。香ばしくカフェイン控えめ。', ['S','M','L'], 5.00, ['JP','SG']),
    ('EARL',   T, 'Earl Grey', 'アールグレイ', 'Bergamot-scented black tea from our London blender.', 'ベルガモット香るブレンド紅茶。', ['S','M','L'], 3.60, None),
    ('CHAI',   T, 'Chai Latte', 'チャイラテ', 'Spiced black tea simmered with milk, cinnamon and cardamom.', 'スパイス紅茶をミルクで煮出し、シナモンとカルダモンを効かせて。', ['S','M','L'], 4.90, None),
    ('YUZU',   T, 'Yuzu Citrus Tea', 'ゆずシトラスティー', 'Japanese yuzu marmalade stirred into hot black tea.', 'ゆずマーマレードを熱い紅茶に溶かした、ほろ苦く香り高い一杯。', ['S','M'], 4.40, ['JP','SG']),
    ('SAKU',   S, 'Sakura Blossom Latte', 'さくらラテ', 'Spring special: sakura syrup, steamed milk, pink chocolate shavings.', '春限定。桜シロップとスチームミルク、ピンクチョコをトッピング。', ['S','M','L'], 5.80, ['JP']),
    ('PUMP',   S, 'Pumpkin Spice Latte', 'パンプキンスパイスラテ', 'Autumn classic with pumpkin, nutmeg and clove.', '秋の定番。パンプキンとナツメグ、クローブのスパイス。', ['S','M','L'], 5.60, ['US','UK']),
    ('GING',   S, 'Gingerbread Latte', 'ジンジャーブレッドラテ', 'Winter special with gingerbread syrup and whipped cream.', '冬限定。ジンジャーブレッドシロップとホイップクリーム。', ['S','M','L'], 5.60, ['US','UK','FR','DE']),
    ('MANG',   S, 'Mango Passion Cooler', 'マンゴーパッションクーラー', 'Tropical mango and passionfruit over ice. Caffeine-free.', 'マンゴーとパッションフルーツのトロピカルアイスドリンク。カフェインフリー。', ['M','L'], 5.20, ['SG','AU']),
    ('FRAC',   F, 'Coffee Frappé', 'コーヒーフラペ', 'Blended iced coffee with milk, topped with whipped cream.', 'アイスコーヒーとミルクをブレンドしホイップをトッピング。', ['M','L'], 5.50, None),
    ('FRAM',   F, 'Matcha Frappé', '抹茶フラペ', 'Blended matcha and milk over ice, whipped cream on top.', '抹茶とミルクを氷とブレンド。ホイップ添え。', ['M','L'], 5.90, ['JP','SG']),
    ('FRAC2',  F, 'Caramel Frappé', 'キャラメルフラペ', 'Coffee frappé with caramel sauce blended in and drizzled on top.', 'キャラメルソースを混ぜ込み、上からもかけたコーヒーフラペ。', ['M','L'], 5.70, None),
    ('FRAS',   F, 'Strawberry Frappé', 'ストロベリーフラペ', 'Strawberry purée blended with milk and ice. No coffee.', 'いちごピューレとミルクのフラペ。コーヒー不使用。', ['M','L'], 5.50, None),
    ('CROI',   P, 'Butter Croissant', 'バタークロワッサン', 'Laminated over two days with cultured French butter.', '発酵バターを2日がかりで折り込んだクロワッサン。', ['N/A'], 3.20, None),
    ('PAIN',   P, 'Pain au Chocolat', 'パン・オ・ショコラ', 'Flaky pastry with two batons of dark chocolate.', 'ダークチョコレート2本を包んだサクサクのパン。', ['N/A'], 3.60, None),
    ('SCON',   P, 'Blueberry Scone', 'ブルーベリースコーン', 'Buttermilk scone bursting with blueberries, served warm.', 'ブルーベリーたっぷりのバターミルクスコーン。温めて提供。', ['N/A'], 3.40, ['US','UK','AU']),
    ('MUFF',   P, 'Banana Walnut Muffin', 'バナナウォールナッツマフィン', 'Moist banana muffin with toasted walnuts.', 'トーストしたクルミ入りのしっとりバナナマフィン。', ['N/A'], 3.60, None),
    ('CANN',   P, 'Canelé', 'カヌレ', 'Bordeaux-style canelé: caramelized crust, custardy center, rum and vanilla.', 'ボルドー風カヌレ。焦がしカラメルの皮とラムバニラの中身。', ['N/A'], 3.80, ['JP','FR']),
    ('CHEE',   P, 'Basque Cheesecake', 'バスクチーズケーキ', 'Burnt-top Basque cheesecake. Creamy, bittersweet.', '表面を焦がしたバスクチーズケーキ。クリーミーでほろ苦い。', ['N/A'], 4.50, ['JP','SG']),
    ('SALM',   D, 'Smoked Salmon Bagel', 'スモークサーモンベーグル', 'Cream cheese, smoked salmon, capers and red onion on a toasted bagel.', 'クリームチーズとスモークサーモン、ケッパーと赤玉ねぎのベーグル。', ['N/A'], 7.80, ['US','UK','FR','DE','AU']),
    ('HAMC',   D, 'Ham & Cheese Sandwich', 'ハムチーズサンド', 'Smoked ham and gruyère on country bread, grilled.', 'スモークハムとグリュイエールをカンパーニュでグリル。', ['N/A'], 6.50, None),
    ('EGGS',   D, 'Egg Salad Sandwich', 'たまごサンド', 'Japanese-style egg salad with kewpie mayo on soft shokupan.', 'きゅうり入りたまごサラダをふわふわの食パンで。', ['N/A'], 5.80, ['JP']),
    ('TUNA',   D, 'Tuna Melt', 'ツナメルト', 'Tuna salad with melted cheddar on sourdough, pressed hot.', 'ツナサラダととろけるチェダーをサワードウでプレス。', ['N/A'], 6.90, ['US','UK','AU','SG']),
    ('TERI',   D, 'Teriyaki Chicken Sandwich', 'てりやきチキンサンド', 'Grilled teriyaki chicken thigh with shiso and mayo on a brioche bun.', 'てりやきチキンに大葉とマヨネーズ、ブリオッシュバンズで。', ['N/A'], 7.20, ['JP','SG']),
    ('VEGE',   D, 'Roasted Vegetable Focaccia', 'グリル野菜のフォカッチャ', 'Zucchini, peppers and eggplant with basil pesto on focaccia.', 'ズッキーニとパプリカ、ナスにバジルペーストのフォカッチャ。', ['N/A'], 6.80, None),
    ('SALAD',  D, 'Chicken Caesar Salad', 'チキンシーザーサラダ', 'Romaine, grilled chicken, parmesan and house dressing.', 'ロメインレタスとグリルチキン、パルメザンの自家製ドレッシング。', ['N/A'], 8.50, None),
    ('ACAI',   D, 'Açaí Bowl', 'アサイーボウル', 'Açaí blended with banana, topped with granola and seasonal fruit.', 'アサイーとバナナをブレンドしグラノーラと季節のフルーツを。', ['N/A'], 8.80, ['US','AU','SG']),
]

PRICE_FACTOR = {'JPY': 145, 'USD': 1.0, 'GBP': 0.82, 'SGD': 1.32, 'AUD': 1.48, 'EUR': 0.92}
SIZE_MULT = {'S': 0.9, 'M': 1.0, 'L': 1.1, 'N/A': 1.0}
REGION_OF = {'JP': ['JP'], 'US': ['US'], 'UK': ['UK'], 'SG': ['SG'], 'AU': ['AU'], 'FR': ['FR'], 'DE': ['DE']}

# 2026-09-24 方針: 日本のコーヒーチェーンとして全店・日本語表記・円建てに統一。
# カテゴリ名も日本語化(カテゴリ定数は英語のままキーとして使い、出力時に変換)。
JA_CATEGORIES = {
    'Brewed Coffee': 'ドリップコーヒー',
    'Espresso': 'エスプレッソ',
    'Cold Brew & Iced': 'コールドブリュー&アイス',
    'Tea & Matcha': 'ティー&抹茶',
    'Seasonal': '季節のおすすめ',
    'Frappé & Blended': 'フラッペ&ブレンデッド',
    'Pastry': 'ペイストリー',
    'Sandwich & Food': 'サンドイッチ&フード',
}

def price_jpy(st_currency, base, size):
    """円建ての統一ルール: 従来の現地通貨価格を x100 (A$8.50 -> ¥850)。
    JP 店は従来から円建てなので従来式のまま(10円丸め)。"""
    if st_currency == 'JPY':
        return round(base * SIZE_MULT[size] * PRICE_FACTOR['JPY'] / 10) * 10
    local = round(base * SIZE_MULT[size] * PRICE_FACTOR[st_currency] * 2) / 2
    return int(round(local * 100))

menu_items = []
for st in STORES:
    region = st['country']
    for (key, cat, en, ja, en_d, ja_d, sizes, base, regions) in ITEMS:
        if regions is not None and region not in regions:
            continue
        # ~8% of optional items are not carried at this store
        if random.random() < 0.08:
            continue
        (kcal, protein, fat, c_milk, c_egg, c_wheat, c_nuts,
         alt_milk, scenes, is_classic, is_new, is_seasonal, target_tags) = NUTRITION[key]
        for size in sizes:
            mult = SIZE_MULT[size]
            menu_items.append({
                'sku': f"{st['store_id']}-{key}-{size.replace('/','')}",
                'store_id': st['store_id'],
                'item_key': key,
                'item_name': ja,
                'category': JA_CATEGORIES[cat],
                'size': size,
                'price': price_jpy(st['currency'], base, size),
                'currency': 'JPY',
                'description': ja_d,
                'active': random.random() > 0.02,
                'calories_kcal': int(round(kcal * mult)),
                'protein_g': round(protein * mult, 1),
                'fat_g': round(fat * mult, 1),
                'contains_milk': bool(c_milk),
                'contains_egg': bool(c_egg),
                'contains_wheat': bool(c_wheat),
                'contains_nuts': bool(c_nuts),
                'alt_milk_options': alt_milk,
                'scenes': scenes,
                'is_classic': bool(is_classic),
                'is_new': bool(is_new),
                'is_seasonal': bool(is_seasonal),
                'target_tags': target_tags,
            })

# historical orders: 2024-01 .. 2026-08, ~2400 orders
JA_NAMES = ['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田']
EN_NAMES = ['Alex','Jordan','Emma','Liam','Olivia','Noah','Ava','Mason','Sophia','Ethan','Mia','Lucas']
by_store = {}
for m in menu_items:
    by_store.setdefault(m['store_id'], []).append(m)

historical = []
oid = 0
row_id = 0
from datetime import datetime, timedelta
start = datetime(2025, 1, 1)
for day in range(0, 610):
    d = start + timedelta(days=day)
    if d > datetime(2026, 8, 31):
        break
    for st in STORES:
        items = by_store.get(st['store_id'], [])
        if not items:
            continue
        # 0-4 orders per store per day (sparse but steady)
        for _ in range(random.randint(0, 1)):
            oid += 1
            names = JA_NAMES if st['locale'] == 'ja' else EN_NAMES
            cust = random.choice(names)
            ts = d.replace(hour=random.randint(7, 19), minute=random.randint(0, 59), second=random.randint(0, 59))
            inout = random.choice(['in', 'out'])
            for _ in range(random.randint(1, 3)):
                row_id += 1
                m = random.choice(items)
                historical.append({
                    'row_id': row_id,
                    'order_id': f'ORD{oid:06d}',
                    'store_id': st['store_id'],
                    'created_at': ts.isoformat(),
                    'sku': m['sku'],
                    'quantity': random.randint(1, 2),
                    'cust_name': cust,
                    'in_or_out': inout,
                })

OUTDIR.mkdir(parents=True, exist_ok=True)
# 店舗マスタの表示通貨も円に統一(価格計算は上記の元通貨ベース x100 ルールで済んでいる)
stores_out = [{**st, 'currency': 'JPY'} for st in STORES]
(OUTDIR / 'stores.json').write_text(json.dumps(stores_out, ensure_ascii=False), encoding='utf-8')
(OUTDIR / 'menu_items.json').write_text(json.dumps(menu_items, ensure_ascii=False), encoding='utf-8')
(OUTDIR / 'historical_orders.json').write_text(json.dumps(historical, ensure_ascii=False), encoding='utf-8')
print('stores:', len(STORES))
print('menu_items (SKUs):', len(menu_items))
print('historical order lines:', len(historical))
print('distinct orders:', oid)
