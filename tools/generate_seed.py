#!/usr/bin/env python3
"""Generate production-shaped seed data for the DAIWT coffee shop app.

Simulates a global coffee chain: 12 stores across JP/US/UK/SG/AU/FR/DE,
localized menus (ja/en), 924 SKUs, and 7,284 historical order lines.
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

def round_price(v, currency):
    if currency == 'JPY':
        return round(v / 10) * 10
    return round(v * 2) / 2

menu_items = []
for st in STORES:
    region = st['country']
    for (key, cat, en, ja, en_d, ja_d, sizes, base, regions) in ITEMS:
        if regions is not None and region not in regions:
            continue
        # ~8% of optional items are not carried at this store
        if random.random() < 0.08:
            continue
        for size in sizes:
            price = round_price(base * SIZE_MULT[size] * PRICE_FACTOR[st['currency']], st['currency'])
            name = ja if st['locale'] == 'ja' else en
            desc = ja_d if st['locale'] == 'ja' else en_d
            menu_items.append({
                'sku': f"{st['store_id']}-{key}-{size.replace('/','')}",
                'store_id': st['store_id'],
                'item_key': key,
                'item_name': name,
                'category': cat,
                'size': size,
                'price': price,
                'currency': st['currency'],
                'description': desc,
                'active': random.random() > 0.02,
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
(OUTDIR / 'stores.json').write_text(json.dumps(STORES, ensure_ascii=False), encoding='utf-8')
(OUTDIR / 'menu_items.json').write_text(json.dumps(menu_items, ensure_ascii=False), encoding='utf-8')
(OUTDIR / 'historical_orders.json').write_text(json.dumps(historical, ensure_ascii=False), encoding='utf-8')
print('stores:', len(STORES))
print('menu_items (SKUs):', len(menu_items))
print('historical order lines:', len(historical))
print('distinct orders:', oid)
