const below = (crop, value, ratePerKm) => ({ crop, condition: "BELOW", value, ratePerKm });
const above = (crop, value, ratePerKm) => ({ crop, condition: "ABOVE", value, ratePerKm });
const atLeast = (crop, value, ratePerKm) => ({ crop, condition: "AT_LEAST", value, ratePerKm });
const between = (crop, from, to, ratePerKm) => ({ crop, condition: "BETWEEN", from, to, ratePerKm });

/** Default rate cards (office rate sheet, Oct 2026). Rates are ₹ per km; local market is ₹ per plant. */
export const DEFAULT_FREIGHT_RATE_CARDS = [
  {
    name: "Chota Hathi",
    code: "CHOTA_HATHI",
    sortOrder: 1,
    localMarketRatePerPlant: 0.5,
    shortTripMaxKm: 100,
    shortTripRatePerKm: 12.75,
    notes: "Below 100 km = ₹12.75 per km",
    loadTypes: [
      {
        name: "Regular",
        sortOrder: 1,
        slabs: [
          below("Banana", 116, 11.75),
          above("Banana", 125, 12.75),
          below("Papaya", 110, 11.75),
          above("Papaya", 110, 12.75),
          below("Watermelon", 144, 11.75),
          above("Watermelon", 160, 12.75),
        ],
      },
      {
        name: "Mini Jumbo",
        sortOrder: 2,
        slabs: [below("Banana", 55, 11.75), above("Banana", 62, 12.75)],
      },
    ],
  },
  {
    name: "Pick Up",
    code: "PICK_UP",
    sortOrder: 2,
    localMarketRatePerPlant: 0.5,
    notes: "216 crates chya var jitke km titke + bakshis",
    loadTypes: [
      {
        name: "Regular",
        sortOrder: 1,
        slabs: [
          below("Banana", 187, 13.75),
          between("Banana", 188, 200, 14.75),
          above("Banana", 230, 17.75),
          below("Papaya", 187, 13.75),
          between("Papaya", 188, 200, 14.75),
          above("Papaya", 230, 17.75),
          below("Watermelon", 250, 13.75),
          between("Watermelon", 251, 280, 14.75),
          atLeast("Watermelon", 320, 17.75),
        ],
      },
      {
        name: "Mini Jumbo",
        sortOrder: 2,
        slabs: [below("Banana", 117, 13.75), atLeast("Banana", 125, 14.75)],
      },
    ],
  },
  {
    name: "14 Feet Eicher",
    code: "EICHER_14FT",
    sortOrder: 3,
    localMarketRatePerPlant: 0.5,
    notes: "Local market 50 paise per plant",
    loadTypes: [
      {
        name: "Regular",
        sortOrder: 1,
        slabs: [
          below("Banana", 425, 22.75),
          above("Banana", 458, 23.75),
          below("Papaya", 425, 22.75),
          above("Papaya", 458, 23.75),
        ],
      },
      {
        name: "Mini Jumbo",
        sortOrder: 2,
        slabs: [below("Banana", 250, 22.75), above("Banana", 270, 23.75)],
      },
    ],
  },
  {
    name: "Eicher",
    code: "EICHER",
    sortOrder: 4,
    localMarketRatePerPlant: 0.5,
    notes: "₹31 per km as per load above 500 crates. Local market 50 paise per plant",
    loadTypes: [
      {
        name: "Regular",
        sortOrder: 1,
        slabs: [above("Banana", 500, 31)],
      },
    ],
  },
];
