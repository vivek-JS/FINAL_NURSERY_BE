# 🍌 Banana Slots Creation Plan

## Overview
Create 7-day slots for all Banana subtypes for years 2025 and 2026.

## Current State
- **Plant**: Banana (ID: 68fdf6d45832d541b274acfa)
- **Current Slot Size**: 5 days
- **Subtypes**: 
  1. G-9 (68fdf6d45832d541b274acfb)
  2. Vasai (68fdf6d45832d541b274acfc)
- **Existing Slots**: 0 (no slots currently exist)

## Requirements
1. **Slot Size**: 7 days (change from current 5 days)
2. **Years**: 2025 and 2026
3. **Date Range**: January 1 to December 31 for both years
4. **Capacity**: 30,000 plants per day
   - For 7-day slot: 30,000 × 7 = **210,000 total plants per slot**
5. **Subtypes**: All subtypes (G-9 and Vasai)

## Slot Generation Logic

### Date Range Calculation
- **Start Date**: 01-01-2025 (January 1, 2025)
- **End Date**: 31-12-2025 (December 31, 2025)
- **Start Date 2026**: 01-01-2026 (January 1, 2026)
- **End Date 2026**: 31-12-2026 (December 31, 2026)

### 7-Day Slot Generation
- Each slot spans 7 consecutive days
- Slots start from January 1 and continue until December 31
- Last slot may be shorter if days don't divide evenly

**Example for January 2025:**
- Slot 1: 01-01-2025 to 07-01-2025 (7 days)
- Slot 2: 08-01-2025 to 14-01-2025 (7 days)
- Slot 3: 15-01-2025 to 21-01-2025 (7 days)
- Slot 4: 22-01-2025 to 28-01-2025 (7 days)
- Slot 5: 29-01-2025 to 31-01-2025 (3 days - last partial slot)

### Expected Slot Count
- **2025**: ~52 slots per subtype (365 days ÷ 7 ≈ 52 slots)
- **2026**: ~52 slots per subtype (366 days ÷ 7 ≈ 52 slots)
- **Total**: ~104 slots per subtype × 2 subtypes = **~208 slots total**

## Slot Configuration

### Per Slot Settings
```javascript
{
  slotSize: 7,                    // 7-day slots
  totalPlants: 210000,             // 30,000 per day × 7 days
  availablePlants: 210000,          // Initially equals totalPlants
  totalBookedPlants: 0,            // No bookings initially
  plantsSowed: 0,                  // No sowing initially
  officeSowed: 0,                  // No office sowing
  primarySowed: 0,                 // No primary sowing
  buffer: 0,                       // No buffer (or use plant-level buffer)
  status: true,                    // Slot is active
  isOverflow: false,               // Not in overflow
  orders: [],                      // Empty orders array
  isManual: false                  // Auto-generated
}
```

### Month Assignment
- Each slot will have a `month` field based on the slot's start date
- Example: Slot starting 01-01-2025 → month: "January"

## Implementation Steps

### Step 1: Generate Date Ranges
- Create function to generate 7-day slots from start to end date
- Handle edge cases (last partial slot)

### Step 2: Create PlantSlot Documents
- One document per year (2025 and 2026)
- Each document contains all subtypes
- Each subtype contains all its slots

### Step 3: Slot Structure
```
PlantSlot {
  plantId: Banana._id,
  year: 2025,
  subtypeSlots: [
    {
      subtypeId: G-9._id,
      slots: [/* ~52 slots */]
    },
    {
      subtypeId: Vasai._id,
      slots: [/* ~52 slots */]
    }
  ]
}
```

### Step 4: Validation
- Verify all slots are created
- Check date ranges are correct
- Verify totalPlants = 210,000 for each slot
- Ensure no gaps in date coverage

## Expected Results

### After Creation
- **2 PlantSlot documents** (one for 2025, one for 2026)
- **~104 slots per subtype** (52 per year)
- **~208 total slots** (104 × 2 subtypes)
- **Total capacity**: ~43,680,000 plants (208 slots × 210,000)

### API Response
- `/api/v1/slots/subtyps?plantId=68fdf6d45832d541b274acfa&year=2025`
  - Should show 2 subtypes
  - Each with ~52 slots
  - Each slot with 210,000 totalPlants

## Notes
- Script will **replace** existing slots if any exist for Banana
- Plant's `slotSize` field may need to be updated to 7 (currently 5)
- Consider updating `plantReadyDays` for subtypes if needed



