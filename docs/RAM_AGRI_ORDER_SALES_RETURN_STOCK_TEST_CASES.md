# Ram Agri Input — Order to Sales Return to Stock  
## Test cases (plain language)

These are the things a real person should try. For each one: **do this → expect that**.

---

## Before you start

Make sure you have:

1. **Stock in Ram Agri** — at least one crop/variety with quantity in inventory (from purchase / Auto GRN is fine). Note the stock number.
2. **Three logins** (or switch users):
   - **Office / Admin** (who can dispatch and approve returns) — e.g. Super Admin, Office Admin, or Ram Agri Sales Office Manager  
   - **Dealer** (who places dealer order and asks for return)  
   - **Field sales** (Ram Agri Sales person — for comparison: their path should **not** put stock back into warehouse the same way)

Tip: Write down **stock before** every important step, then check again after.

Also prepare:

4. **Ram Agri Inputs Master** — at least one crop + variety (seed or chemical) ready to buy.  
5. **Biotech Seed Master** — at least one plant + variety ready to buy (biotech product linked to inventory).  
6. A **supplier / merchant** you can pick on the purchase order.  
7. Login that can **Auto GRN** on purchase: Super Admin, Ram Agri Master, or Ram Agri Sales Manager (tick “Auto GRN”, invoice number + invoice file required).

---

## Part 0 — Purchase order (bring stock in)

This is how stock enters the warehouse before you sell.

### 0A. Ram Agri Inputs Master — purchase that increases stock

### P1. Create PO for an Inputs Master variety (Auto GRN on)  
**Who:** Super Admin / Ram Agri Master / Ram Agri Sales Manager  
**Do:**  
1. Open Ram Agri workspace → Inventory → Purchase orders → Create.  
2. Pick supplier.  
3. Add line from **Ram Agri Inputs Master** (choose crop + variety, qty, rate).  
4. Keep **Auto GRN** on. Enter invoice number and upload invoice file.  
5. Save.  
**Expect:**  
- PO is created and approved / stocked automatically (Auto GRN).  
- That variety’s **stock goes up** by the qty you bought.  
- You can see the new quantity on Inputs Master / inventory for that variety.

### P2. Same PO but forget invoice when Auto GRN is on  
**Do:** Auto GRN on, save without invoice number or file.  
**Expect:** System stops you — invoice number and file are required when Auto GRN is on.

### P3. Purchase seed then chemical  
**Do:** One PO (or two) — buy a **seed** variety and a **chemical** variety from Inputs Master.  
**Expect:** Each variety stock increases by its own qty.

### P4. Someone without Auto GRN rights creates PO  
**Who:** User who is not Super Admin / Master / Sales Manager  
**Do:** Create PO for Inputs Master product.  
**Expect:** PO stays pending (needs office approve / GRN later). Stock does **not** jump up immediately unless someone approves / GRNs it.

### P5. After PO AutogrN, check stock on Inputs Master screen  
**Do:** Open Inputs Master for that crop/variety.  
**Expect:** Current stock matches what you purchased (plus any stock you already had).

---

### 0B. Biotech Seed Master — purchase that increases stock

### P6. Create PO for a Biotech Seed Master product (Auto GRN on)  
**Who:** Super Admin (or role that can Auto GRN; often Super Admin on biotech inventory)  
**Do:**  
1. Switch to / use Biotech (or full) inventory — **not** only agri crop picker.  
2. Purchase orders → Create.  
3. Add product that comes from **Biotech Seed Master** (plant / variety that exists in inventory products).  
4. Auto GRN on + invoice number + file. Save.  
**Expect:**  
- PO auto-stocks.  
- That biotech / inventory product **stock goes up**.  
- Biotech Seed Master / product list reflects higher stock if linked.

### P7. Open Biotech Seed Master after purchase  
**Do:** Inventory → Biotech Seed Master, find that plant/variety.  
**Expect:** Stock (or linked product stock) shows the new purchased quantity — not stuck at old number.

### P8. Two batches / two POs for same biotech product  
**Do:** Buy the same biotech product twice (two invoice days or two POs).  
**Expect:** Stock is sum of both purchases. Later sales should use stock correctly.

### P9. Buy biotech product without Auto GRN  
**Do:** Turn Auto GRN off (or user without auto rights). Save PO.  
**Expect:** PO pending. Stock unchanged until someone approves and creates GRN.

---

### 0C. Purchase → sell → return (full money+stock day)

### Story P — Inputs Master buy, then sell, then return  
1. Note Inputs Master variety stock = **0** (or write current number).  
2. **PO Auto GRN** buy **50** → stock **50** (or +50).  
3. Office creates sales order for **10**, dispatches → stock **40**.  
4. Dealer asks return **10** → stock still **40**.  
5. Office approves return → stock **50** again.  
**Pass if:** After return approve, stock matches post-purchase (before sale).

### Story Q — Biotech Master buy, then use / check stock  
1. Note biotech product stock.  
2. **PO Auto GRN** buy **20**. Stock **+20**.  
3. Confirm on Biotech Seed Master / product screen.  
4. (If that product is also sold via Ram Agri / linked flow) sell and return same as Story P — stock must end consistent.  
**Pass if:** Purchase always adds; sales (office path) subtract; approved return adds back.

### Story R — Wrong master mix-up  
1. In **agri** purchase form, you should pick **Inputs Master** crops/varieties (seed/chemical), not random biotech-only SKUs.  
2. In **biotech** purchase form, you pick **inventory / Biotech Master** products.  
**Expect:** Lines match the master you are buying for; stock increases on the correct master/product.

---

## Part A — Creating an order (stock should not move yet)

### A1. Create a normal Ram Agri order  
**Who:** Sales or office  
**Do:** Open Ram Agri orders, create an order for a farmer/customer with crop, variety, quantity, rate, and **send date**. Save.  
**Expect:** Order is accepted/created successfully. Inventory stock number is **the same** as before. Nothing deducted yet.

### A2. Create an order with two products on one bill  
**Do:** Add two different varieties on the same order.  
**Expect:** Both lines show correctly. Total amount is sum of both. Stock still **unchanged**.

### A3. Try to create without send date  
**Do:** Leave send/delivery date empty for a Ram Agri product.  
**Expect:** System stops you with a clear message that send date is required.

### A4. Dealer creates their own order  
**Who:** Dealer login  
**Do:** Place a dealer self-order.  
**Expect:** Order saves as dealer order. Stock still unchanged.

### A5. Sales Manager tries to “collect / accept payment” as collected  
**Who:** RAM Agri Sales Manager  
**Do:** Try to mark payment as collected (accept payment).  
**Expect:** Not allowed. Collecting payment is for Accountant / Ram Agri Master / Super Admin only. (They can still create orders and run inventory.)

---

## Part B — Sending / dispatching the order (this is when warehouse stock goes down)

### B1. Office dispatches an order that is **not** assigned to a sales person  
**Who:** Office / Admin  
**Do:** Note stock of that variety. Dispatch the order fully.  
**Expect:**  
- Order shows as dispatched.  
- Stock **goes down** by the quantity sold.  
- If you had two batches (old expiry and later expiry), stock should come first from the batch that expires sooner.

### B2. Not enough stock in warehouse  
**Do:** Try to dispatch more quantity than available stock.  
**Expect:** Dispatch fails. Stock numbers stay as they were (no half deduction).

### B3. Order is assigned to a field sales person, then they dispatch  
**Who:** Field Ram Agri Sales  
**Do:** Assign order to sales → they mark dispatched. Check warehouse stock.  
**Expect:** Order can show dispatched for delivery tracking, but **warehouse stock should not go down** the same way as office dispatch. (Field path is not pulling from Ram Agri batch stock like office dispatch.)

### B4. Two varieties on one order — office dispatch  
**Do:** Dispatch a two-line order from office.  
**Expect:** Each variety’s stock reduces by its own quantity.

---

## Part C — Dealer asks for a sales return (stock still should not change)

### C1. Happy ask for return  
**Who:** Same dealer who owns the dispatched order  
**Do:** After dispatch, open return and ask to return some or all quantity (pick batches if the app asks). Submit.  
**Expect:** Request goes to **Pending**. Warehouse stock is **still the low (after-sale) number** — return is not in stock until office accepts it.

### C2. Sales / Sales Manager tries to submit dealer return request  
**Do:** Login as non-dealer and try the dealer return-request action.  
**Expect:** Blocked. Only dealer can ask for this type of return.

### C3. Return more than was delivered  
**Do:** Ask to return 10 when only 5 were delivered (or already returned some).  
**Expect:** Error — cannot return more than remaining returnable quantity.

### C4. Second pending return while one is waiting  
**Do:** Submit one pending return, then try another for the same order.  
**Expect:** System says a pending return already exists. Finish or reject the first one first.

### C5. Order not yet dispatched  
**Do:** Try return on an order that was never dispatched.  
**Expect:** Not allowed.

---

## Part D — Office accepts the return (stock should come back)

### D1. Accept full return  
**Who:** Office (Pending returns screen in nursery-mgmt)  
**Do:** Note stock. Approve the dealer’s pending return for full quantity.  
**Expect:**  
- Request becomes Approved.  
- Warehouse stock **goes up** by the returned quantity (back toward what you had before sale).  
- Customer balance / ledger shows a sales return credit.  
- Order shows returned quantity.

### D2. Accept partial return  
**Do:** Approve return of only part of the qty (e.g. sold 10, return 4).  
**Expect:** Stock increases by 4. Later you can still return the other 6. You cannot return more than 6 after that.

### D3. Accept return to specific batches  
**Do:** If the return named which batch goods came back to, approve.  
**Expect:** Those batch quantities go up; other batches don’t jump unexpectedly.

### D4. Two products returned and approved  
**Do:** Approve a return that covers both lines.  
**Expect:** Both varieties’ stock increase correctly.

### D5. Approve the same request twice  
**Do:** Approve once, try again.  
**Expect:** Second time fails — already handled. Stock must not increase twice.

---

## Part E — Office rejects the return (stock stays as after-sale)

### E1. Reject pending return  
**Do:** Reject a pending dealer return.  
**Expect:** Request Rejected. Stock stays at the **sold (reduced)** level. Order does not get return credit.

### E2. After reject, dealer asks again and office accepts  
**Do:** Reject → dealer submits new return → office approves.  
**Expect:** Only after approve does stock go up.

---

## Part F — Other “returns” that people confuse with stock return

### F1. Sales person sales-return on the order (not dealer approval flow)  
**Who:** Field sales on their assigned / self-dispatched order  
**Do:** Use the sales return action on the order (if available).  
**Expect:** Bill / money side may change. **Warehouse batch stock should not increase** like an office-approved dealer return.

### F2. Complete delivery with returns — office sold from warehouse  
**Do:** On an office-dispatched (not assigned) order, complete delivery and enter returned qty.  
**Expect:** Stock should come back into warehouse.

### F3. Complete delivery with returns — field sales path  
**Do:** Same complete-with-return on an assigned / sales-dispatched order.  
**Expect:** Delivery completes, but **warehouse stock does not** get the return the same way.

---

## Part G — Cancelling after office already took stock

### G1. Cancel / undo after office dispatch took stock  
**Do:** After office dispatch reduced stock, cancel or reject the order in a way that restores inventory (if your process allows).  
**Expect:** Stock goes back up (goods not considered sold anymore).

---

## Part H — Full stories (walk through like a real day)

### Story 1 — Clean day (must pass)  
1. Note stock of Variety X = **100**.  
2. Office creates order for **10**, then dispatches. Stock = **90**.  
3. Dealer requests return of **10**. Stock still **90**.  
4. Office approves. Stock = **100** again.  
**Pass if:** End stock matches start.

### Story 2 — Partial return  
1. Sell/dispatch **10** (100 → 90).  
2. Return **4**, approve (90 → 94).  
3. Return **6**, approve (94 → 100).  
4. Try return **1** more → should fail.

### Story 3 — Field sales day (warehouse should stay still)  
1. Note stock.  
2. Assign to sales → they dispatch → they complete/return on their flow.  
3. Stock number should stay where it was after create (no office warehouse pullback/push unless your policy says otherwise — today warehouse is for office path).

### Story 4 — Wrong person  
1. Dealer return pending.  
2. Random sales user cannot invent an approve if UI hides it; if API is tried without permission, don’t allow stock chaos. Prefer office does approve/reject.

### Story 5 — Stock from purchase, then sell, then return  
1. Create purchase with Auto GRN for **Inputs Master** variety (Sales Manager / Master / Super Admin) → stock up.  
2. Sell via office dispatch → stock down.  
3. Dealer return approved → stock back to after-purchase level (minus anything else moved).  
Same idea for **Biotech Seed Master** product: purchase first, then confirm stock on that master.

---

## Part I — Multi-link seed masters + sowing issue inventory choice

Use plain office language. Goal: same plant+subtype can have **several Biotech products** and **several Ram Agri Input varieties**, and on **Issue** the office picks where packets come from.

### I1. Link more than one Biotech + more than one Input to one subtype  
**Do:** Open Subtype → Seed Links. Pick one plant subtype. Add two different Biotech seed products, then add two different Ram Agri Input varieties (Add / manage links).  
**Expect:** The row lists **all** of them (not only the first). Trash removes one link without wiping the others.

### I2. Issue from Biotech warehouse only  
**Do:** Make a pending sowing request with company packets (e.g. 10). Note Biotech and Ram Agri stocks. Open Issue → choose **Biotech warehouse** → allocate batches → Issue.  
**Expect:** Only Biotech warehouse stock drops by 10. Ram Agri Input stock unchanged.

### I3. Issue from Ram Agri Input only  
**Do:** Same setup. Issue → choose **Ram Agri Input** → Issue (no Biotech batch allocate).  
**Expect:** Only Ram Agri variety stock drops by company qty. Biotech warehouse unchanged.

### I4. Issue Both with a valid split (e.g. 6 + 4 for 10)  
**Do:** Company packets = 10. Choose **Both**. Enter Biotech **6** and Input **4**. Allocate Biotech batches for 6. Issue.  
**Expect:** Biotech down by 6, Ram Agri down by 4. Issue button disabled / API rejects if you try **5 + 4** (doesn’t add to 10).

### I5. No mystery auto transfer on create  
**Do:** Create a sowing request where company packets are **more** than current Biotech stock, while Ram Agri still has stock for the linked variety.  
**Expect:** Request creates as pending **without** an automatic Ram Agri → Biotech purchase/transfer inventing stock. Pool choice happens later on Issue (I2–I4).

### I6. Quick checklist (multi-link / issue pools)

- [ ] Two Biotech + two Agri links show on dual-links page  
- [ ] Remove one link leaves the rest  
- [ ] Issue Biotech only → Agri stock same  
- [ ] Issue Input only → Biotech stock same  
- [ ] Issue Both 6+4 → both pools drop; 5+4 blocked  
- [ ] Create with Biotech shortfall → no auto transfer PO  

---

## What “good” looks like in one sentence

**Purchase (Auto GRN) puts stock into Inputs Master or Biotech Master. Office dispatch lowers Ram Agri warehouse stock. Dealer return request alone does not. Only office approve (or office complete-with-return on that office path) puts stock back. Field sales returns are about the bill, not filling the warehouse.**

---

## Quick checklist for testers (tick as you go)

- [ ] Inputs Master PO + Auto GRN — stock up  
- [ ] Biotech Seed Master PO + Auto GRN — stock up  
- [ ] Auto GRN without invoice — blocked  
- [ ] PO without Auto GRN rights — stock not instant  
- [ ] Create sales order — stock same  
- [ ] Office dispatch — stock down  
- [ ] Too much qty on dispatch — blocked, stock same  
- [ ] Dealer return request — pending, stock still down  
- [ ] Non-dealer return request — blocked  
- [ ] Approve return — stock up  
- [ ] Reject return — stock stays down  
- [ ] Partial return — stock up by partial only  
- [ ] Full return — stock back to before sale (after purchase)  
- [ ] Cannot return more than sold  
- [ ] Sales Manager cannot collect payment  
- [ ] Field sales path does not silently refill warehouse  
- [ ] Multi-link: two Biotech + two Agri on one subtype  
- [ ] Sowing issue Biotech only / Input only / Both split  
- [ ] No auto Ram Agri→Biotech transfer on sowing create shortfall  

---

## Where to click (web)

| Action | Rough place |
|--------|-------------|
| Purchase order (Inputs Master) | Ram Agri workspace → Inventory → Purchase orders → add Ram Agri crop/variety |
| Purchase order (Biotech Master) | Inventory (biotech / full) → Purchase orders → pick biotech / inventory product |
| Inputs Master | Inventory / hub → Inputs master |
| Biotech Seed Master | Inventory / hub → Biotech seed master |
| Subtype → Seed Links | Inventory → Subtype seed / dual links |
| Issue sowing stock (Biotech / Input / Both) | Inventory / Sowing requests → Issue |
| Inventory / stock | Inventory (Ram Agri workspace) |
| Pending dealer returns | Ram Agri orders area → Pending returns |

Dealer often submits the return request from the **mobile / expo** agri orders flow.
