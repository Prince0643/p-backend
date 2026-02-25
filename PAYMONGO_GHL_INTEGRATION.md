# PayMongo to GoHighLevel (GHL) Integration

## Overview

This integration connects PayMongo payment webhooks to GoHighLevel (GHL), automatically creating contacts, invoices, and recording payments in GHL when a successful PayMongo payment is received. The result is that PayMongo payments appear in **GHL → Payments → Transactions**.

## How It Works

When a customer completes a payment via PayMongo:

```
PayMongo Payment
       ↓
Webhook fired (payment.paid)
       ↓
GHL Contact Created/Updated
       ↓
GHL Invoice Created
       ↓
Payment Recorded on Invoice
       ↓
Transaction appears in GHL Payments → Transactions
```

## Flow Details

### 1. PayMongo Webhook Reception

**Endpoint:** `POST /api/payments/webhook`

The webhook handler receives PayMongo's `payment.paid` event and extracts:
- Payment ID
- Amount (in centavos, converted to whole currency units)
- Currency
- Payment source (card brand, last 4 digits)
- Metadata (customer name, email, phone, product)

### 2. Contact Upsert

**GHL API:** `POST /contacts/upsert`

- Creates or updates a contact in GHL using the customer email
- Phone number is normalized to E.164 format (e.g., `+639171234567`)
- Returns the GHL contact ID needed for invoice creation

### 3. Invoice Creation

**GHL API:** `POST /invoices/`

Creates an invoice with:
- `altId`: GHL Location ID
- `altType`: "location"
- `businessDetails`: Minimal business name (required by GHL)
- `contactDetails`: Contact ID + customer info
- `items`: Product name as invoice line item
- `amount`: Converted from centavos
- `currency`: PHP (or from payment)
- `issueDate` / `dueDate`: Current date

### 4. Payment Recording

**GHL API:** `POST /invoices/{invoiceId}/record-payment`

This is the critical step that creates the transaction in GHL:

```json
{
  "altId": "your_location_id",
  "altType": "location",
  "mode": "card",
  "card": {
    "brand": "visa",
    "last4": "4242"
  },
  "notes": "PayMongo payment pay_test_123",
  "amount": 150000,
  "fulfilledAt": "2025-02-18T12:00:00.000Z"
}
```

**Note:** GHL does not have a direct "create transaction" API. Transactions are created automatically when you record a payment on an invoice.

### 5. Transaction Appears in GHL

After `record-payment` succeeds, the transaction appears in:
**GHL → Payments → Transactions**

## Environment Variables

```env
# PayMongo
PAYMONGO_PUBLIC_KEY=pk_test_...
PAYMONGO_SECRET_KEY=sk_test_...

# GoHighLevel
GHL_PRIVATE_KEY=your_ghl_private_integration_token
GHL_LOCATION_ID=nb61f4OQ7o9Wsxx0zOsY
GHL_BUSINESS_NAME=Your Business Name

# Other
LEADCONNECTOR_WEBHOOK=your_leadconnector_webhook_url (optional)
TAX_RATE=0.10
```

## File Structure

```
controllers/
  paymentController.js    # Webhook handler + GHL integration logic
services/
  ghlService.js           # GHL API client (contact, invoice, payment)
  paymongoService.js      # PayMongo API client
  webhookService.js       # LeadConnector webhook
.env                      # Environment variables
```

## Key Code Sections

### Webhook Handler (`controllers/paymentController.js`)

```javascript
exports.handleWebhook = async (req, res) => {
    const event = req.body;
    const eventType = event.data?.attributes?.type || event.data?.type;
    
    switch (eventType) {
        case 'payment.paid':
            await handlePaymentSuccess(event.data.attributes);
            break;
        // ... other cases
    }
};
```

### Payment Success Handler

```javascript
async function handlePaymentSuccess(attributes) {
    // 1. Upsert contact
    const upsertResult = await ghlService.upsertContact({ fullName, email, phone });
    const contactId = upsertResult?.contact?.id;
    
    // 2. Create invoice
    const invoice = await ghlService.createInvoice({ contactId, items, ... });
    
    // 3. Record payment (creates transaction)
    const invoiceId = invoice?.invoice?._id;
    await ghlService.recordInvoicePayment({ 
        invoiceId, 
        amount, 
        cardBrand, 
        cardLast4 
    });
}
```

## Testing

### Using Postman

**POST** `http://localhost:3000/api/payments/webhook`

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "data": {
    "id": "evt_test_123",
    "type": "event",
    "attributes": {
      "type": "payment.paid",
      "data": {
        "id": "pay_test_123",
        "type": "payment",
        "attributes": {
          "amount": 150000,
          "currency": "PHP",
          "status": "paid",
          "source": {
            "brand": "visa",
            "last4": "4242"
          },
          "metadata": {
            "fullName": "Test User",
            "email": "testuser@example.com",
            "mobile": "+639171234567",
            "product": "GHL Practice Access",
            "paymentReference": "PAYTEST123"
          }
        }
      }
    }
  }
}
```

### Expected Console Output

```
Webhook received: payment.paid
GHL invoice created: XXeEoz7zqbETxQUFXNxc
GHL payment recorded, transaction created: OK
```

### Verify in GHL

1. Check **Contacts** — customer should appear
2. Check **Payments → Invoices** — invoice should be marked as Paid
3. Check **Payments → Transactions** — transaction should appear with card details

## Important Notes

1. **Phone Format**: GHL requires E.164 format (e.g., `+639171234567`). The code normalizes Philippine numbers automatically.

2. **Invoice Required**: You cannot create a transaction directly in GHL. The flow must be: `Contact → Invoice → Record Payment → Transaction`.

3. **Business Details**: GHL requires minimal `businessDetails` on invoices (just a name field).

4. **Amount Format**: PayMongo sends amounts in centavos (150000 = ₱1,500.00). The code converts this to whole units for GHL.

5. **Error Handling**: All GHL errors are logged but do not fail the webhook response (PayMongo requires 200 OK).

6. **Non-blocking**: If GHL calls fail, the webhook still returns 200 to prevent PayMongo retries.

## Troubleshooting

### "Unhandled event type: event"
- The webhook handler checks `event.data.attributes.type`, not `event.data.type`
- Ensure your test payload has `data.attributes.type: "payment.paid"`

### 422 Errors on Invoice Creation
- Missing `businessDetails` — verify `GHL_BUSINESS_NAME` env var is set
- Invalid phone format — check phone normalization is working

### No Transaction in GHL
- Verify `recordInvoicePayment` is called after invoice creation
- Check console logs for "GHL payment recorded" message
- Ensure invoice ID is extracted correctly from response
