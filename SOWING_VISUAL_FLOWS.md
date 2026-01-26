# Sowing System - Visual Flow Diagrams

## 📐 System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          FRONTEND (React)                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│  │  Gap Analysis    │  │ Primary Sowing   │  │ Excessive Sowing │     │
│  │     Page         │  │     Entry        │  │     Modal        │     │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘     │
│           │                     │                      │                │
│           └─────────────────────┼──────────────────────┘                │
│                                 │                                        │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │
                         API Layer (REST)
                                  │
┌─────────────────────────────────┼────────────────────────────────────────┐
│                          BACKEND (Node.js + Express)                      │
├─────────────────────────────────┼────────────────────────────────────────┤
│                                 │                                         │
│  ┌──────────────────────────────▼────────────────────────────┐          │
│  │                    Route Layer                             │          │
│  │   /sowing/*  |  /sowing/request/*  |  /sowing/excessive/* │          │
│  └──────────────────────────────┬────────────────────────────┘          │
│                                  │                                        │
│  ┌──────────────────────────────▼────────────────────────────┐          │
│  │                 Controller Layer                           │          │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐    │          │
│  │  │   Sowing    │  │   Request    │  │  Excessive   │    │          │
│  │  │ Controller  │  │  Controller  │  │   Sowing     │    │          │
│  │  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘    │          │
│  └─────────┼─────────────────┼──────────────────┼────────────┘          │
│            │                 │                  │                        │
│  ┌─────────▼─────────────────▼──────────────────▼────────────┐          │
│  │              Helper Layer (Transaction Logger)             │          │
│  │   logSowingStarted() | logSowingCompleted() | etc.       │          │
│  └──────────────────────────────┬─────────────────────────────┘          │
│                                  │                                        │
│  ┌──────────────────────────────▼────────────────────────────┐          │
│  │                     Model Layer                            │          │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  │          │
│  │  │ PlantCms │  │   Slot   │  │  Sowing  │  │ Request │  │          │
│  │  │          │  │  (Main)  │  │          │  │         │  │          │
│  │  └──────────┘  └──────────┘  └──────────┘  └─────────┘  │          │
│  └──────────────────────────────┬─────────────────────────────┘          │
└─────────────────────────────────┼────────────────────────────────────────┘
                                  │
                        Database (MongoDB)
                                  │
┌─────────────────────────────────▼────────────────────────────────────────┐
│                            Collections                                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │ plantcms   │  │ plantslots │  │  sowings   │  │sowingreqs  │        │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │  orders    │  │ inventory  │  │  products  │  │   users    │        │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Complete Request Lifecycle Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     REGULAR SOWING REQUEST FLOW                            │
└───────────────────────────────────────────────────────────────────────────┘

PHASE 1: ORDER & GAP IDENTIFICATION
═══════════════════════════════════

Customer                  System                    Database
   │                         │                          │
   │ ┌─Place Order──────┐   │                          │
   ├─┤ Plant: Tomato    │──→│                          │
   │ │ Quantity: 1000   │   │                          │
   │ └──────────────────┘   │                          │
   │                         │                          │
   │                         ├─Link to Slot────────────→│ orders
   │                         │                          │
   │                         ├─Calculate Gap───────────→│ plantslots
   │                         │  (Orders - Sowed)        │
   │                         │                          │
   │                         ├─Apply Buffer────────────→│
   │                         │  gap + (gap × 10%)       │
   │                         │                          │
   │                    [Gap = 850 plants]              │
   │                    [Packets Needed = 8.5]          │
   │                         │                          │


PHASE 2: STOCK REQUEST CREATION
═══════════════════════════════

Sowing Manager           System                    Database
   │                         │                          │
   │ View Gap Cards          │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │     ┌─Today's Cards────┐│                          │
   │◄────┤ Tomato-Hybrid    ││                          │
   │     │ Gap: 850 plants  ││                          │
   │     │ Packets: 8.5     ││                          │
   │     └──────────────────┘│                          │
   │                         │                          │
   │ Click "Request Stock"   │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │◄────Enter Packets───────│                          │
   │     (8.5 suggested)     │                          │
   │                         │                          │
   │ Confirm: 10 packets     │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │                         ├─Generate Request#───────→│
   │                         │  SR202412180001          │
   │                         │                          │
   │                         ├─Create Request──────────→│ sowingrequests
   │                         │  status: PENDING         │
   │                         │  packetsNeeded: 8.5      │
   │                         │  packetsRequested: 10    │
   │                         │  excessPackets: 1.5      │
   │                         │                          │
   │                         ├─Link to Slot────────────→│ plantslots
   │                         │  linkedSowingRequests[]  │
   │                         │                          │
   │                         ├─Log Transaction─────────→│ slotTrail[]
   │                         │  STOCK_REQUEST_CREATED   │
   │                         │                          │
   │◄────Success─────────────│                          │
   │ Request #SR202412180001 │                          │
   │                         │                          │


PHASE 3: INVENTORY REVIEW & STOCK ISSUE
═══════════════════════════════════════

Inventory Manager        System                    Database
   │                         │                          │
   │ View Pending Requests   │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │     ┌─Pending Request───┐│                          │
   │◄────┤ SR202412180001    ││                          │
   │     │ Tomato-Hybrid     ││                          │
   │     │ 10 packets        ││                          │
   │     │ Available: Yes    ││                          │
   │     └───────────────────┘│                          │
   │                         │                          │
   │ Click "Issue Stock"     │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │                         ├─Check Inventory─────────→│ inventoryoutwards
   │                         │  (Available: 15 pkts)    │
   │                         │                          │
   │                         ├─Create Outward──────────→│ inventoryoutwards
   │                         │  purpose: production     │
   │                         │  quantity: 10            │
   │                         │                          │
   │                         ├─Update Request──────────→│ sowingrequests
   │                         │  status: ISSUED          │
   │                         │  issuedDate: now()       │
   │                         │  outwardId: OUT123       │
   │                         │  sowingInProgress: true  │
   │                         │                          │
   │                         ├─Update Slot─────────────→│ plantslots
   │                         │  sowingInProgress: true  │
   │                         │                          │
   │                         ├─Log Transaction─────────→│ slotTrail[]
   │                         │  STOCK_REQUEST_ISSUED    │
   │                         │                          │
   │◄────Success─────────────│                          │
   │ Stock Issued            │                          │
   │ Outward: OUT123         │                          │
   │                         │                          │


PHASE 4: PRIMARY SOWING ENTRY
═════════════════════════════

Sowing Staff             System                    Database
   │                         │                          │
   │ Open Primary Entry      │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │◄────Load Packets────────│                          │
   │ Available: 10 packets   │                          │
   │ (auto-filled)           │                          │
   │                         │                          │
   │ ┌─Confirm Details──────┐│                          │
   │ │ Packets: 10          ││                          │
   │ │ Primary: 1000 plants ││                          │
   │ │ Date: 18-12-2024     ││                          │
   │ │ Location: OFFICE     ││                          │
   │ └──────────────────────┘│                          │
   │                         │                          │
   │ Click "Confirm & Save"  │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │                         ├─Create Sowing───────────→│ sowings
   │                         │  plantId, subtypeId      │
   │                         │  sowedPlant: 1000        │
   │                         │  sowingLocation: OFFICE  │
   │                         │  packets: [outward data] │
   │                         │                          │
   │                         ├─Update Slot─────────────→│ plantslots
   │                         │  officeSowed += 1000     │
   │                         │  plantsSowed += 1000     │
   │                         │                          │
   │                         ├─Update Request──────────→│ sowingrequests
   │                         │  sowedQuantity: 1000     │
   │                         │  remainingSowing: 0      │
   │                         │  sowingCompleted: true   │
   │                         │  status: COMPLETED       │
   │                         │                          │
   │                         ├─Update Slot Status──────→│ plantslots
   │                         │  sowingCompleted: true   │
   │                         │  sowingInProgress: false │
   │                         │                          │
   │                         ├─Log Transaction─────────→│ slotTrail[]
   │                         │  SOWING_COMPLETED        │
   │                         │                          │
   │◄────Success─────────────│                          │
   │ Sowing Completed!       │                          │
   │ Share on WhatsApp?      │                          │
   │                         │                          │
```

---

## 🌱 Excessive Sowing Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    EXCESSIVE SOWING REQUEST FLOW                           │
│                     (No Customer Orders)                                   │
└───────────────────────────────────────────────────────────────────────────┘

PHASE 1: IDENTIFY NEED FOR EXCESSIVE SOWING
═══════════════════════════════════════════

Manager                  System                    Database
   │                         │                          │
   │ Forecast: Need extra    │                          │
   │ Tomato for next month   │                          │
   │                         │                          │
   │ Click "Create Excessive │                          │
   │        Sowing"          │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │     ┌─Modal Opens──────┐│                          │
   │◄────┤ Select Plant     ││                          │
   │     │ Select Subtype   ││                          │
   │     │ Enter Packets    ││                          │
   │     │ Pick Date        ││                          │
   │     └──────────────────┘│                          │
   │                         │                          │


PHASE 2: CARD EXISTENCE CHECK
═════════════════════════════

Manager                  System                    Database
   │                         │                          │
   │ Selected:               │                          │
   │ - Tomato                │                          │
   │ - Hybrid                │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │                         ├─Check Card Exists───────→│ plantslots
   │                         │  date: 25-12-2024        │
   │                         │  plantId: xxx            │
   │                         │  subtypeId: yyy          │
   │                         │                          │
   │                    ┌────YES────┐                   │
   │                    │  Card     │                   │
   │                    │  Exists   │                   │
   │                    └────┬──────┘                   │
   │                         │                          │
   │◄────Warning─────────────│                          │
   │ "Card exists for this   │                          │
   │  date. Will add to      │                          │
   │  existing card."        │                          │
   │                         │                          │
   │                    ┌────NO─────┐                   │
   │                    │  Create   │                   │
   │                    │  New Card │                   │
   │                    └────┬──────┘                   │
   │                         │                          │
   │◄────Info────────────────│                          │
   │ "Will create new card"  │                          │
   │                         │                          │


PHASE 3: REQUEST CREATION
═════════════════════════

Manager                  System                    Database
   │                         │                          │
   │ ┌─Confirm Details──────┐│                          │
   │ │ Plant: Tomato        ││                          │
   │ │ Subtype: Hybrid      ││                          │
   │ │ Packets: 20          ││                          │
   │ │ Expected: 2000 plants││                          │
   │ │ Date: 25-12-2024     ││                          │
   │ │ Ready By: 15-01-2025 ││                          │
   │ └──────────────────────┘│                          │
   │                         │                          │
   │ Click "Create Request"  │                          │
   ├────────────────────────→│                          │
   │                         │                          │
   │                         ├─Generate Request#───────→│
   │                         │  SR202412180002          │
   │                         │                          │
   │                         ├─Create Request──────────→│ sowingrequests
   │                         │  status: PENDING         │
   │                         │  packetsRequested: 20    │
   │                         │  isExcessiveSowing: true │
   │                         │  remainingSowing: 2000   │
   │                         │                          │
   │                         │                          │
   │                    ┌────IF CARD EXISTS────┐        │
   │                    │                      │        │
   │                    │  ├─Update Slot───────────────→│ plantslots
   │                    │  │  excessiveSowing:         │
   │                    │  │    packets += 20          │
   │                    │  │    plants += 2000         │
   │                    │  │  totalPlants += 2000      │
   │                    │  │                           │
   │                    └──────────────────────┘        │
   │                         │                          │
   │                    ┌────IF NO CARD────────┐        │
   │                    │                      │        │
   │                    │  ├─Create Slot────────────────→│ plantslots
   │                    │  │  startDay: 25-12-2024     │
   │                    │  │  totalPlants: 2000        │
   │                    │  │  excessiveSowing:         │
   │                    │  │    packets: 20            │
   │                    │  │    plants: 2000           │
   │                    │  │  isManual: true           │
   │                    │  │                           │
   │                    └──────────────────────┘        │
   │                         │                          │
   │                         ├─Link Request to Slot────→│
   │                         │  linkedSowingRequests[]  │
   │                         │  linkedSlotIds[]         │
   │                         │                          │
   │                         ├─Log Transaction─────────→│ slotTrail[]
   │                         │  EXCESSIVE_SOWING_ADDED  │
   │                         │                          │
   │◄────Success─────────────│                          │
   │ Request #SR202412180002 │                          │
   │ Card created/updated    │                          │
   │                         │                          │


PHASE 4: SAME AS REGULAR FLOW
════════════════════════════

   After this point, the flow is identical to regular sowing:
   
   1. Inventory Manager reviews → Issues stock
   2. Request status: PENDING → ISSUED
   3. Sowing staff enters sowing data
   4. Request status: ISSUED → COMPLETED
   5. Transaction logged throughout
```

---

## 📊 Gap Calculation Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         GAP CALCULATION LOGIC                              │
└───────────────────────────────────────────────────────────────────────────┘

INPUT: Slot
   │
   ├─────────────────────────────────────────┐
   │                                         │
   ▼                                         ▼
┌──────────────────────┐          ┌──────────────────────┐
│   Get Orders for     │          │   Get Sowing Data    │
│      This Slot       │          │    for This Slot     │
└──────────┬───────────┘          └──────────┬───────────┘
           │                                  │
           ▼                                  ▼
    ┌────────────┐                     ┌────────────┐
    │ Order 1:   │                     │ Office     │
    │   500 plts │                     │   300 plts │
    └────────────┘                     └────────────┘
    ┌────────────┐                     ┌────────────┐
    │ Order 2:   │                     │ Primary    │
    │   300 plts │                     │   200 plts │
    └────────────┘                     └────────────┘
    ┌────────────┐
    │ Order 3:   │
    │   400 plts │
    └────────────┘
           │                                  │
           ▼                                  ▼
    ┌─────────────┐                    ┌─────────────┐
    │ Sum Orders  │                    │ Sum Sowing  │
    │ Total: 1200 │                    │ Total: 500  │
    └──────┬──────┘                    └──────┬──────┘
           │                                  │
           └──────────────┬───────────────────┘
                          ▼
                   ┌─────────────┐
                   │ Raw Gap =   │
                   │ 1200 - 500  │
                   │ = 700 plts  │
                   └──────┬──────┘
                          │
                ┌─────────▼─────────┐
                │ Check Buffer      │
                │ Configured?       │
                └─────────┬─────────┘
                          │
            ┌─────────────┴─────────────┐
            │                           │
            ▼ YES                       ▼ NO
    ┌───────────────┐           ┌──────────────┐
    │ Apply Buffer  │           │ Use Raw Gap  │
    │ 700 + (700×10%)│          │ Gap = 700    │
    │ = 700 + 70    │           └──────┬───────┘
    │ = 770 plts    │                  │
    └───────┬───────┘                  │
            │                          │
            └──────────┬───────────────┘
                       ▼
             ┌──────────────────┐
             │  Booking Gap =   │
             │    770 plants    │
             └────────┬─────────┘
                      │
                      ▼
             ┌──────────────────┐
             │ Calculate Packets │
             │   Needed          │
             │ 770 ÷ 100 = 7.7  │
             └────────┬──────────┘
                      │
                      ▼
               OUTPUT:
              ┌────────────────┐
              │ Gap: 770       │
              │ Packets: 7.7   │
              │ Buffer: 70     │
              │ Raw Gap: 700   │
              └────────────────┘
```

---

## 🔄 Transaction Logging Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      SLOT TRANSACTION LOGGING                              │
└───────────────────────────────────────────────────────────────────────────┘

ANY SLOT CHANGE EVENT
         │
         ▼
┌─────────────────┐
│ Slot Modified   │
│                 │
│ Before: {...}   │
│ After:  {...}   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│     Identify Change Type                │
│                                         │
│  - totalPlants changed?                 │
│  - buffer changed?                      │
│  - sowing started/completed?            │
│  - request created/issued/cancelled?    │
│  - excessive sowing added?              │
└────────┬────────────────────────────────┘
         │
         ▼
    ┌────────┐
    │ Switch │
    │  Case  │
    └───┬────┘
        │
   ┌────┴────┬────────────┬────────────┬───────────┐
   │         │            │            │           │
   ▼         ▼            ▼            ▼           ▼
┌──────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Add  │ │Buffer│ │ Request  │ │ Sowing   │ │Excessive │
│Plants│ │Change│ │ Created  │ │ Started  │ │ Sowing   │
└──┬───┘ └───┬──┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
   │         │         │            │            │
   └────┬────┴────┬────┴────────┬───┴───────┬────┘
        │         │             │           │
        ▼         ▼             ▼           ▼
   ┌──────────────────────────────────────────┐
   │        Build Trail Entry                 │
   │                                          │
   │  {                                       │
   │    action: "SOWING_STARTED",            │
   │    quantity: 1000,                      │
   │    previousTotalPlants: 5000,           │
   │    newTotalPlants: 5000,                │
   │    previousAvailablePlants: 2000,       │
   │    newAvailablePlants: 1000,            │
   │    bufferPercentage: 10,                │
   │    bufferAmount: 500,                   │
   │    reason: "Sowing started at OFFICE",  │
   │    performedBy: userId,                 │
   │    sowingRequestId: requestId,          │
   │    notes: "Stock issued from OUT123",   │
   │    timestamp: Date.now()                │
   │  }                                       │
   └──────────────────┬───────────────────────┘
                      │
                      ▼
            ┌─────────────────┐
            │ Add to slotTrail│
            │     Array       │
            │  (unshift)      │
            └────────┬────────┘
                     │
                     ▼
              ┌─────────────┐
              │ Save Slot   │
              │ to Database │
              └──────┬──────┘
                     │
                     ▼
              ┌─────────────┐
              │ Transaction │
              │   Logged    │
              └─────────────┘

AUDIT TRAIL EXAMPLE:
══════════════════

slot.slotTrail = [
  {
    action: "SOWING_COMPLETED",
    timestamp: "2024-12-18T15:30:00Z",
    performedBy: "user123",
    quantity: 1000,
    ...
  },
  {
    action: "SOWING_STARTED",
    timestamp: "2024-12-18T09:00:00Z",
    performedBy: "user123",
    quantity: 1000,
    ...
  },
  {
    action: "STOCK_REQUEST_ISSUED",
    timestamp: "2024-12-18T08:45:00Z",
    performedBy: "manager456",
    sowingRequestId: "SR202412180001",
    ...
  },
  {
    action: "STOCK_REQUEST_CREATED",
    timestamp: "2024-12-18T08:30:00Z",
    performedBy: "user123",
    sowingRequestId: "SR202412180001",
    ...
  }
]
```

---

## 🎯 Priority Calculation Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    PRIORITY CALCULATION ALGORITHM                          │
└───────────────────────────────────────────────────────────────────────────┘

INPUT: Slot + Sow By Date
         │
         ▼
┌─────────────────┐
│ Get Today's     │
│     Date        │
│                 │
│ Today: Dec 18   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Get Sow By Date │
│ from Slot       │
│                 │
│ SowBy: Dec 16   │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ Calculate Days      │
│   Difference        │
│                     │
│ Days = SowBy - Today│
│ Days = 16 - 18 = -2 │
└──────────┬──────────┘
           │
           ▼
    ┌──────────────┐
    │ Days Until   │
    │  Sow By?     │
    └──────┬───────┘
           │
    ┌──────┴───────┬──────────┬──────────┬─────────┐
    │              │          │          │         │
    ▼ < 0         ▼ ≤ 2     ▼ ≤ 5     ▼ > 5    ▼
┌────────┐   ┌────────┐ ┌────────┐ ┌────────┐
│OVERDUE │   │URGENT  │ │UPCOMING│ │FUTURE  │
│  🔴   │   │  🟠   │ │  🔵   │ │  ⚪   │
│        │   │        │ │        │ │        │
│ Past   │   │ 0-2    │ │ 3-5    │ │ 5+     │
│  due   │   │ days   │ │ days   │ │ days   │
└────┬───┘   └────┬───┘ └────┬───┘ └────┬───┘
     │            │          │          │
     └────────────┴──────────┴──────────┘
                  │
                  ▼
           ┌────────────┐
           │ Set Color  │
           │ & Display  │
           └────────────┘

EXAMPLES:
═══════

Today: Dec 18

Case 1: Sow By = Dec 15
  Days = 15 - 18 = -3
  Priority = OVERDUE 🔴
  Message = "3 days overdue"

Case 2: Sow By = Dec 19
  Days = 19 - 18 = 1
  Priority = URGENT 🟠
  Message = "Sow within 1 day"

Case 3: Sow By = Dec 22
  Days = 22 - 18 = 4
  Priority = UPCOMING 🔵
  Message = "Sow within 4 days"

Case 4: Sow By = Dec 30
  Days = 30 - 18 = 12
  Priority = FUTURE ⚪
  Message = "Sow in 12 days"
```

---

## 📈 Progress Tracking Flow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                   SOWING PROGRESS TRACKING                                 │
└───────────────────────────────────────────────────────────────────────────┘

REQUEST CREATED
   │
   │  packetsRequested = 10
   │  conversionFactor = 100
   │  expectedPlants = 10 × 100 = 1000
   │
   ▼
┌─────────────────────────────┐
│ Initial State               │
│                             │
│ sowedQuantity: 0            │
│ remainingSowing: 1000       │
│ progress: 0%                │
│ sowingInProgress: false     │
│ sowingCompleted: false      │
└──────────────┬──────────────┘
               │
               │ [Stock Issued]
               ▼
┌─────────────────────────────┐
│ Status: ISSUED              │
│                             │
│ sowingInProgress: true      │
│ sowingStartedDate: set      │
└──────────────┬──────────────┘
               │
               │ [First Sowing: 300 plants]
               ▼
┌─────────────────────────────┐
│ After First Sowing          │
│                             │
│ sowedQuantity: 0 + 300 = 300│
│ remaining: 1000 - 300 = 700 │
│ progress: 300/1000 = 30%    │
│ sowingInProgress: true      │
│ sowingCompleted: false      │
└──────────────┬──────────────┘
               │
               │ [Second Sowing: 400 plants]
               ▼
┌─────────────────────────────┐
│ After Second Sowing         │
│                             │
│ sowedQuantity: 300+400 = 700│
│ remaining: 1000 - 700 = 300 │
│ progress: 700/1000 = 70%    │
│ sowingInProgress: true      │
│ sowingCompleted: false      │
└──────────────┬──────────────┘
               │
               │ [Final Sowing: 300 plants]
               ▼
┌─────────────────────────────┐
│ After Final Sowing          │
│                             │
│ sowedQuantity: 700+300 =1000│
│ remaining: 1000 - 1000 = 0  │
│ progress: 1000/1000 = 100%  │
│ sowingInProgress: false     │
│ sowingCompleted: true ✅    │
│ sowingCompletedDate: set    │
└──────────────┬──────────────┘
               │
               ▼
        ┌─────────────┐
        │   STATUS:   │
        │  COMPLETED  │
        └─────────────┘

VISUAL PROGRESS BAR:
═══════════════════

Initial:
[░░░░░░░░░░] 0%

After 300:
[███░░░░░░░] 30%

After 700:
[███████░░░] 70%

After 1000:
[██████████] 100% ✅
```

---

## 🔗 Data Relationships Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        DATABASE RELATIONSHIPS                               │
└────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────┐
                    │  PlantCms   │
                    │             │
                    │ plantName   │
                    │ subtypes[]  │
                    └──────┬──────┘
                           │ 1
                           │
                           │ N
                    ┌──────▼──────┐
                    │ PlantSlot   │◄──────────────────┐
                    │             │                   │
                    │ plantId     │                   │
                    │ year: 2024  │                   │
                    │ subtypeSlots│                   │
                    │   └─slots[] │                   │
                    └──────┬──────┘                   │
                           │ 1                        │
                           │                          │
                           │ N                        │
                    ┌──────▼──────┐                   │
                    │    Slot     │                   │
                    │             │                   │
                    │ startDay    │                   │
                    │ totalPlants │                   │
                    │ orders[]────┼───┐               │
                    │ linkedReqs[]├───┼───┐           │
                    │ slotTrail[] │   │   │           │
                    └─────────────┘   │   │           │
                                      │   │           │
                           ┌──────────┘   │           │
                           │ N            │ N         │
                           │              │           │
                    ┌──────▼──────┐ ┌─────▼────┐     │
                    │   Order     │ │ Sowing   │     │
                    │             │ │ Request  │     │
                    │ orderNumber │ │          │     │
                    │ items[]     │ │ request# │     │
                    │  ├─plantId  │ │ plantId  │     │
                    │  ├─subtypeId│ │ subtypeId│     │
                    │  ├─slotId───┼─┘ status   │     │
                    │  └─plants   │ │ outwardId├───┐ │
                    └─────────────┘ │ linkedS[]├───┼─┘
                                    └──────────┘   │
                                                   │
                                           ┌───────▼────────┐
                                           │ Inventory      │
                                           │   Outward      │
                                           │                │
                                           │ purpose: prod  │
                                           │ items[]        │
                                           │  ├─productId   │
                                           │  ├─batch       │
                                           │  └─quantity    │
                                           └────────┬───────┘
                                                    │
                                                    │ N
                                           ┌────────▼───────┐
                                           │    Product     │
                                           │                │
                                           │ productName    │
                                           │ plantId        │
                                           │ purpose: prod  │
                                           │ conversion     │
                                           └────────────────┘

LEGEND:
═══════
  1 = One
  N = Many
  ├─ = Has many
  ─► = References
  ◄─ = Referenced by
```

---

**Last Updated: December 18, 2024**
**Version: 1.0.0**






