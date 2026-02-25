# Fix Payment Amount Rounding Issue - DeepSeek Prompt

## Problem Statement

The frontend checkout pages are rounding amounts to whole numbers (e.g., ₱5,500.50 becomes ₱5,501), but the exact decimal amounts should be passed to the backend and processed accurately WITHOUT rounding.

## Verified PayMongo Requirements

From [PayMongo's official documentation](https://developers.paymongo.com/docs/pass-on-fee):

> **"Amount Values: All amounts should be in centavos (PHP multiplied by 100)."**

**Examples from PayMongo API:**
```json
"amount": 300000    // ₱3,000.00 (item)
"amount": 12435     // ₱124.35 (pass on fee)
"amount": 312435    // ₱3,124.35 (total with fee)
```

## Correct Approach

### Key Principle
1. Keep exact decimal amounts throughout the flow
2. Convert to centavos ONLY at the final PayMongo API call
3. Use `Math.floor(amount * 100)` for final conversion (not Math.round)

**Correct flow:**
```
Frontend displays: ₱5,500.50 (exact)
Backend receives: 5500.50
Backend keeps: 5500.50 (no rounding)
PayMongo gets: Math.floor(5500.50 * 100) = 550050 centavos = ₱5,500.50
Customer charged: ₱5,500.50 (EXACT)
```

## Current Behavior (INCORRECT)

### Frontend (All 6 checkout pages)
- **Customization Plan**: Uses `maximumFractionDigits: 0` → rounds to whole number
- **Freelancer Plan**: Uses `maximumFractionDigits: 0` → rounds to whole number
- **Dedicated Coaching**: Uses `maximumFractionDigits: 0` → rounds to whole number
- **Startup VA Course**: Uses `maximumFractionDigits: 0` → rounds to whole number
- **Client Finder Tool**: Uses `.toFixed(0)` → rounds to whole number
- **GHL Practice Access**: Uses `.toFixed(0)` → rounds to whole number

**Example**: ₱5,500.50 displays as ₱5,501 (rounded up)

### Backend (paymentController.js lines 75, 80)
```javascript
finalAmount = Math.round(amount);        // ❌ WRONG - rounds up!
baseAmount = Math.round(finalAmount / (1 + taxRate));  // ❌ WRONG - rounds again!
```

### Backend (paymongoService.js lines 32, 42, 68)
```javascript
amount: Math.round(Math.round(amount * 100)),  // ❌ DOUBLE rounding - WRONG!
amount: Math.round(amount * 100),                // ❌ ROUNDS centavos
```

### The Overcharging Bug
```
Frontend displays: ₱5,501 (rounded from ₱5,500.50)
Backend receives: 5500.50
Backend does: Math.round(5500.50) = 5501
PayMongo gets: 5501 * 100 = 550100 centavos = ₱5,501.00
Customer charged: ₱5,501 (OVERCHARGED by ₱0.50!)
```

## Required Fixes

### 1. Frontend Changes (All 6 HTML files)

**Change from:**
```javascript
// For pages using toLocaleString (customization, freelancer, etc.)
totalAmountEl.textContent = `₱${FINAL_AMOUNT.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0})}`;
btnAmountEl.textContent = FINAL_AMOUNT.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0});

// For pages using toFixed (clientfinder, ghlpractice)
totalAmountEl.textContent = `₱${FINAL_AMOUNT.toFixed(0)}`;
btnAmountEl.textContent = FINAL_AMOUNT.toFixed(0);
```

**Change to:**
```javascript
// Display with exactly 2 decimal places
totalAmountEl.textContent = `₱${FINAL_AMOUNT.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
btnAmountEl.textContent = FINAL_AMOUNT.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
finalTotalEl.textContent = `₱${FINAL_AMOUNT.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
```

**Files to update:**
1. `customizationplan-withpaymongo.html` - Line ~1160-1162 in updatePriceDisplay()
2. `freelancerplan-withpaymongo.html` - Find updatePriceDisplay function
3. `dedicatedcoaching-withpaymongo.html` - Find updatePriceDisplay function
4. `startupvacoursepayment-paymongo.html` - Find updatePriceDisplay function
5. `clientfindertool-withpaymongo.html` - Lines ~1002-1004 in updatePriceDisplay()
6. `ghlpracticeaccess-withpaymongo.html` - Lines ~807-809 in updatePriceDisplay()

### 2. Backend Changes

#### File: `paymongo-backend/controllers/paymentController.js`

**Change from (lines 73-81):**
```javascript
if (amount && amount > 0 && amount !== productInfo.amount) {
    // Frontend provided a discounted amount - use it
    finalAmount = Math.round(amount);        // ❌ WRONG - rounds up!
    baseAmount = Math.round(finalAmount / (1 + taxRate));  // ❌ WRONG - rounds again!
    taxAmount = finalAmount - baseAmount;
}
```

**Change to:**
```javascript
if (amount && amount > 0 && amount !== productInfo.amount) {
    // Frontend provided a discounted amount - use it
    finalAmount = Number(Number(amount).toFixed(2));  // ✅ Keep 2 decimals, no rounding
    baseAmount = Number((finalAmount / (1 + taxRate)).toFixed(2));  // ✅ 2 decimals
    taxAmount = Number((finalAmount - baseAmount).toFixed(2));  // ✅ 2 decimals
}
```

**Also change default case (lines 90-96):**
```javascript
} else {
    // Use product mapping (no discount)
    const taxed = calculateTaxedAmount(productInfo.amount, taxRate);
    finalAmount = Number(taxed.totalAmount.toFixed(2));   // ✅ Ensure 2 decimals
    baseAmount = Number(taxed.baseAmount.toFixed(2));     // ✅ Ensure 2 decimals
    taxAmount = Number(taxed.taxAmount.toFixed(2));       // ✅ Ensure 2 decimals
}
```

#### File: `paymongo-backend/services/paymongoService.js`

**Change from (lines 31-35, 41-43, 67-69):**
```javascript
// Line 31-35
console.log('1. Creating payment intent with:', {
    amount: Math.round(Math.round(amount * 100)),  // ❌ DOUBLE rounding
    ...
});

// Line 41-43
attributes: {
    amount: Math.round(Math.round(amount * 100)),  // ❌ DOUBLE rounding
    ...
}

// Line 67-69 (checkout session line_items)
line_items: [{
    amount: Math.round(amount * 100),  // ❌ ROUNDS up
    ...
}]
```

**Change to:**
```javascript
// Line 31-35
console.log('1. Creating payment intent with:', {
    amount: Math.floor(amount * 100),  // ✅ Use floor to avoid overcharging
    ...
});

// Line 41-43
attributes: {
    amount: Math.floor(amount * 100),  // ✅ Floor - never overcharge
    ...
}

// Line 67-69 (checkout session line_items)
line_items: [{
    amount: Math.floor(amount * 100),  // ✅ Floor - never overcharge
    ...
}]
```

**Also fix refund method (lines 249-250):**
```javascript
// Change from:
amount: Math.round(amount * 100),  // ❌ May round up

// To:
amount: Math.floor(amount * 100),   // ✅ Consistent with charge
```

#### File: `paymongo-backend/utils/helpers.js`

**Change from (lines 44-60):**
```javascript
function calculateTaxedAmount(amount, taxRate = 0.10) {
    const rate = Number(taxRate);
    const safeRate = Number.isFinite(rate) ? rate : 0;
    const baseCentavos = Math.round(Number(amount) * 100);      // ❌ Rounds
    const taxCentavos = Math.round(baseCentavos * safeRate);    // ❌ Rounds
    const totalCentavos = baseCentavos + taxCentavos;

    return {
        baseAmount: baseCentavos / 100,
        taxAmount: taxCentavos / 100,
        totalAmount: totalCentavos / 100,
        baseCentavos,
        taxCentavos,
        totalCentavos,
        taxRate: safeRate
    };
}
```

**Change to:**
```javascript
function calculateTaxedAmount(amount, taxRate = 0.10) {
    const rate = Number(taxRate);
    const safeRate = Number.isFinite(rate) ? rate : 0;
    
    // Keep decimal precision until final centavo conversion
    const baseAmount = Number(Number(amount).toFixed(2));
    const taxAmount = Number((baseAmount * safeRate).toFixed(2));
    const totalAmount = Number((baseAmount + taxAmount).toFixed(2));
    
    // Convert to centavos at final step using floor
    const baseCentavos = Math.floor(baseAmount * 100);
    const taxCentavos = Math.floor(taxAmount * 100);
    const totalCentavos = baseCentavos + taxCentavos;

    return {
        baseAmount,
        taxAmount,
        totalAmount,
        baseCentavos,
        taxCentavos,
        totalCentavos,
        taxRate: safeRate
    };
}
```

## Verification Checklist

After making changes, verify:

1. [ ] All 6 frontend pages display amounts with exactly 2 decimal places (₱5,500.50)
2. [ ] Frontend passes exact decimal amounts to backend API (amount: 5500.50)
3. [ ] Backend stores and processes exact decimal amounts (no Math.round on amount)
4. [ ] PayMongo receives correct centavo amount (Math.floor(amount * 100))
5. [ ] Customer is charged the exact displayed amount (no overcharging)
6. [ ] Test with specific amounts:
   - ₱5,500.50 → displays ₱5,500.50 → charged ₱5,500.50
   - ₱3,500.99 → displays ₱3,500.99 → charged ₱3,500.99
   - ₱999.01 → displays ₱999.01 → charged ₱999.01

## Test Cases

| Input | Current (WRONG) | Expected (CORRECT) | Centavos to PayMongo |
|-------|-----------------|-------------------|----------------------|
| ₱5,500.50 | Displays ₱5,501, charged ₱5,501 | Display ₱5,500.50, charge ₱5,500.50 | 550050 |
| ₱3,500.99 | Displays ₱3,501, charged ₱3,501 | Display ₱3,500.99, charge ₱3,500.99 | 350099 |
| ₱999.01 | Displays ₱999, charged ₱999 | Display ₱999.01, charge ₱999.01 | 99901 |
| ₱550.50 | Displays ₱551, charged ₱551 | Display ₱550.50, charge ₱550.50 | 55050 |

## Critical Implementation Notes

1. **PayMongo API requires centavos** (integer). Always convert: `Math.floor(amount * 100)`
2. **Never use Math.round()** on amount before centavo conversion — it rounds 0.5 UP
3. **Use Math.floor()** for final centavo conversion — prevents overcharging
4. **Use .toFixed(2)** for display purposes and decimal precision
5. **Use Number() wrapper** when converting from toFixed to avoid string types
6. **Test edge cases**: amounts ending in .50, .99, .01

## Why Math.floor vs Math.round?

| Method | ₱5,500.50 | ₱5,500.99 | Result |
|--------|-----------|-----------|--------|
| Math.round() | 550100 centavos | 550199 centavos | May overcharge |
| Math.floor() | 550050 centavos | 550099 centavos | Exact or slightly under |

Using `Math.floor()` ensures the customer is **never overcharged**. Being slightly under by less than 1 centavo is acceptable; overcharging is not.

## Summary of Changes

| File | Lines | Change |
|------|-------|--------|
| `customizationplan-withpaymongo.html` | ~1160-1162 | `.toFixed(0)` → `.toFixed(2)` |
| `freelancerplan-withpaymongo.html` | find updatePriceDisplay | `.toFixed(0)` → `.toFixed(2)` |
| `dedicatedcoaching-withpaymongo.html` | find updatePriceDisplay | `.toFixed(0)` → `.toFixed(2)` |
| `startupvacoursepayment-paymongo.html` | find updatePriceDisplay | `.toFixed(0)` → `.toFixed(2)` |
| `clientfindertool-withpaymongo.html` | ~1002-1004 | `.toFixed(0)` → `.toFixed(2)` |
| `ghlpracticeaccess-withpaymongo.html` | ~807-809 | `.toFixed(0)` → `.toFixed(2)` |
| `paymentController.js` | 75, 80, 92-95 | `Math.round()` → `Number(x.toFixed(2))` |
| `paymongoService.js` | 32, 42, 68, 250 | `Math.round()` → `Math.floor()` |
| `helpers.js` | 47-60 | Keep decimals, floor centavos |
