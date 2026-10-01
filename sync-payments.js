import pg from "pg";

const db = new pg.Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

async function syncPayments() {
  console.log("🔍 Scanning database for pending payments...");

  try {
    // Find all pending payments with virtual account references
    const res = await db.query(`
      SELECT p.id AS payment_id, p.virtual_account_reference AS tx_ref, 
             p.amount AS amount_paid, p.user_id, p.created_at, u.phone 
      FROM payments p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'pending' 
        AND p.virtual_account_reference IS NOT NULL
      ORDER BY p.created_at DESC
    `);

    if (res.rowCount === 0) {
      console.log("✅ No pending payments found in the database.");
      process.exit(0);
    }

    console.log(`Found ${res.rowCount} pending payments. Checking with Flutterwave...`);

    let confirmedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const botPort = process.env.PORT || 3004;

    for (const payment of res.rows) {
      const { payment_id, tx_ref, amount_paid, user_id, phone } = payment;
      console.log(`\n===========================================`);
      console.log(`🔄 Checking TX_REF: ${tx_ref} (User: ${phone})`);

      try {
        let isSuccessful = false;
        let confirmedAmount = Number(amount_paid);

        // 1. Verify with Flutterwave API (verify_by_reference first)
        try {
          const verifyRes = await fetch(
            `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(tx_ref)}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                "Content-Type": "application/json",
              },
            }
          );
          if (verifyRes.ok) {
            const verifyData = await verifyRes.json();
            if (verifyData.status === "success" && verifyData.data?.status === "successful") {
              isSuccessful = true;
              confirmedAmount = Number(verifyData.data.amount || amount_paid);
            }
          }
        } catch (vErr) {
          console.warn(`   ⚠️ verify_by_reference check returned:`, vErr.message);
        }

        // Fallback: Check /transactions list by tx_ref if verify_by_reference didn't confirm
        if (!isSuccessful) {
          try {
            const flwRes = await fetch(
              `https://api.flutterwave.com/v3/transactions?tx_ref=${encodeURIComponent(tx_ref)}`,
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                  "Content-Type": "application/json",
                },
              }
            );
            if (flwRes.ok) {
              const flwData = await flwRes.json();
              if (flwData.status === "success" && Array.isArray(flwData.data) && flwData.data.length > 0) {
                const successfulTx = flwData.data.find(tx => tx.status === "successful");
                if (successfulTx) {
                  isSuccessful = true;
                  confirmedAmount = Number(successfulTx.amount || amount_paid);
                }
              }
            }
          } catch (fErr) {
            console.warn(`   ⚠️ list transactions check returned:`, fErr.message);
          }
        }

        if (!isSuccessful) {
          console.log(`   ⏳ Transaction is still pending or failed on Flutterwave. Skipping.`);
          skippedCount++;
          continue;
        }

        console.log(`   💰 Payment CONFIRMED by Flutterwave! (Amount: ₦${confirmedAmount})`);

        // 2. Check if an Admin has already activated this user manually
        // (Prevent duplicate fulfillment if an admin logged a cash activation after this payment request)
        const manualCheck = await db.query(`
          SELECT id FROM payments 
          WHERE user_id = $1 
            AND status = 'completed' 
            AND method = 'cash' 
            AND created_at > $2
          LIMIT 1
        `, [user_id, payment.created_at]);

        if (manualCheck.rowCount > 0) {
          console.log(`   ⚠️ Admin has already activated this user manually! Marking DB record as completed to prevent double-billing.`);
          await db.query(`UPDATE payments SET status = 'completed' WHERE id = $1`, [payment_id]);
          confirmedCount++;
          continue;
        }

        console.log(`   🚀 User was NOT manually activated. Triggering Webhook automatically via port ${botPort}...`);

        // 3. Trigger the webhook manually to provision them on MikroTik & WhatsApp/Telegram
        const payload = {
          "event.type": "BANK_TRANSFER_TRANSACTION",
          status: "successful",
          txRef: tx_ref,
          amount: confirmedAmount,
          data: {
            status: "successful",
            tx_ref: tx_ref,
            amount: confirmedAmount
          }
        };

        const webhookRes = await fetch(`http://localhost:${botPort}/webhook/flutterwave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'verif-hash': process.env.FLW_SECRET_HASH
          },
          body: JSON.stringify(payload)
        });

        if (webhookRes.ok) {
          console.log(`   ✅ Successfully triggered Webhook! Bot should be messaging them now.`);
          confirmedCount++;
        } else {
          console.error(`   ❌ Failed to trigger Webhook (Status: ${webhookRes.status}). Is the bot running?`);
          failedCount++;
        }

      } catch (err) {
        console.error(`   ❌ Error verifying transaction: ${err.message}`);
        failedCount++;
      }
    }

    console.log(`\n🎉 Sync Complete! Confirmed/Processed: ${confirmedCount}, Still Pending: ${skippedCount}, Errors: ${failedCount}`);
    process.exit(0);

  } catch (error) {
    console.error("❌ Database query failed:", error.message);
    process.exit(1);
  }
}

syncPayments();