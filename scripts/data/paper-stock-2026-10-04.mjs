/**
 * Physical stock, copied by hand from the shed notebook pages ("STOCK AS ON 4/10/26").
 * One entry per shed page. Every line is exactly what is written; interpretation notes are in `note`.
 *
 *  batch  : canonical batch name (see scripts/lib/batchNames.mjs) the line belongs to
 *  kind   : "dated"  -> the line carries a date, so it is a lagwad entry made on that date (तयार होणारे)
 *           "loose"  -> no date: counted stock that is simply in the shed
 *  dates  : lagwad dates (YYYY-MM-DD) written on the right of a dated line
 *  label  : what is written on the paper for loose lines
 */
const Y = "2026";
const d = (day, month) => `${Y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export const AS_ON = "2026-10-04";

export const PAPER = [
  {
    shed: "Rajgad (राजगड) (7)",
    page: "07 Wed - राजगड (page 1)",
    writtenTotal: 239013,
    lines: [
      { batch: "RB 1811", kind: "dated", qty: 99904, dates: [d(30, 9), d(1, 10)] },
      { batch: "SB 139", kind: "dated", qty: 34416, dates: [d(16, 9)], note: "139 is not in the batch list: created as a new batch" },
      { batch: "SB 179", kind: "dated", qty: 41280, dates: [d(27, 9)] },
      { batch: "SB 249", kind: "dated", qty: 41448, dates: [d(28, 9)] },
      { batch: "SB Mix", kind: "loose", label: "SB mix (fresh)", qty: 6125 },
      { batch: "SB Old", kind: "loose", label: "SB mix (old / जुने)", qty: 1004 },
      { batch: "RB Mix", kind: "loose", label: "RB mix", qty: 2140, note: "word next to RB mix is scratched out" },
      { batch: "RB 19", kind: "loose", label: "19", qty: 7396 },
      { batch: "RB 510", kind: "loose", label: "510", qty: 3140 },
      { batch: "CB Mix", kind: "loose", label: "CB", qty: 2160 },
    ],
  },
  {
    shed: "Torna (तोरणा) (5)",
    page: "torna (page 2)",
    writtenTotal: 173771,
    lines: [
      { batch: "SB 278", kind: "dated", qty: 40928, dates: [d(6, 9)] },
      { batch: "SB 208", kind: "dated", qty: 41536, dates: [d(22, 8)] },
      { batch: "SB 178", kind: "dated", qty: 41088, dates: [d(20, 8)] },
      { batch: "SB 128", kind: "dated", qty: 41048, dates: [d(17, 8)] },
      { batch: "SB Old", kind: "loose", label: "old (जुने) SB mix", qty: 9171 },
    ],
  },
  {
    shed: "Raigad (रायगड) (2)",
    page: "10 Sat - PH2 रायगड (page 3)",
    writtenTotal: 36258,
    lines: [{ batch: "VS 911", kind: "loose", label: "911 vasai", qty: 36258 }],
  },
  {
    shed: "Shivneri ( शिवनेरी) (3)",
    page: "10 Sat - PH3 शिवनेर (page 3)",
    writtenTotal: 26490,
    lines: [
      { batch: "RB Mix", kind: "loose", label: "mix RB (old / जुने)", qty: 13300 },
      { batch: "VS 911", kind: "loose", label: "911 vasai", qty: 13190 },
    ],
  },
  {
    shed: "Pratapgad (प्रतापगड) (4)",
    page: "08 Thu - प्रतापगड (page 4, top block)",
    writtenTotal: 120396,
    lines: [
      { batch: "RB 1811", kind: "dated", qty: 51072, dates: [d(29, 9)] },
      { batch: "SB 318", kind: "dated", qty: 41352, dates: [d(9, 9)] },
      { batch: "RB 19", kind: "loose", label: "19 RB (old / जुने)", qty: 6556 },
      { batch: "SB Old", kind: "loose", label: "98 mix", qty: 4656, note: "SB 98 is 'SB Old' in your list, so counted as SB Old (please confirm)" },
      { batch: "RB Mix", kind: "loose", label: "RB mix", qty: 4000 },
      { batch: "SB Old", kind: "loose", label: "SB ellepot (old / जुने)", qty: 12760 },
    ],
  },
  {
    shed: "Purandar (पुरंदर) (6)",
    page: "08 Thu - पुरंदर (page 4, middle block)",
    writtenTotal: 344390,
    lines: [
      { batch: "RB 1811", kind: "dated", qty: 21632, dates: [d(20, 9)] },
      { batch: "RB 1811", kind: "dated", qty: 34304, dates: [d(19, 9)] },
      { batch: "RB 1811", kind: "dated", qty: 45376, dates: [d(3, 9)] },
      { batch: "RB 510", kind: "loose", label: "510 fresh", qty: 22004 },
      { batch: "RB 38", kind: "loose", label: "38", qty: 2520 },
      { batch: "RB 19", kind: "loose", label: "19 fresh (32408 + 4032)", qty: 36440 },
      { batch: "RB 312", kind: "dated", qty: 35008, dates: [d(1, 9)], note: "written 812; same batch as 312 (3/8 look alike)" },
      { batch: "RB 312", kind: "dated", qty: 23192, dates: [d(2, 9)], note: "read as 23192: only then do the lines add up to the written total 344390" },
      { batch: "RB Mix", kind: "loose", label: "mix RB (fresh)", qty: 3906 },
      {
        batch: "RB 1811",
        kind: "dated",
        qty: 120008,
        dates: [d(4, 9), d(5, 9), d(17, 9), d(18, 9)],
        note: "paper says dates 4, 5, 18 but the quantity only adds up when 17 Sep is included",
      },
    ],
  },
  {
    shed: "Kondhana (कोंढाणा) (23)",
    page: "08 Thu - 23 no. (page 4, bottom)",
    writtenTotal: 27722,
    lines: [
      { batch: "CB Mix", kind: "loose", label: "CB old (fresh)", qty: 6700 },
      { batch: "SB Old", kind: "loose", label: "SB old (fresh) 25522 - 4500", qty: 21022 },
    ],
  },
  {
    shed: "Devgiri (देवगिरी) (8)",
    page: "09 Fri - देवगिरी (page 5)",
    writtenTotal: 243502,
    lines: [
      { batch: "RB 312", kind: "dated", qty: 32128, dates: [d(22, 9)], note: "written 812; same batch as 312" },
      { batch: "RB 312", kind: "dated", qty: 34048, dates: [d(21, 9)] },
      { batch: "RB 312", kind: "dated", qty: 23872, dates: [d(24, 9)] },
      { batch: "RB 312", kind: "dated", qty: 33344, dates: [d(23, 9)] },
      { batch: "RB 1811", kind: "dated", qty: 43520, dates: [d(3, 10)] },
      { batch: "SB Mix", kind: "loose", label: "mix SB", qty: 20692 },
      { batch: "RB 510", kind: "loose", label: "510 (fresh)", qty: 22392 },
      { batch: "RB 19", kind: "loose", label: "19 fresh", qty: 9472, note: "photo is unclear: 9972 or 9472. Read as 9472 because only then do the lines add up to the written total 243502" },
      { batch: "RB Mix", kind: "loose", label: "mix RB old (जुने)", qty: 6042 },
      { batch: "RB 19", kind: "loose", label: "19 old (जुने)", qty: 2640 },
      { batch: "RB 17", kind: "loose", label: "17 fresh", qty: 3072, note: "17 is not in the batch list: created as a new batch" },
      { batch: "RB 17", kind: "loose", label: "17 old (जुने)", qty: 6700 },
      { batch: "RB 510", kind: "loose", label: "510 old (जुने)", qty: 3800 },
      { batch: "RB 38", kind: "loose", label: "38 fresh", qty: 1780 },
    ],
  },
  {
    shed: "Sinhagad (सिंहगड) (1)",
    page: "09 Fri - PH1 सिंहगड (page 5, bottom)",
    writtenTotal: 27264,
    lines: [
      { batch: "VS 278", kind: "loose", label: "278 vasai", qty: 10032 },
      { batch: "VS 912", kind: "loose", label: "912 vasai", qty: 17232 },
    ],
  },
];
