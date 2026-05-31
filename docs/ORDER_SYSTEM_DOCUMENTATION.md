# Order System – Full Documentation

This document explains how **orders** work in the Nursery Management system: from the **Add Order** form in the frontend, through **backend routes** (order, farmer, dealer, inventory), **slots**, **dealer quota**, **payment capture**, and **delivery/dispatch**. It includes **model schemas** and **logic for each action**.

---

## 1. Overview: What Is an Order?

An **order** is a booking of plants for a farmer (or for a dealer’s own stock). Each order has:

- **Farmer** (or dealer, for dealer orders)
- **Plant** (plant type + subtype)
- **Booking slot** (delivery period – date range)
- **Quantity** (number of plants), **rate**, **payment** details
- **Quota source** (company slot vs dealer wallet) when applicable
- **Status** (PENDING → ACCEPTED → READY_FOR_DISPATCH → DISPATCHED, etc.)

Two main flows:

1. **Farmer order** – Order for an end farmer (created via farmer + order in one or two steps).
2. **Dealer order** – Either:
   - **Bulk / dealer’s own stock**: dealer “buys” from company slot → slot capacity goes down, dealer’s **quota (wallet)** goes up; or  
   - **Farmer order through dealer**: can use **dealer quota** (wallet minus) or **company quota** (slot minus).

---

## 2. Frontend: AddOrderForm.jsx

**File:** `nursery-mgmt/src/pages/private/order/AddOrderForm.jsx`

### 2.1 What the form does

- **Order type**: Normal, Instant, or Bulk.
- **Farmer details**: Name, village, taluka, district, state, mobile (with optional auto-fill from mobile).
- **Plant & slot**: Plant, subtype, cavity, **order date** (which maps to a **slot**), sales person or dealer.
- **Quota type** (when dealer is involved): **Dealer quota** or **Company quota**.
- **Payment**: Amount, date, mode, bank, remark, receipt photo, wallet payment flag.
- **Review & submit**: Confirmation dialog then API call.

### 2.2 How slot is chosen

- User picks an **order date** (delivery date).
- `getSlotIdForDate(formData.orderDate)` (or `formData.transferredSlotId` if transferred) gives the **slot ID**.
- That slot ID is sent as `bookingSlot` in the payload.

### 2.3 Which API is called

- **Bulk order** (dealer’s own stock):  
  `API.ORDER.CREATE_DEALER_ORDER` → **POST `/api/v1/order/dealer-order`**
- **Normal order** (farmer order, with or without dealer):  
  `API.FARMER.CREATE_FARMER` → **POST `/api/v1/farmer/createFarmer`**

So:

- **Farmer order** → Farmer route (createFarmer + createOrder in one request).
- **Dealer bulk order** → Order route (createDealerOrder only).

Payload for both includes: farmer/location fields, `numberOfPlants`, `rate`, `plantName`, `plantSubtype`, `bookingSlot`, `orderDate`/`deliveryDate`, `salesPerson`/`dealer`, `dealerOrder`, `componyQuota` (company vs dealer quota), `orderFor`, `productName`/`productMappingId` (for ready plants), screenshots, etc.

---

## 3. Backend Routes and How They Connect

### 3.1 Route mounting (app.js)

- **Farmer:** `server.use("/api/v1/farmer", authenticateToken, farmerRoute);`
- **Order:** `server.use("/api/v1/order", authenticateToken, orderRoute);`
- **Dealer:** `server.use("/api/v1/dealer", authenticateToken, DelaerRoutes);`
- **Inventory:** `server.use("/api/v1/inventory", authenticateToken, inventoryRoute);` (and more specific inventory paths)

So:

- **Farmer order creation** → `/api/v1/farmer/createFarmer` (farmer route).
- **Dealer order creation** → `/api/v1/order/dealer-order` (order route).
- **Dealer-specific** actions (e.g. get orders by booking, add payment) → `/api/v1/dealer/...` (dealer route).
- **Inventory** (products, batches, inwards, outwards, Ram Agri, etc.) → `/api/v1/inventory/...`.

### 3.2 Order route – `FINAL_NURSERY_BE/routes/order.route.js`

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| GET | /getCSV | getCsv | Export orders CSV |
| GET | /slots | getOrdersBySlot | Orders by slot |
| GET | /getOrders | getOrders | List orders |
| GET | /by-status | getOrdersByStatus | Filter by status |
| GET | /payments | getAllPayments | All payments |
| GET | /villages, /districts | getUniqueVillages, getUniqueDistricts | Dropdowns |
| GET | /cavities | getAllCavitiesFromOrders | Cavity list |
| GET | /bucketing | getOrderBucketing | Order bucketing |
| GET | /dealer-wallet/:orderId | getDealerWalletBalanceForOrder | Dealer wallet for order |
| GET | /to-be-dispatched | getOrdersToBeDispatched | Orders for dispatch (by delivery date) |
| GET | /dispatch-details/:orderId | getOrderDispatchDetails | Dispatch details for one order |
| GET | /by-dispatch/:transportId | getOrdersByDispatch | Orders in a dispatch |
| GET | /dispatch-summary | getDispatchSummary | Dispatch summary |
| PATCH | /payment/:orderId | addNewPayment | **Add/capture payment** (single screenshot) |
| PATCH | /updatePaymentStatus | updatePaymentStatus | Mark payment COLLECTED/REJECTED/PENDING |
| PATCH | /updateOrder | updateOrder | Update order (e.g. status, delivery) |
| POST | /dealer-order | createDealerOrder | **Create dealer/bulk order** (with screenshots) |
| PATCH | /afterOrder | addAfterDispatchedOrderIds | Attach order IDs to dispatch after dispatch |

So:

- **Creating a dealer/bulk order** and **adding payment** to any order are done via **order route**.
- **Delivery/dispatch** is supported by **to-be-dispatched**, **dispatch-details**, **by-dispatch**, **dispatch-summary**, and **afterOrder**.

### 3.3 Farmer route – `FINAL_NURSERY_BE/routes/farmer.route.js`

| Method | Path | Middlewares / Controller | Purpose |
|--------|------|--------------------------|---------|
| POST | /createFarmer | createVillage, createTaluka, createDistrict, createFarmer, **createOrder** | **Create farmer + order in one request** |

Flow:

1. Body has both farmer fields (name, village, taluka, district, mobileNumber, etc.) and order fields (salesPerson, numberOfPlants, rate, paymentStatus, plantName, plantSubtype, bookingSlot, orderDate, deliveryDate, cavity, …).
2. createFarmer: creates/finds farmer by mobile, sets `req.body.farmer = farmer._id`, then `next()`.
3. createOrder: same as order controller’s **createOne(Order)** (factory) – so it uses the same slot/quota logic as dealer-order, but with `farmer` set and no `dealerOrder`.

So **farmer order** and **dealer order** both end up in the same **factory createOne(Order)** logic; only the payload (farmer vs dealer, dealerOrder, componyQuota) differs.

### 3.4 Dealer route – `FINAL_NURSERY_BE/routes/dealer.route.js`

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| POST | /orders | createDealerOrder | Create dealer order (in code this is currently a stub; real creation is via order route) |
| GET | /orders/:bookingId | getDealerOrdersByBooking | Get dealer’s orders by booking |
| POST | /orders/:orderId/payment | updateDealerOrderPayment | Add payment to a dealer order (updates order + dealer booking summary) |

Note: In the codebase, **order creation** for the Add Order form goes through **order.route.js** (`/order/dealer-order`) and **farmer.route.js** (`/farmer/createFarmer`). The dealer route’s `createDealerOrder` in `dealer.controller.js` is a stub. Payment for dealer orders can be added either via **order** route (`PATCH /order/payment/:orderId`) or **dealer** route (`POST /dealer/orders/:orderId/payment`).

### 3.5 Inventory route – `FINAL_NURSERY_BE/routes/inventory.route.js`

Inventory route does **not** create or update farmer/dealer orders. It handles:

- Products, batches, inwards, outwards, stock adjustments.
- Ram Agri: inputs, varieties, rates, dashboard, rankboard, targets, ledgers (variety, customer, merchant), pending payments, outstanding analysis, sales analysis, video summary.

So **inventory** is about **stock and Ram Agri sales**, not the main **order booking** (slots, dealer quota, farmer order). Order booking uses **order** and **farmer** routes; **slots** are in a separate slots route.

---

## 4. Models (Schemas)

### 4.1 Order – `models/order.model.js`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| orderId | Number | yes (auto) | Unique numeric ID; pre-save sets max+1 |
| dealerOrder | Boolean | - | default false; true = dealer’s own stock order |
| farmer | ObjectId → Farmer | conditional | Required if !dealerOrder |
| dealer | ObjectId → User | conditional | Required if dealerOrder |
| salesPerson | ObjectId → User | yes | Who booked the order |
| quotaUsed | Number | - | Plants taken from dealer quota (default 0) |
| quotaRestored | Boolean | - | Whether quota was restored on reject |
| quotaSource | String | - | "dealer" \| "company" \| "none" |
| originalQuotaAllocation | { fromWallet, fromSlot } | - | Snapshot for restoration |
| walletEntryId | ObjectId | - | DealerWallet entry used for this order |
| numberOfPlants | Number | yes | Base quantity |
| additionalPlants | Number | - | default 0 |
| totalPlants | Number | - | Default numberOfPlants + additionalPlants |
| remainingPlants | Number | - | totalPlants − returnedPlants (pre-save) |
| currentDispatchId | ObjectId → Dispatch | - | Latest dispatch |
| plantName | ObjectId → PlantCms | yes | |
| plantSubtype | ObjectId | yes | Subdoc ref in PlantCms |
| bookingSlot | ObjectId | yes | Slot subdoc ref in PlantSlot |
| cavity | ObjectId → Tray | - | |
| rate | Number | yes | Price per plant |
| orderPaymentStatus | String | - | "PENDING" \| "COMPLETED" (pre-save from payments) |
| payment | [paymentSchema] | - | Array of payments |
| paymentCompleted | Boolean | - | Set in pre-save when total COLLECTED ≥ order total |
| notes | String | - | |
| orderRemarks | [String] | - | |
| screenshots | [String] | - | Cloudinary URLs |
| productName | String | - | Ready plants product reference |
| productMappingId | ObjectId → PlantProductMapping | - | For ready plants |
| orderStatus | String | - | PENDING, PROCESSING, COMPLETED, CANCELLED, DISPATCHED, ACCEPTED, REJECTED, FARM_READY, READY_FOR_DISPATCH, DISPATCH_PROCESS, PARTIALLY_COMPLETED, TEMPORARY_CANCELLED |
| statusChanges | [statusChangeSchema] | - | History of status changes |
| orderBookingDate | Date | - | |
| deliveryDate | Date | - | Selected delivery date |
| farmReadyDate | Date | - | |
| farmReadyDateChanges | [schema] | - | |
| additionalPlantsHistory | [schema] | - | |
| returnedPlants | Number | - | default 0 |
| returnReason | String | - | |
| deliveryChanges | [deliveryChangeSchema] | - | |
| orderEditHistory | [orderEditHistorySchema] | - | |
| returnHistory | [{ date, quantity, reason, dispatchId, processedBy }] | - | |
| dispatchHistory | [{ date, quantity, dispatchId, remainingAfterDispatch, processedBy, driverName, vehicleName }] | - | |
| orderFor | { name, address, mobileNumber } | - | |
| expectedNursery | String | - | |
| reference | ObjectId → User | - | |
| callHistory | [{ date, calledBy, note }] | - | |
| assignedDriver, assignedVehicle, routeId, routeSequence, assignedAt, assignedBy | - | - | Dispatch/route fields |

**paymentSchema** (subdocument): paidAmount, paymentStatus (COLLECTED/REJECTED/PENDING), paymentDate, bankName, receiptPhoto[], modeOfPayment, remark, chequeNumber, isWalletPayment.

**Pre-save:** orderId auto-increment; orderPaymentStatus/paymentCompleted from COLLECTED sum; totalPlants/remainingPlants; additionalPlants/returnedPlants history; status change history; post-save status change notification.

---

### 4.2 DealerWallet – `models/dealerWallet.js`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| dealer | ObjectId → User | yes | unique per wallet |
| availableAmount | Number | - | Wallet balance (default 0) |
| entries | [entrySchema] | - | Quota per plant/subtype/slot |
| transactions | [transactionSchema] | - | CREDIT/DEBIT/ORDER_PAYMENT etc. |

**entrySchema:** plantType (ObjectId → PlantCms), subType (ObjectId), bookingSlot (ObjectId), quantity, bookedQuantity, remainingQuantity. Pre-save: remainingQuantity = quantity − bookedQuantity.

**transactionSchema:** type (CREDIT/DEBIT/ORDER_PAYMENT/PAYMENT_STATUS_UPDATE/ADJUSTMENT), amount, description, balanceBefore, balanceAfter, performedBy, relatedOrder.

**Static:** `addPayment(dealerId, amount, description, performedBy, type, relatedOrder)` – appends transaction, updates availableAmount (balanceAfter = balanceBefore + amount). Positive amount = credit, negative = debit.

---

### 4.3 PlantSlot & Slot – `models/slots.model.js`

**PlantSlot** (top level): plantId (ObjectId → PlantCms), year (Number), subtypeSlots[].

**SubtypeSlot:** subtypeId (ObjectId), slots[].

**Slot** (bookable unit):

| Field | Type | Description |
|-------|------|-------------|
| startDay, endDay | String | dd-mm-yyyy |
| totalPlants | Number | Capacity (default 0) |
| totalBookedPlants | Number | Legacy; also derived from orders |
| availablePlants | Number | Buffer-adjusted bookable (default totalPlants) |
| buffer, effectiveBuffer, bufferAdjustedCapacity, bufferAmount, originalTotalPlants | Number | Buffer fields |
| isOverflow, overflow | Boolean | Overbooked state |
| orders | [ObjectId] | Order refs |
| allowedSalesmen, restrictToSalesmen | - | Access control |
| status | Boolean | |
| month | String | January..December |
| plantReadyDays | Number | |
| plantsSowed, officeSowed, primarySowed | Number | Sowing counts |
| sowingDate, plantReadyDate | String | dd-mm-yyyy |
| excessiveSowing | { packets, plants } | |
| sowingCompleted, sowingCompletedDate | - | |
| sowingInProgress | [{ requestNumber, packetsIssued, plantsExpected, outwardId, ... }] | |
| productStock | [{ productName, available, booked, poQuantity, received, dateRange, displayTitle, productMappingId }] | Ready plants stock |
| slotTrail | [slotTrailSchema] | Audit log |

**slotTrailSchema:** action (ADD, SUBTRACT, BUFFER_APPLIED, ORDER_CANCELLED, SOWING_*, etc.), activityName, quantity, plus/minus/before/after snapshots, previousTotalPlants, newTotalPlants, reason, orderId, performedBy, notes.

---

### 4.4 Farmer – `models/farmer.model.js`

| Field | Type | Required |
|-------|------|----------|
| name | String | yes |
| village, taluka, district | String | yes |
| stateName, talukaName, districtName, state | String | yes |
| mobileNumber | Number | no (sparse unique) |
| alternateNumber | Number | no |
| isInvalidPhone, originalPhoneNumber | - | no |
| referredTo | [{ farmerId, referredAt, orderId }] | - |

---

### 4.5 Dispatch – `models/dispatch.model.js`

| Field | Type | Description |
|-------|------|-------------|
| name | String | |
| transportId | String | required, unique |
| transportStatus | String | PENDING, DELIVERED, IN_TRANSIT, CANCELLED |
| orderIds | [ObjectId → Order] | required, min 1 |
| afterDispatchedOrderIds | [ObjectId → Order] | Orders added after dispatch |
| orderDispatchDetails | [{ orderId, dispatchQuantity, remainingAfterDispatch, driverName, vehicleName, ... }] | Per-order dispatch details |

---

### 4.6 DealerBooking – `models/dealerBooking.model.js` (used by dealer route)

Referenced by dealer.controller for getDealerOrdersByBooking and updateDealerOrderPayment. Holds dealer, orders[], summary (e.g. totalBooked, totalOrderPayments, paymentRemaining).

---

## 5. Logic for Each Action

### 5.1 Create order (farmer or dealer) – `createOne(Order)` in factory.controller.js

**Input:** req.body (bookingSlot, numberOfPlants, cavity, orderRemarks, componyQuota, payment, …orderData). orderData includes farmer/dealer, salesPerson, plantName, plantSubtype, orderStatus, dealerOrder, etc.

**Steps:**  
(See also **§6.5 Sowing and unlimited / overflow booking** for sowing-allowed and overflow behaviour.)

1. **Validate:** bookingSlot and numberOfPlants present. Start MongoDB session, begin transaction.
2. **Resolve salesPerson:** User.findById(salesPerson). If not found, abort and return 400.
3. **orderId:** Max orderId in Order + 1 (or 1 if none).
4. **Cavity:** If cavity sent, find Tray by cavity number; set trayId for order.
5. **Normalize componyQuota:** true/false/"true"/"false" → boolean; undefined if not sent.
6. **Slot/quota branch (all inside transaction):**
   - **Case A – dealerOrder === true (dealer’s own stock):**  
     - `updateSlot(bookingSlot, numberOfPlants, "subtract", session)` → validates slot availability (and sets overflow flags if allowed).  
     - DealerWallet: find or create by dealer; find or create **entry** (plantType, subType, bookingSlot); set **`quantity += numberOfPlants` only** (`bookedQuantity` stays for farmer consumption via `allocateDealerQuota`; `remainingQuantity` is recomputed on save as `quantity - bookedQuantity`).  
     - No farmer; order has dealer, dealerOrder true.
   - **Case B – salesPerson is DEALER and componyQuota === true (company quota):**  
     - `handleQuantityAllocation(salesPerson, plantName, plantSubtype, bookingSlot, numberOfPlants, session)` → returns { fromWallet, fromSlot }. If fromSlot > 0, `updateSlot(bookingSlot, fromSlot, "subtract", session)`. Set orderData.dealer = salesPerson._id.
   - **Case C – salesPerson is DEALER and componyQuota === false (dealer quota only):**  
     - `validateDealerQuota(...)` → if !isValid, abort 400.  
     - `allocateDealerQuota(...)` → atomic `$set` on the entry: `quantity`, `bookedQuantity`, `remainingQuantity` from order-derived totals (see §5.4). Set orderData.quotaUsed, quotaSource "dealer", originalQuotaAllocation, walletEntryId. No updateSlot.
   - **Case D – orderData.dealer set and componyQuota === false (office selected dealer quota):**  
     - Same as C: validateDealerQuota → allocateDealerQuota; if allocation.fromSlot > 0, updateSlot for that amount. Set quota fields on orderData.
   - **Case E – else (farmer order, no dealer quota):**  
     - `updateSlot(bookingSlot, numberOfPlants, "subtract", session)`.
7. **Build order doc:** statusChanges (initial if orderStatus provided), orderRemarks, remainingPlants, payment array from req (each payment PENDING), screenshots (Cloudinary upload from req.files), orderDocument with all fields.
8. **Create order:** `Model.create([orderDocument], { session })`.
9. **Update slot (post-create):** Fetch slot + plant (sowingAllowed). Decide isReadyPlantsOrder = !!(productMappingId && productName).  
   - `$push` slot.orders with new order _id.  
   - `$inc` slot.totalBookedPlants by numberOfPlants.  
   - If isReadyPlantsOrder: `$inc` slot.availablePlants **+** numberOfPlants.  
   - Else if !sowingAllowed: `$inc` slot.availablePlants **−** numberOfPlants.  
   - Else (sowing allowed): no change to availablePlants.  
   If productMappingId, update PlantProductMapping and slot.productStock (available/booked/poQuantity).
10. Commit transaction; return created order.

---

### 5.2 updateSlot(bookingSlot, numberOfPlants, action, allowOverflowOrSession, sessionParam) – factory.controller.js

**Purpose:** (1) Validate availability when action is subtract; (2) Optionally set/clear overflow flags.  
**Note:** The actual slot DB update for order booking (push order, $inc totalBookedPlants/availablePlants) is done in createOne after Order.create, not inside updateSlot.

**Steps:**

1. **Parse args:** 4th/5th params can be allowOverflow (boolean) or session; set session and allowOverflow.
2. **If action === "subtract" and !allowOverflow:**  
   - Find PlantSlot by `"subtypeSlots.slots._id": bookingSlot`, populate plantId.sowingAllowed.  
   - If plant.sowingAllowed, skip availability check.  
   - Else: find target slot; compute effectiveBuffer, bufferAmount, bufferAdjustedCapacity; availablePlants = max(0, bufferAdjustedCapacity − totalBookedPlants). If numberOfPlants > availablePlants, throw Error with message (e.g. "Not enough plants available...").  
3. **Build additionalUpdates:**  
   - subtract + allowOverflow: if booking would exceed available, set slot.isOverflow and slot.overflow = true.  
   - add + allowOverflow: if after add the slot would be back in capacity, set isOverflow and overflow = false.  
4. **Update:** PlantSlot.updateOne({ "subtypeSlots.slots._id": bookingSlot }, { $set: additionalUpdates }, { arrayFilters, session }). No $inc in this function.
5. If matchedCount === 0, throw "Failed to update the PlantSlot details". Return updateResult.

---

### 5.3 validateDealerQuota(dealerId, plantType, subType, bookingSlot, requestedQuantity) – quota.controller.js

**Returns:** { isValid, message, availableQuota, allocation: { fromWallet, fromSlot } }.

**Steps:**

1. `getDealerQuotaLineAvailability` (see `utils/dealerWalletReconcile.js`): loads DealerWallet, finds the entry, runs `aggregateDerivedFromOrders` for that dealer, and computes **sellable headroom for farmer orders** using the same line math as wallet overlay/reconcile (not raw `entry.quantity − entry.bookedQuantity`, which can be wrong when legacy bulk inflated `bookedQuantity`).
2. If no wallet / no entry → same error shapes as before (availableQuota 0).
3. Compare **availableForFarmerOrders** to `requestedQuantity` and build `allocation` / `isValid` as before.

---

### 5.4 allocateDealerQuota(dealerId, plantType, subType, bookingSlot, requestedQuantity, session) – quota.controller.js

**Returns:** { fromWallet, fromSlot, walletEntryId, success, ledgerParams }.

**Steps:**

1. Same `getDealerQuotaLineAvailability` as validate (with `session` on the wallet read).
2. If available headroom < requestedQuantity → AppError 400 (message uses derived available).
3. `findOneAndUpdate` with **`$set`** on the matching entry: `quantity` = **fixedQty**, `bookedQuantity` = **farmerBookedFromOrders + requestedQuantity**, `remainingQuantity` = **fixedQty − bookedQuantity** (order-derived farmer booked + this booking; aligns stored line with reconcile).
4. Ledger `balanceBefore` / `balanceAfter` use derived available before/after this booking.

---

### 5.5 handleQuantityAllocation(dealerId, plantType, subType, bookingSlot, requestedQuantity, session) – factory.controller.js

**Returns:** { fromWallet, fromSlot }.

**Steps:**

1. DealerWallet.findOne({ dealer }).session(session). If !wallet return { fromWallet: 0, fromSlot: requestedQuantity }.
2. Find entry for plantType/subType/bookingSlot. If none return { fromWallet: 0, fromSlot: requestedQuantity }.
3. availableInWallet = entry.quantity − entry.bookedQuantity.
4. If availableInWallet >= requestedQuantity: atomic $inc that entry’s bookedQuantity and remainingQuantity; return { fromWallet: requestedQuantity, fromSlot: 0 }.
5. Else: fromWallet = max(0, availableInWallet), fromSlot = requestedQuantity − fromWallet. If fromWallet > 0, $inc entry by fromWallet; return { fromWallet, fromSlot }.

---

### 5.6 addNewPayment (PATCH /order/payment/:orderId) – order.controller.js

**Input:** req.params.orderId, body: paidAmount, paymentStatus, paymentDate, bankName, receiptPhoto, modeOfPayment, isWalletPayment. Optional req.file (screenshot → Cloudinary).

**Steps:**

1. Upload screenshot to Cloudinary if req.file; set screenshotUrl.
2. Order.findById(orderId).populate('farmer'). If !order return 404.
3. paidAmount → Number; if NaN return 400.
4. **Final payment status:** If user jobTitle === "OFFICE_ADMIN" force PENDING; else use paymentStatus (COLLECTED/PENDING) from body.
5. Build newPayment object (paidAmount, paymentStatus: finalPaymentStatus, paymentDate, bankName, receiptPhoto, modeOfPayment, isWalletPayment). Push to order.payment.
6. Save order (pre-save will set orderPaymentStatus/paymentCompleted).
7. **Dealer wallet (if order has dealer or salesPerson is DEALER):**  
   - If isWalletPayment && (PENDING or COLLECTED): walletAmount = −amount (deduct).  
   - If order.dealerOrder && COLLECTED && !isWalletPayment: walletAmount = +amount (credit).  
   - Else: walletAmount = 0.  
   If walletAmount !== 0: DealerWallet.addPayment(dealerId, walletAmount, description, performedBy, "ORDER_PAYMENT", order._id).
8. Return 200 with updatedOrder (and transaction if any).

---

### 5.7 updatePaymentStatus (PATCH /order/updatePaymentStatus) – order.controller.js

**Input:** body: orderId (numeric), paymentId (subdoc _id), paymentStatus, and optional paidAmount, paymentDate, modeOfPayment, bankName, remark.

**Steps:**

1. Find order by orderId (numeric). Get payment by paymentId (order.payment.id(paymentId)). If !payment return 404.
2. Update payment fields from body (paidAmount, paymentDate, modeOfPayment, bankName, remark). OFFICE_ADMIN cannot set status to COLLECTED → 403.
3. **Wallet payment status change:**  
   - COLLECTED → REJECTED: credit back to dealer wallet (updateDealerWalletBalance +amount).  
   - COLLECTED → PENDING: credit back (wallet was debited when collected).  
   - PENDING/REJECTED → COLLECTED: debit dealer wallet (updateDealerWalletBalance −amount).  
   Dealer = order.dealer or (if salesPerson is DEALER) salesPerson.
4. Set payment.paymentStatus = paymentStatus. order.save() (pre-save recalculates orderPaymentStatus).
5. Optional: send push notifications (payment accepted/rejected/collected/pending). Return updated order.

**Direct order payment transfer:** Payments with `transferredFromOrderId` / `transferredFromPaymentId` (and no `transferRequestId`) come from `POST /order/farmer-plant-ledger/transfer-order-payment`. Farmer plant ledger stays neutral (no rows). Dealer-funded orders get paired dealer receivable rows on transfer (source payment reversal debit + target transfer-in credit, net-zero on dealer outstanding) and the inverse on reject-undo. Rejecting such a payment with `paymentStatus: REJECTED` undoes the transfer: target payment → REJECTED, source payment restored to COLLECTED (legacy farmer-plant transfers may write compensating lines only if rows were posted before this policy).

---

### 5.8 updateOrder (PATCH /order/updateOrder) – factory updateOne(Order)

**Input:** body includes id (order _id) and allowed fields. Disallowed list includes bookingSlot, numberOfPlants, quantity, etc. (see order.controller.js updateOrder allowed fields).

**Logic:** Standard updateOne: validate id, filter body to allowed keys, findByIdAndUpdate. Order-specific hooks (e.g. slot revert on cancel, quota restore) are applied in factory updateOne when orderStatus or other critical fields change (e.g. cancel order: updateSlot "add", restoreDealerQuota if dealer quota order).

---

### 5.9 getOrdersToBeDispatched (GET /order/to-be-dispatched) – order.controller.js

**Input:** Query startDate, endDate (delivery date range).

**Steps:**

1. Parse start/end to Date start, end.
2. Order.aggregate: match deliveryDate within [start, end] and orderStatus in allowed list (e.g. ACCEPTED, READY_FOR_DISPATCH, FARM_READY, etc.); lookup farmer, salesPerson, plantName, bookingSlot; project needed fields (orderId, farmer, deliveryDate, plantName, numberOfPlants, etc.).
3. Return { message, data: orders }.

---

### 5.10 addAfterDispatchedOrderIds (PATCH /order/afterOrder) – order.controller.js

**Input:** params.dispatchId, body.orderIds (array).

**Steps:**

1. Dispatch.findById(dispatchId). If !dispatch return 404.
2. Append orderIds to dispatch.afterDispatchedOrderIds (array merge).
3. Save dispatch. Return 200 with dispatch.

---

### 5.11 updateDealerOrderPayment (POST /dealer/orders/:orderId/payment) – dealer.controller.js

**Input:** params.orderId, body.payment (paidAmount, etc.), req.user._id (dealer).

**Steps:**

1. Find DealerOrder (or Order) where _id = orderId and dealer = dealerId. If !order return 404.
2. order.payment.push(payment). Sum totalPayments from payments with paymentStatus === "COLLECTED".
3. If totalPayments >= orderTotal (numberOfPlants * rate), set order.orderPaymentStatus = "COMPLETED", paymentCompleted = true. Save order.
4. DealerBooking.findOne({ dealer }). summary.totalOrderPayments += payment.paidAmount; summary.paymentRemaining −= payment.paidAmount; save booking.
5. Return 200 with order and booking.

---

### 5.12 restoreDealerQuota(orderId, session) – quota.controller.js

Used when an order is rejected/cancelled and had used dealer quota.

**Steps:**

1. Order.findById(orderId). If !order or !dealerOrder or quotaRestored or quotaUsed === 0, return.
2. DealerWallet.findOneAndUpdate( dealer, entries matching plantName/plantSubtype/bookingSlot, { $inc: entries.$.bookedQuantity: −quotaUsed, entries.$.remainingQuantity: +quotaUsed }, { session } ).
3. Set order.quotaRestored = true; order.save(session). Return { success, restoredQuantity }.

---

## 6. Slots – Model and Role in Orders

**File:** `FINAL_NURSERY_BE/models/slots.model.js`

### 6.1 Structure

- **PlantSlot**: per plant, per year; contains `subtypeSlots[]`.
- **SubtypeSlot**: per subtype; contains `slots[]`.
- **Slot**: the actual bookable unit with:
  - **startDay, endDay** (dd-mm-yyyy)
  - **totalPlants** (capacity)
  - **availablePlants** (buffer-adjusted: total minus buffer, minus booked)
  - **buffer**, **effectiveBuffer**, **bufferAmount**
  - **orders** (array of Order IDs)
  - **totalBookedPlants** (legacy; booking is also derived from orders)
  - Sowing-related: plantsSowed, officeSowed, primarySowed, sowingDate, plantReadyDate, sowingInProgress, productStock, etc.
  - **slotTrail** (audit of ADD/SUBTRACT/BUFFER_APPLIED/ORDER_CANCELLED, etc.)

So: **Order.bookingSlot** is the **slot _id** (subdocument inside PlantSlot → subtypeSlots → slots).

### 6.2 How orders affect slots

When an order is created (in **factory.controller.js** createOne(Order)):

- **Farmer order (no dealer / company quota):**  
  `updateSlot(bookingSlot, numberOfPlants, "subtract", session)`  
  → Slot’s **availablePlants** is reduced (and optionally overflow flags set if capacity exceeded).

- **Dealer’s own order (bulk / dealerOrder: true):**  
  1. Same: `updateSlot(bookingSlot, numberOfPlants, "subtract", session)`.  
  2. **Dealer wallet** is increased: find or create `DealerWallet` for dealer, add an **entry** (or update quantity) for this plant/subtype/slot with `quantity += numberOfPlants`, `bookedQuantity` 0, `remainingQuantity = quantity`.

- **Farmer order through dealer, company quota:**  
  `handleQuantityAllocation` may allocate partly from slot; then `updateSlot(..., allocation.fromSlot, "subtract", session)`.

- **Farmer order through dealer, dealer quota only:**  
  Only **dealer wallet** is decremented (allocateDealerQuota); **no** slot subtract (or only if allocation says fromSlot > 0 in mixed case).

So: **slot minus** = company capacity consumed for that booking. **Dealer quota minus** = dealer wallet entry’s `bookedQuantity` increased (and `remainingQuantity` decreased) in **DealerWallet**.

### 6.3 Slot trail (slots.model.js)

**slotTrail** records actions such as:

- ADD, SUBTRACT  
- BUFFER_APPLIED, BUFFER_RELEASED  
- ORDER_CANCELLED, ORDER_RETURNED  
- SOWING_*, STOCK_REQUEST_*, GAP_COVERED, etc.

So you can see **why** a slot’s numbers changed (order booked, order cancelled, buffer change, etc.).

### 6.4 Slots route – `FINAL_NURSERY_BE/routes/slots.route.js`

Slots are read/updated via slots route (e.g. getSlotsByPlantAndSubtype, updateSlotFieldById, buffer, release-buffer, add-capacity, transfer). Order creation does **not** call the slots route directly; it uses **updateSlot** from **factory.controller.js**, which updates the **PlantSlot** document (slot’s availablePlants, etc.) inside a transaction with the order creation.

### 6.5 Sowing and unlimited / overflow booking

Two ways the system allows booking beyond normal slot capacity:

---

#### Sowing-allowed (unlimited booking by plant type)

- **Source:** **PlantCms.sowingAllowed** (per plant). When `true`, that plant is treated as “sow on demand” – capacity is not fixed at slot level.
- **In updateSlot (factory.controller.js):**  
  If `action === "subtract"` and the slot’s **plantId** has `sowingAllowed === true`, the **availability check is skipped**. So no error is thrown even if `numberOfPlants > availablePlants` (effectively **unlimited booking** for that slot/plant).
- **In createOne(Order) post-create slot update:**  
  After the order is created, the slot is updated: `totalBookedPlants` is always incremented. For **sowing-allowed** plants, **availablePlants is not changed** (no `$inc` on availablePlants). So:
  - **Regular plant:** `$inc totalBookedPlants`, `$inc availablePlants` (minus).
  - **Sowing-allowed plant:** `$inc totalBookedPlants` only; availablePlants unchanged.
- **On order cancel (updateOne Order):** For sowing-allowed plants, only `totalBookedPlants` is decremented; availablePlants is not incremented.
- **Frontend (AddOrderForm.jsx):** Plants carry `sowingAllowed`; for sowing-allowed plants the UI can show all slots (even with negative availability) and may skip slot-capacity validation with a message like “This plant type supports sowing on demand. You can book any quantity regardless of current availability.”

So **sowing = unlimited booking** in the sense: no slot availability check, and slot’s availablePlants is not reduced when booking (demand is met by sowing later).

---

#### Overflow booking (allowOverflow)

- **Source:** **updateSlot(bookingSlot, numberOfPlants, "subtract", allowOverflow, session)**. When the **4th parameter `allowOverflow` is true** (e.g. Excel import or other bulk flows), the slot is allowed to be overbooked.
- **Behaviour:**  
  - Availability is still computed. If `numberOfPlants > availablePlants`, instead of throwing, the code **sets** on the slot: **isOverflow = true** and **overflow = true**. The order is still created and the slot’s totalBookedPlants/availablePlants are updated as usual (so slot can go “negative” or over capacity).  
  - On **add** (e.g. order cancel) with allowOverflow, if the slot comes back within capacity, isOverflow and overflow are set back to false.
- **Typical use:** Excel import of orders where you want to allow overbooking and mark the slot as overflow rather than failing.

So **overflow = unlimited/overbooking** in the sense: allow booking more than available and mark the slot as overbooked (isOverflow/overflow), instead of rejecting the order.

---

| Type | When | Effect |
|------|------|--------|
| **Sowing-allowed** | Plant has `sowingAllowed: true` | No availability check; only totalBookedPlants changes; availablePlants unchanged on book/cancel. |
| **Overflow** | updateSlot(..., allowOverflow = true) | Availability check skipped or overbooking allowed; slot.isOverflow and slot.overflow set when over capacity. |

---

## 7. Dealer Quota and “Minus”

### 7.1 DealerWallet model – `FINAL_NURSERY_BE/models/dealerWallet.js`

- One **DealerWallet** per dealer.
- **entries[]**: each entry = plantType + subType + bookingSlot + **quantity** (total quota for that combo) + **bookedQuantity** + **remainingQuantity**.
- **transactions[]**: CREDIT/DEBIT/ORDER_PAYMENT/PAYMENT_STATUS_UPDATE/ADJUSTMENT for wallet balance (e.g. payment collected adds to wallet; wallet payment deducts).

So:

- **Quota “minus”** = when an order uses **dealer quota**, the matching wallet **entry** has `bookedQuantity` increased and `remainingQuantity` decreased (in **quota.controller.js** `allocateDealerQuota`).
- **Wallet balance** = separate from quota entries; used when dealer pays or receives money (payment capture).

### 7.2 When is dealer quota used?

In **factory.controller.js** createOne(Order):

- **dealerOrder: true** (bulk): slot subtract + **add** quota to wallet (dealer “buys” capacity).
- **Salesperson is DEALER** (or order has dealer + company quota not selected):
  - If **componyQuota === false** (dealer quota): **validateDealerQuota** → **allocateDealerQuota** → order gets quotaSource “dealer”, quotaUsed/originalQuotaAllocation; **no** slot subtract (unless allocation has fromSlot).
  - If **componyQuota === true** (company quota): **handleQuantityAllocation** → may **updateSlot** for fromSlot part; order can have dealer set.

So **dealer quota minus** = allocateDealerQuota increments **bookedQuantity** (and decrements **remainingQuantity**) for the matching wallet entry. **Company quota minus** = **updateSlot(..., "subtract")** on the slot.

**Dealer bulk (`dealerOrder: true`)** increases **sellable** stock only: **`quantity`** (and thus available `quantity - bookedQuantity`). It does **not** increment **`bookedQuantity`**; that field tracks **farmer** orders drawn from the dealer’s quota. Cancelling or rejecting a bulk order removes **`quantity`** for that line; re-opening from cancelled/rejected restores **`quantity`** (not `bookedQuantity`). Status updates that adjust farmer quota (e.g. release on cancel) keep using **`bookedQuantity`** for non-bulk dealer-quota orders.

### 7.3 Quota validation and allocation – `quota.controller.js`

- **Farmer-order** dealer quota checks (**validateDealerQuota** / **allocateDealerQuota**) use **order-derived** sums (`bulkFromOrders` + `farmerBookedFromOrders` from orders), consistent with the dealer wallet API overlay and **reconcile-wallet** (`dealerWalletReconcile.js`). Availability is **not** inferred only from stored `quantity − bookedQuantity` when that row was legacy-inconsistent.
- **validateDealerQuota(...):** uses `getDealerQuotaLineAvailability` → compares derived **availableForFarmerOrders** to `requestedQuantity`.
- **allocateDealerQuota(...):** same derived baseline; writes **`$set`** `quantity` / `bookedQuantity` / `remainingQuantity` for the line so stored state matches reconcile + this booking (instead of blind `$inc` on a corrupted baseline).

### 7.4 Reconciliation and historical fixes

- **GET `/api/v1/user/wallet-details/:dealerId?reconcile=1`** — response **plantDetails** slot rows include optional **`reconcile`**: `bulkFromOrders` and `farmerBookedFromOrders` (from Order aggregates), `derivedRemainingHint`, and **`inconsistent`** when stored lines disagree with order-derived sums. Uses a single aggregation (no N+1).
- **POST `/api/v1/user/dealers/:dealerId/reconcile-wallet`** — **SUPER_ADMIN** only. Body: `{ "dryRun": true }` (default) returns proposed per-line diffs; `{ "dryRun": false }` applies corrections. Implementation: `utils/dealerWalletReconcile.js`, `walletController.js`.
- **Offline:** `node scripts/reconcile-dealer-bulk-wallet.js` with `DRY_RUN=1` (default) to print proposed changes; `DRY_RUN=0` to apply. Optional `DEALER_ID=<mongoId>` scopes to one dealer.

---

## 8. Payment Capturing (Farmer & Dealer)

### 8.1 Where payments are stored

- **Order model** (`order.model.js`): **payment[]** – each element has paidAmount, paymentStatus (COLLECTED/REJECTED/PENDING), paymentDate, bankName, receiptPhoto, modeOfPayment, isWalletPayment, etc.
- Order has **orderPaymentStatus** (PENDING/COMPLETED) and **paymentCompleted**; these are derived in pre-save from sum of COLLECTED payments vs order total.

### 8.2 Adding a payment – order route

- **PATCH `/api/v1/order/payment/:orderId`**  
  Body: paidAmount, paymentStatus, paymentDate, bankName, receiptPhoto, modeOfPayment, isWalletPayment.  
  Optional file: single screenshot (uploaded to Cloudinary).  
  Controller: **addNewPayment** in `order.controller.js`.

Behaviour:

- Append new payment to `order.payment` (default status PENDING for OFFICE_ADMIN; else can be COLLECTED/PENDING).
- If order has a **dealer** (or salesPerson is DEALER):
  - **Wallet payment** (isWalletPayment and PENDING/COLLECTED): **DealerWallet.addPayment(dealerId, -amount, ...)** → deduct from dealer’s wallet balance.
  - **Dealer order, non-wallet, COLLECTED**: **DealerWallet.addPayment(dealerId, +amount, ...)** → add to dealer’s wallet (payment collected from dealer).
- Save order (pre-save recalculates orderPaymentStatus/paymentCompleted).

So **farmer payment** = just stored on order; **dealer-related** payments also update **DealerWallet** balance (and optionally transactions).

### 8.3 Dealer route payment

- **POST `/api/v1/dealer/orders/:orderId/payment`**  
  Controller: **updateDealerOrderPayment** in `dealer.controller.js` – adds payment to that order and updates **DealerBooking** summary (totalOrderPayments, paymentRemaining). Used when viewing dealer’s booking and adding payment there.

So: **Payment capturing** for orders is done mainly via **order** route; dealer route gives an alternative for dealer’s own view and booking summary.

---

## 9. Delivery and Dispatch

### 9.1 Order statuses (order.model.js)

- PENDING, PROCESSING, COMPLETED, CANCELLED  
- DISPATCHED, ACCEPTED, REJECTED  
- FARM_READY, READY_FOR_DISPATCH, DISPATCH_PROCESS  
- PARTIALLY_COMPLETED, TEMPORARY_CANCELLED  

Delivery-related:

- **deliveryDate** – chosen delivery date (from slot/order date).
- **farmReadyDate** – when plants are ready at farm.
- **dispatchHistory[]** – per dispatch: date, quantity, dispatchId, remainingAfterDispatch, processedBy, driverName, vehicleName.
- **currentDispatchId** – latest dispatch.

### 9.2 Order route – dispatch endpoints

- **GET `/api/v1/order/to-be-dispatched`**  
  Query: startDate, endDate.  
  Returns orders whose **deliveryDate** is in that range and status allows dispatch (e.g. READY_FOR_DISPATCH, ACCEPTED, etc. as per controller logic).

- **GET `/api/v1/order/dispatch-details/:orderId`**  
  Full order with dispatch details (e.g. dispatchHistory, driver, vehicle).

- **GET `/api/v1/order/by-dispatch/:transportId`**  
  Orders that are part of a given dispatch (transport).

- **GET `/api/v1/order/dispatch-summary`**  
  Summary of dispatches.

- **PATCH `/api/v1/order/afterOrder`**  
  Body: dispatchId, orderIds. Appends orderIds to **Dispatch.afterDispatchedOrderIds** (post-dispatch linking).

So **delivery** is driven by **deliveryDate** and **order status**; **dispatch** is grouping orders into trips (Dispatch model) and recording in **dispatchHistory** and **afterDispatchedOrderIds**.

---

## 10. End-to-End Flow Summary

### 10.1 Farmer order (normal, from AddOrderForm)

1. User fills AddOrderForm → chooses farmer (or new), plant, subtype, order date (slot), sales person, payment if any.
2. Frontend calls **POST `/api/v1/farmer/createFarmer`** with farmer + order payload (no dealerOrder, or dealer + company quota).
3. **Farmer route**: createFarmer → sets `req.body.farmer` → **createOrder** (factory createOne(Order)).
4. **createOne(Order):**  
   - Validates salesPerson, bookingSlot, numberOfPlants.  
   - **Company quota (or no dealer):** `updateSlot(bookingSlot, numberOfPlants, "subtract")` → slot **availablePlants** minus.  
   - **Dealer + dealer quota:** validateDealerQuota → allocateDealerQuota → **dealer wallet entry** minus (bookedQuantity up); no slot subtract.  
   - Creates **Order** with farmer, bookingSlot, payment[], status (e.g. ACCEPTED), deliveryDate, etc.
5. Later: **PATCH `/api/v1/order/payment/:orderId`** to add/capture payment (and update dealer wallet if dealer order).

### 10.2 Dealer bulk order (dealer’s own stock)

1. User selects Bulk, dealer, plant, slot, quantity, etc. → **POST `/api/v1/order/dealer-order`**.
2. **createDealerOrder** = createOne(Order) with **dealerOrder: true**, **dealer**.
3. **createOne(Order):**  
   - `updateSlot(bookingSlot, numberOfPlants, "subtract")` → slot minus.  
   - DealerWallet: find or create entry for plant/subtype/slot, **quantity += numberOfPlants** (quota added).  
   - Save Order (dealerOrder, dealer, no farmer).
4. Payment for that order can be added via order or dealer payment endpoint; COLLECTED non-wallet payment **adds** to dealer wallet balance.

### 10.3 Dealer order for farmer (company vs dealer quota)

1. Normal order path (createFarmer or dealer-order with dealerOrder false), with **dealer** and **componyQuota** set.
2. **Company quota:** handleQuantityAllocation → updateSlot for fromSlot → slot minus.  
3. **Dealer quota:** allocateDealerQuota only → dealer wallet entry minus, no slot subtract.

### 10.4 Delivery

1. Orders get **deliveryDate** and status (e.g. READY_FOR_DISPATCH).
2. **GET `/api/v1/order/to-be-dispatched`** with date range returns orders to dispatch.
3. Dispatches are created/updated (separate flow); **dispatchHistory** and **afterDispatchedOrderIds** link orders to dispatches.
4. Status can move to DISPATCHED, etc., as per your business flow.

---

## 11. File Reference

| Area | File(s) |
|------|--------|
| Frontend order form | nursery-mgmt/src/pages/private/order/AddOrderForm.jsx |
| API endpoints config | nursery-mgmt/src/network/config/endpoints.js |
| Order routes | FINAL_NURSERY_BE/routes/order.route.js |
| Farmer routes | FINAL_NURSERY_BE/routes/farmer.route.js |
| Dealer routes | FINAL_NURSERY_BE/routes/dealer.route.js |
| Inventory routes | FINAL_NURSERY_BE/routes/inventory.route.js |
| Slots routes | FINAL_NURSERY_BE/routes/slots.route.js |
| Order model | FINAL_NURSERY_BE/models/order.model.js |
| Slots model | FINAL_NURSERY_BE/models/slots.model.js |
| Dealer wallet model | FINAL_NURSERY_BE/models/dealerWallet.js |
| Order creation & slot update | FINAL_NURSERY_BE/controllers/factory.controller.js |
| Order controller (payments, list, dispatch) | FINAL_NURSERY_BE/controllers/order.controller.js |
| Dealer controller | FINAL_NURSERY_BE/controllers/dealer.controller.js |
| Quota validation & allocation | FINAL_NURSERY_BE/controllers/quota.controller.js |
| Farmer controller | FINAL_NURSERY_BE/controllers/farmer.controller.js |
| App route mounting | FINAL_NURSERY_BE/app.js |

---

## 12. Quick Connection Diagram

```
AddOrderForm.jsx
  ├─ Normal order  → POST /api/v1/farmer/createFarmer  → farmer.route → createFarmer → createOrder (factory)
  └─ Bulk order    → POST /api/v1/order/dealer-order   → order.route  → createDealerOrder (= createOne Order)

createOne(Order) in factory.controller.js
  ├─ dealerOrder?     → updateSlot(subtract) + DealerWallet.entries.quantity += plants
  ├─ dealer + company → updateSlot(subtract) [from handleQuantityAllocation]
  ├─ dealer + dealer  → allocateDealerQuota only (DealerWallet entry bookedQuantity += plants)
  └─ else (farmer)    → updateSlot(subtract)

Payment
  ├─ PATCH /api/v1/order/payment/:orderId     → addNewPayment (order + optional DealerWallet balance)
  └─ POST  /api/v1/dealer/orders/:id/payment  → updateDealerOrderPayment (order + DealerBooking summary)

Delivery
  └─ GET /api/v1/order/to-be-dispatched, dispatch-details, by-dispatch, dispatch-summary, afterOrder
```

This should give you a single place to see how orders, slots, dealer quota, payment, and delivery are connected end to end.
