# A feldolgozási folyamat

A dokumentum végigmegy a teljes láncon, a PDF feltöltésétől a kirajzolt
gráfig. A két minta, amire hivatkozok:

- `samples/finance.pdf`, 3 oldalas pénzügyi kimutatás. Táblázatszerű,
  rövid sorokkal, sok számadattal.
- `samples/rohini.pdf`, 8 oldal LED-fizika jegyzet. Folyó próza,
  technikai mondatokkal.

A két végletet egyszerre kell jól szolgálnia a rendszernek, és a fő
mérnöki döntések ebből fakadnak.

## A magas szintű folyamat

A projekt két folyamatból áll, és ezek között egy szándékosan vékony
JSON szerződés van.

```
   Böngésző                                Backend (Python)
   ┌────────────────────┐                 ┌──────────────────────────┐
   │ React + Vite       │   POST /extract │ FastAPI                  │
   │  Sidebar           │ ───────────────▶│  pdf_io.read_pdf         │
   │  GraphView         │   multipart PDF │  extractor.extract       │
   │  TextPanel         │                 │                          │
   │                    │      JSON       │                          │
   │   xyflow + dagre   │ ◀───────────────│                          │
   └────────────────────┘                 └──────────────────────────┘
       :5173                                       :8000
```

A frontend nem látja a PDF-et, csak feltölti és rárajzolja az eredményt
a vászonra. A backend nem törődik a megjelenítéssel, csak JSON-t ad
vissza. A két oldal egymástól függetlenül cserélhető. Ha holnap úgy
döntenénk, hogy a kinyerő lánc helyett LLM-et használunk, csak a
`backend/extractor.py`-t kéne lecserélni, a frontend egy kódsort sem
látna belőle.

A két folyamat közötti kapcsolatot a Vite dev szerver proxyja oldja meg.
A `vite.config.ts`-ben:

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8000',
      rewrite: (p) => p.replace(/^\/api/, ''),
    },
  },
}
```

A böngésző tehát mindig `/api/extract`-re küld POST-ot, a Vite ezt
átírja `http://127.0.0.1:8000/extract`-re. Egy origin a böngésző
szempontjából, így nincs CORS bonyodalom. A `Sidebar.tsx`-en egy
egyszerű állapotjelző (zöld / piros pötty) folyamatosan pingeli a
`/api/health` végpontot, így vizuálisan azonnal látszik, ha a backend
nem fut.

A teljes folyamat egy mondatban: a feltöltött PDF-ből Python kinyeri a
csomópontokat és éleket, JSON-ban visszaadja, és a frontend egy
szerkeszthető vászonra rakja, miközben a forrásszöveget egy oldalsávban
megőrzi.

## PDF feldolgozás

Ez a `backend/pdf_io.py` dolga. A bemenet a feltöltött nyers `bytes`,
a kimenet egy lista `Page` rekordból:

```python
@dataclass
class Page:
    number: int
    text: str
    is_tabular: bool
```

### Pdfplumber integráció

A pdfplumber egy vékony Python wrapper a `pdfminer.six` köré. Mi
ennek csak két dolgát használjuk: a `pdfplumber.open()`-t és az
oldalankénti `extract_text()`-et. A teljes integráció egyetlen
függvényben elfér:

```python
import io
import pdfplumber

def read_pdf(data: bytes) -> List[Page]:
    pages: List[Page] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for i, p in enumerate(pdf.pages, start=1):
            raw = p.extract_text() or ""
            text = _cleanup(raw)
            pages.append(Page(number=i, text=text, is_tabular=_looks_tabular(text)))
    return pages
```

**Bemenet:** a `read_pdf` függvény nyers `bytes` szekvenciát vár, nem
fájlnevet. Ez azért van, mert a FastAPI `UploadFile` egy memóriában (vagy
ideiglenes fájlban) lévő stream, és ezt egy `await file.read()` hívással
nyerjük ki belőle. Lemezre így nem írunk semmit, és nincs szükség
takarításra hibaesetén sem.

A `pdfplumber.open()` egyébként háromféle bemenetet fogad: fájlútvonalat,
file-szerű objektumot, vagy `BytesIO`-t. Mi az utolsót adjuk át, mert
csak `bytes`-szal rendelkezünk. A `with` szerkezet biztosítja, hogy a
PDF objektum aktusban felszabaduljon, akkor is, ha az iteráció közben
kivétel keletkezik.

**Kimenet, oldalanként:** a `pdf.pages` egy lazy lista. Minden elem egy
`pdfplumber.page.Page`, és többféle adatot tud róla kérni:

| metódus | mit ad | mi használjuk-e |
|---|---|---|
| `extract_text()` | egyetlen `str`, sortörésekkel | igen |
| `extract_words()` | szavak listája pozícióval (x0, x1, top, bottom) | nem |
| `extract_tables()` | felismert táblázatok celláival | nem |
| `chars` | karakterek listája pozícióval és fonttal | nem |
| `images` | képek listája pozícióval | nem |

Mi csak az `extract_text()`-et hívjuk. A többi információ (pozíció,
font, képek) a tudásgráfhoz nem kell. Az `extract_tables()` jól hangzik
egy pénzügyi kimutatáshoz, de a `samples/finance.pdf` valójában
vonalrács nélküli vizuális oszlopokra épül, és pdfplumber ezeket nem
ismeri fel önállóan. A heurisztikus oldal-osztályozás (lásd lejjebb)
megbízhatóbb és olvashatóbb kód.

**Az `extract_text()` viselkedése.** A visszaadott string sortörésekkel
tagolt. Egy sor itt nem feltétlenül egy mondat: pdfplumber a PDF
fizikai layoutja alapján vágja a sorokat, vagyis amit egy sornak rajzolt
a PDF-szerző, azt egy sorként kapod vissza. Két fontos következmény:

1. A pénzügyi kimutatásban az "Service revenue $2,750" egy sorban van,
   mert egy sorban is volt rajzolva. Ezért működik a regex-alapú
   tabuláris kinyerő.
2. A folyó prózában a sortörés nem mondat-vég. Egy LED-ről szóló
   bekezdés három-négy sorban folytatódhat. Ezért nem szabad a
   sortöréseket vakon eldobni vagy automatikusan szóközzé alakítani,
   és ezért bízzuk a mondat-szétvágást a spaCy `sents` iterátorára,
   nem egy `split('\n')`-re.

`None`-t ad vissza az `extract_text()`, ha az oldal nem tartalmaz
extrahálható szöveget (üres oldal, vagy csak képet tartalmazó oldal).
Ezt az `or ""` kapja el a kódban, így a hívó mindig egy stringet kap.

**Hibaesetek.** A `pdfplumber.open()` `pdfminer.PDFSyntaxError`-t vagy
`pdfminer.PDFEncryptedDocumentError`-t dob, ha a fájl sérült vagy
titkosított. Ezt a `app.py` HTTP 422-vé fordítja:

```python
try:
    pages = read_pdf(data)
except Exception as exc:
    raise HTTPException(status_code=422, detail=f"could not parse PDF: {exc}")
```

A frontend a 422-t a sidebar tetején lévő piros sávban jeleníti meg.

**Amit nem csinálunk.** Nincs OCR. Ha a PDF szkennelt képeket
tartalmaz, az `extract_text()` üres stringet ad vissza, a kinyerő üres
gráfot épít, és a felhasználó üres vásznat lát. A README
"Troubleshooting" szekciója egy egysoros pdfplumber-hívással mutatja,
hogyan ellenőrizhető ez kívülről, mielőtt kódot piszkálnánk.

### Szöveg-tisztítás

A nyers `extract_text()` kimeneten egy `_cleanup` lépés fut. Két dolgot
csinál: a kötőjeles sortöréseket összerakja (`know-↵ledge` lesz
`knowledge`), és az üres sorokat eldobja. A többi sortörést
**szándékosan** megtartja, mert a tabuláris kinyerő a sorszerkezetre
épül.

### Oldal-osztályozás

Itt jön a fontos döntés: minden oldalt vagy prózának vagy táblázatosnak
minősít a `_looks_tabular`. A logika kis és kétváltozós:

```python
short = sum(1 for ln in lines if len(ln) < 60)
digit_chars = sum(1 for c in text if c.isdigit())
digit_ratio = digit_chars / max(1, len(text))
return (short / len(lines)) > 0.6 and digit_ratio > 0.06
```

Az oldal akkor táblázatos, ha a sorok több mint 60%-a 60 karakter
alatti, és a karakterek legalább 6%-a számjegy. Pénzügyi kimutatásra
illik, folyó prózára nem. Próbáltam pdfplumber `extract_tables()`-jét
is, de a `finance.pdf`-ben nincsenek vízszintes vonalrácsok, csak
vizuális oszlopok. A heurisztika a célnak megfelel: a `finance.pdf`
mind a három oldala `is_tabular=True`, a `rohini.pdf` mind a nyolc
`False`.

A két út innentől eltérő kódutat fut: a `_consume_prose` vagy a
`_consume_tabular` kapja meg az oldalt.

## Gráf építés, próza út

`backend/extractor.py`, `_consume_prose`. Ez a folyó szöveges
oldalakkal dolgozik. Négy lépésből áll, és mind a négy ugyanabba a
közös csomópont-táblába (`_State.nodes`) ír.

### Mondat-szétvágás

```python
doc = _NLP(page.text)
for sent in doc.sents:
    text = sent.text.strip()
    if len(text) < 12:
        continue
```

Spacy `sents` iterátora pontosabb, mint egy regex, mert tudja, hogy a
`Dr.` után nem új mondat kezdődik. A 12 karakter alatti mondatok
többnyire fejlécek vagy oldalszámok, ezeket eldobjuk.

### Entitás-kinyerés (NER)

A spaCy által felcímkézett entitások közül csak azokat tartjuk meg,
amelyek számunkra értelmes csomópontot jelentenek:

```python
ENT_KIND = {
    "PERSON": "person",  "ORG": "org",
    "GPE": "place",      "LOC": "place",  "FAC": "place",
    "NORP": "topic",     "PRODUCT": "topic",
    "EVENT": "topic",    "WORK_OF_ART": "topic", "LAW": "topic",
    "MONEY": "money",    "DATE": "date",
    "PERCENT": "percent","QUANTITY": "topic",
}
```

Ami nincs ebben a táblázatban (`CARDINAL`, `ORDINAL`, `TIME` és
hasonlók), az kimarad. Ezek a kategóriák a hétköznapi szövegekben
túl sok zajt adnak.

### Főnévi szerkezetek

A NER nem fog ki minden technikai fogalmat. A "depletion region", a
"conduction band", a "valence electrons" egyikét sem találja, mert
ezek nem nevesített entitások. Ezért a noun chunkokat is csomópontként
rögzítjük, de szigorúbb szűrés mellett:

```python
for chunk in sent.noun_chunks:
    ctext = _clean_entity(chunk.text)
    if (
        ctext.lower() in seen_text       # már entitás
        or len(ctext.split()) < 2        # egyszavas, gyakran zajos
        or len(ctext) > 40               # hosszú, valószínűleg parsolási hiba
        or _is_pronouny(chunk)
    ):
        continue
```

A `_clean_entity` itt fontos. Eltávolítja a label előtti névelőket
(`the`, `a`, `an`, `this`, `that` és társaik), így nem keletkezik
külön csomópont a "the LED"-ből és a "LED"-ből. Apró szabály, de
drámaian csökkenti a duplikációt.

### SVO háromszögek a függőségi fából

A valódi élek itt jönnek létre. Minden ige köré egy kis fa-sétát
teszünk, és három mintát keresünk:

```python
for tok in sent:
    if tok.pos_ != "VERB":
        continue
    subj = next((c for c in tok.children if c.dep_ in ("nsubj", "nsubjpass")), None)
    if subj is None:
        continue
    for c in tok.children:
        if c.dep_ in ("dobj", "attr", "oprd"):
            yield (subj, tok, c)
        if c.dep_ == "prep":
            pobj = next((g for g in c.children if g.dep_ == "pobj"), None)
            if pobj: yield (subj, tok, pobj)
        if c.dep_ == "agent":
            pobj = next((g for g in c.children if g.dep_ == "pobj"), None)
            if pobj: yield (pobj, tok, subj)
```

Három minta:

1. **Egyenes tárgy** (`dobj`). "Alice founded Acme" alanya Alice,
   tárgya Acme, az él `Alice -found-> Acme`.
2. **Elöljárós tárgy** (`prep + pobj`). "electrons recombine with holes"
   esetén az ige (`recombine`) gyermeke a `with` prepozíció, annak a
   gyermeke a tárgy. Az él `electrons -recombine-> holes`.
3. **Passzív szerkezet by-szerkezettel** (`agent + pobj`). "the LED is
   biased by the source" esetén a `by` mögötti `source` lesz az igazi
   alany. Az él `source -bias-> LED`.

Ez nem teljes szemantikus szerep-azonosítás. Az teljes SRL hatalmas
modellt igényelne. A három minta a technikai szövegek nagy részét
lefedi, futás alatt századmásodperces, és olvasható.

Az él címkéje az ige lemmája (`tok.lemma_`). Ha a lemma triviális
(`be`, `have`, `do`, `say`, `make`, és pár társuk), akkor megpróbáljuk
kiegészíteni az első prepozícióval (`be in`, `have at`). Ettől még nem
mind ad értelmes relációt, de már kevésbé robotszerű.

### Co-occurrence biztonsági háló

Ha a függőségi fa nem talál összeköttetést két nevesített entitás
között, akkor a mondaton belüli együtt-előfordulás alapján mégis
összekötjük őket egy `co-mentioned` címkéjű éllel. **Csak nevesített
entitások között.** Két egyszerű `topic` között soha. Korábban két
topic között is rakott élt a kód, és a `rohini.pdf`-ből 502 él jött
ki. A megszorítás 70-re vágta vissza.

## Gráf építés, tabuláris út

A pénzügyi kimutatásban nincsenek mondatok, csak `címke összeg` sorok.
A spaCy itt majdnem hasznavehetetlen, ezért külön pipeline fut. A
`_consume_tabular` soronként megy végig az oldalon.

### Sortípusok regexszel

```python
_AMOUNT_RE  = re.compile(r"\(?\$?\s*\d[\d,]*(?:\.\d+)?\)?")
_DATE_RE    = re.compile(r"(?:January|February|...)\s+\d{1,2},?\s*\d{4}", re.I)
_HEADING_RE = re.compile(r"^[A-Z][A-Za-z &]{2,}$")
```

| sortípus | felismerés | mit csinálunk |
|---|---|---|
| fejléc (cégnév) | csupa nagybetű, max 5 szó | `org` csomópont, és kontextusként megjegyezzük |
| szakasz-cím | `:`-re végződik vagy "Income Statement"-szerű | `topic` csomópont, ráhúzzuk a céget `reports` éllel |
| dátum | hónapnév + nap + év | `date` csomópont, ráhúzzuk a szakaszra `as-of` éllel |
| címke + összeg | bármi, amiben szám van | `metric` csomópont a címkének, `money` az összegnek, közöttük `value` él, és a szakaszhoz `includes` |

### Negatív összegek

Pénzügyi konvenció: a zárójeles szám negatív. A `_normalise_amount`
ezt ismeri fel: `(500)` lesz `$(500)`, `$1,265` lesz `$1265`. Stringként
tartjuk, nem floatként, mert a megjelenítésnél pont az számít, hogyan
írta le az eredeti.

### Szakasz-kontextus

Egyetlen lokális változó, a `current_section`, tartja számon, melyik
szakaszban vagyunk éppen. Ezzel a "Wages 1,200" sor nem egy gyökértelen
csomópont lesz, hanem szépen beágyazódik:

```
Sample Company  -reports->  Operating Expenses
Operating Expenses  -includes->  Wages
Wages  -value->  $1200
```

Ez a struktúra megy ki a frontendnek, és az xyflow ebből egy átlátható,
balról jobbra haladó hierarchiát rajzol.

## Utófeldolgozás

A két pipeline ugyanabba a `_State` tárolóba ír. Mire mindkettő végez,
három takarítási lépés következik az `extract` végén.

### Alias-egyesítés rapidfuzz-zal

```python
if fuzz.token_set_ratio(n.label, other.label) >= 92 and (
    n.label.lower() in other.label.lower()
    or other.label.lower() in n.label.lower()
    or len(n.label) > 4
):
    rewrite[other.id] = n.id
```

Azonos kindbe tartozó címkék között nézzük a hasonlóságot. A 92-es
küszöb szándékosan magas, és kérünk egy plusz garanciát is (egyik a
másik részhalmaza, vagy elég hosszú a label). Másképp a "Sample Co."
és a "Sample Inc." egy csomóponttá olvadna össze, ami hibás lenne.

A `money`, `date`, `percent` típusokat soha nem egyesítjük. A `$945`-öt
nem szabad összemosni a `$94`-gyel.

### Élek deduplikálása súlyozással

Ha két csomópont között több mondat is összefüggést indokol, csak
egyetlen él marad, de a `weight` mezőben hordja, hogy hányszor kapta
ezt a kapcsolatot. A frontend ebből számolja a vonalvastagságot:

```ts
function edgeWidth(weight, label) {
  if (label === 'co-mentioned') return 1
  return Math.min(3.5, 1.2 + Math.log2(1 + weight))
}
```

Ha egy él címkéje csak `co-mentioned` volt, és később egy igei címke
is előkerül ugyanarra a csomópont-párra, akkor felülírjuk. Az
informatívabb címke nyer.

### Alacsony értékű csomópontok eldobása

Egy csomópont, ami csak egyetlen mondatban szerepel és nincs egyetlen
éle sem, gyakorlatilag zaj. Ezeket eldobjuk. Mellékhatás: a vászon nem
lesz tele apró, össze nem kapcsolt pontokkal.

### Pontszámítás

```python
n.score = float(len(n.mentions) + deg[n.id] * 0.5)
```

Egyszerű kombináció: említések száma plusz a fokszám fele. A frontend
keresése használja a találatok rangsorolásához.

## Vizualizáció

A backend nem küld koordinátákat, csak csomópontokat és éleket. A
frontend dolga ezeket vizuálisan elrendezni. Két lépés.

### Layout dagre-rel

`src/lib/layout.ts`:

```ts
g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 })
for (const n of nodes) g.setNode(n.id, { width: 170, height: 44 })
for (const e of edges) g.setEdge(e.source, e.target)
dagre.layout(g)
```

`LR` (left-to-right) elrendezés, mert a `finance.pdf` hierarchiája
természetesen ilyen: cég balra, alá tartozó szakaszok jobbra, a
metricek még jobbra. A `rohini.pdf` gráfján is működik, csak ott nincs
ilyen tiszta hierarchia, és pókháló-szerű mintát kapunk.

A felhasználó bármikor kérheti az újra-layoutot a **Re-layout** gombbal,
ami akkor hasznos, ha kézzel adott hozzá csomópontokat és összekuszálta
a vásznat.

### Kindenkénti színezés

Minden kindhez (összesen nyolc) tartozik egy szín. A `topic` lila, a
`money` lime, a `date` égkék, a `metric` cián, a `person` rózsaszín, és
így tovább. A `EntityNode` egy ponttal és egy szöveggel rajzolja ki
őket egyforma szélességgel, hogy a dagre layout ne ugráljon.

## Szerkesztés és forrásszöveg

A felhasználó a vászonon nyolc dolgot tehet:

| művelet | hogyan | hatás |
|---|---|---|
| csomópont kiválasztás | egy kattintás | a TextPanel a csomópontra ugrik |
| él kiválasztás | egy kattintás | a TextPanel az élet előállító mondatra fókuszál |
| új él | drag a forrás `Handle`-jétől a célig | xyflow `addEdge` |
| átnevezés | dupla kattintás | `prompt`, eredmény visszaíródik |
| új csomópont | **+ Node** gomb | a vászon közepére, alapból `topic` |
| törlés | kiválasztás + **Delete** | csomópont és minden hozzá tartozó él |
| újra-layout | **Re-layout** gomb | dagre újrafutás |
| keresés | sidebar input | top találatok kiemelve, többi tompítva |

Ezek a műveletek csak a React state-et módosítják. A háttérben tárolt
`extracted` snapshot, amit a backend visszaadott, érintetlen marad.
**Ezért működik a forrásszöveg-panel akkor is, ha a gráfot már
átszerkesztetted.**

A `TextPanel` (`src/components/TextPanel.tsx`) megkapja az
`extracted.nodes` listát, és benne minden csomópontnál a `mentions:
number[]` tömböt, ami mondat-indexekre mutat. Amikor egy csomópontot
kiválasztasz, `scrollIntoView`-val a megfelelő mondatokra ugrik, és
kiemeli őket. A panel sosem szerkeszthető. Ez a tervezett invariáns,
és pont ez tartja átláthatóan a kapcsolatot a forrás és a gráf között.

## Keresés

`src/lib/search.ts`:

```ts
if (label === q) score += 10
else if (label.startsWith(q)) score += 5
else if (label.includes(q)) score += 3
for (const t of tokens) if (label.includes(t)) score += 1
score += min(3, degree * 0.2)
```

Egyszerű pontszám. Pontos egyezés 10, prefix 5, részstring 3. Plusz
egyenként 1 pont minden tokenért, ami a label-ben szerepel. Plusz
maximum 3 pontos bónusz a fokszám alapján: a sűrűn kapcsolt csomópont
általában az, amit a felhasználó keresett.

A top 12 találatot a `GraphView` kiemeli, a többit elhalványítja, és a
vászon közepét az első találatra állítja. Ettől a gráf kontextus is
megmarad, nemcsak a találat lista.

## Hol használtam AI-t a fejlesztés során

A projekt írásakor az AI-t főként segítőként használtam.
Konkrétan az alábbi területeken:

**UI fejlesztés.** A Tailwind class-stringek és az xyflow konfigurációk
gyors összerakásához. A komponens-fa szerkezetét és a komponensek
közötti felelősség-megosztást magam terveztem, de például a
`KIND_STYLES` táblázathoz vagy a sidebar állapotjelző pötty CSS-éhez
gyorsabb volt kérni egy első vázlatot, és átírni, mint nulláról
összerakni.

**Kísérletezés.** Amikor új könyvtárat választottam (xyflow vs. cytoscape,
pdfplumber vs. PyMuPDF, dagre vs. elk), gyors összehasonlító kérdésekkel
kerestem rá az adott eszközök fő különbségeire, mielőtt mélyebbre
ástam volna. A végső döntést a sample PDF-eken futtatott prototípusok
hozták meg, nem a beszélgetés.

**Dokumentáció.** Ezt a fájlt, és az angol README-t is, részben
beszélgetésben fogalmaztam, aztán átírtam saját stílusba. Az AI
hajlamos egységesen szakaszolt, listás szöveget írni, ami nem olvasható
folyó szövegként. A struktúrát én adom, az nem kapható tőle.

**Development közbeni segítség.** Apró, tartalmilag jelentéktelen
elakadások: mi a TypeScript szintaxisa egy generic-re, hogyan kell egy
spaCy `Span`-en végigiterálni, melyik regex flag a többsoros illesztés.
Stack Overflow helyett gyorsabb. Ezek a részletek könnyen ellenőrizhetőek
úgyhogy nem volt kockázatos rábízni.

**Ötletek validálása.** Mielőtt belefogtam volna egy nagyobb átírásba,
például a próza/tabuláris pipeline szétválasztásába, szóban végigmentem
a logikán "ennek lesz-e értelme?" típusú kérdésekkel. Itt az AI
visszajelzése főleg azt ellenőrizte, hogy nem hagytam-e ki egy nyilvánvaló
esetet. A javaslatait fele-fele arányban követtem és vetettem el.


