# SmartDispatch — StaGove

Автономен агент за доставки. Поставяш дневния списък със спирки в какъвто формат е → агентът извлича спирките (Groq), геокодира адресите (OpenStreetMap/Nominatim), оптимизира реда (nearest-neighbor), смята ETA (OSRM), маркира рисковете по часови прозорци и при закъснение преизчислява маршрута и пише готови известия до клиентите (WhatsApp / SMS).

Агентът сам тегли текущите цени на горивата в България (живи данни, цитиран източник) и сам познава разхода на колата по модела — потребителят въвежда само своя бизнес (коя кола, каква такса). Профили на шофьора и на отделните клиенти захранват сметките за разход, спестявания и печалба; агентът се учи от всяка доставка.

Нула повтарящ се разход: Groq free tier + безплатни Nominatim/OSRM + публични източници за цени, без втори платен ключ.

---

## Файлове

| Файл | Роля |
|---|---|
| `index.html` | UI на PWA |
| `styles.css` | Тема (dispatch-конзола) |
| `app.js` | Автономният цикъл (Perceive → Plan → Assess → Monitor/Act) |
| `manifest.json` | PWA манифест |
| `service-worker.js` | Кеш (network-first) |
| `icon-192.png`, `icon-512.png` | Икони |
| `netlify.toml` | Netlify конфигурация + /api пренасочвания |
| `netlify/functions/groq.js` | Прокси за Groq (крие ключа) |
| `netlify/functions/geocode.js` | Прокси за Nominatim |
| `netlify/functions/route.js` | Прокси за OSRM |
| `netlify/functions/fuel.js` | Живи цени на горивата (BG) + резервна средна |

> Важно: четирите функции трябва да са в папка `netlify/functions/`. В GitHub web UI при „Add file → Create new file" просто напиши името като `netlify/functions/groq.js` — GitHub създава папките автоматично.

---

## Стъпки за качване (без терминал)

**1. Безплатен Groq ключ**
- Влез в console.groq.com → API Keys → Create API Key. Копирай го.

**2. GitHub репо**
- Създай ново репо (напр. `smartdispatch`).
- Качи всички файлове, като запазиш папката `netlify/functions/`.

**3. Netlify**
- app.netlify.com → Add new site → Import an existing project → избери репото.
- Build command: остави празно. Publish directory: `.` (вече е зададено в `netlify.toml`).

**4. Ключът като променлива на средата**
- Site settings → Environment variables → Add a variable.
- Key: `GROQ_API_KEY`  ·  Value: твоят ключ от стъпка 1.
- (Точно това име — `app.js` вика `/api/groq`, а функцията чете `process.env.GROQ_API_KEY`.)

**5. Deploy**
- Deploys → Trigger deploy → Deploy site. Готово.

---

## Тест

Отвори сайта → бутон **„Зареди пример"** → **„Планирай маршрута"**. Очаквай: 5 спирки, оптимизиран ред, рисков доклад (примерът има тясна спирка), журнал на решенията. После **„Започни маршрута"** → на някоя спирка въведи закъснение (напр. 25 мин) → агентът каскадира ETA-тата, дава REORDER/KEEP решение и готови известия.

## Бележки

- **Nominatim** допуска ~1 заявка/сек — затова геокодирането е последователно с ~1.1с пауза. За голям обем може да се добави кеш в `geocode.js`.
- **OSRM** ползва публичния demo сървър. Ако върне грешка, `app.js` пада към оценка по права линия (~30 км/ч), за да не блокира маршрута.
- **Service worker** е network-first нарочно: ъпдейтите никога не остават зад стар кеш. При промяна вдигни версията в `service-worker.js` (вече е `smartdispatch-v3`).
- Телефоните се нормализират към международен формат (0888… → 359888…) за `wa.me`.

*StaGove Intl OU · SmartDispatch v2.0 · Groq · OpenStreetMap · OSRM*
